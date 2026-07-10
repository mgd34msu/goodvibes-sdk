/**
 * checkin/service.ts
 *
 * The proactive check-in service: it reads the check-in config, gates on
 * enabled + quiet hours, assembles the briefing, asks the judge whether to
 * contact the user, delivers through the channel deliverer when the judgment
 * says yes, and writes a receipt for EVERY run — the loop that makes the
 * platform able to reach out first, accountably.
 *
 * It rides the existing automation scheduler: syncScheduledJob keeps a single
 * `kind: 'checkin'` automation job in step with the config, and attach() wires
 * the manager's check-in evaluator to this.evaluate — so when the scheduler
 * fires the job, this loop runs (checkin-execution.ts records the run).
 */
import type { AutomationManager } from '../automation/index.js';
import type { AutomationCheckinOutcome } from '../automation/index.js';
import { randomUUID } from 'node:crypto';
import { assembleCheckinBriefing, summarizeCheckinState } from './briefing.js';
import { isQuietHours } from './quiet-hours.js';
import type { CheckinReceiptStore } from './receipts.js';
import {
  CHECKIN_CONFIG_KEYS,
  CHECKIN_JOB_ID,
  type CheckinConfig,
  type CheckinDeliverer,
  type CheckinJudge,
  type CheckinReceipt,
  type CheckinReceiptOutcome,
  type CheckinStateReader,
} from './types.js';

const DEFAULT_CADENCE = '0 */4 * * *';

/**
 * The narrow config surface the check-in reads/writes. Intentionally string-
 * keyed rather than typed against the ConfigKey union: the checkin.* keys live
 * in the config DEFAULTS tree (schema-domain-runtime.ts) and flat settings, and
 * the daemon binds this via a small adapter over its ConfigManager — this keeps
 * the (grandfathered, shrink-only) schema-types.ts ConfigKey union untouched.
 */
export interface CheckinConfigAccess {
  get(key: string): unknown;
  set(key: string, value: string | boolean): void;
}

export interface CheckinServiceDeps {
  readonly config: CheckinConfigAccess;
  readonly stateReader: CheckinStateReader;
  readonly judge: CheckinJudge;
  readonly deliverer: CheckinDeliverer;
  readonly receipts: CheckinReceiptStore;
  /** The automation manager the scheduled check-in job is synced onto (optional in tests). */
  readonly automation?: Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'setEnabled' | 'attachCheckinEvaluator'> | undefined;
  /** Injectable clock for quiet-hours tests. */
  readonly now?: (() => number) | undefined;
}

export interface SetCheckinConfigInput {
  readonly enabled?: boolean | undefined;
  readonly cadence?: string | undefined;
  readonly deliveryChannel?: string | undefined;
  readonly quietHours?: string | undefined;
}

export class CheckinService {
  constructor(private readonly deps: CheckinServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  getConfig(): CheckinConfig {
    const get = this.deps.config.get.bind(this.deps.config);
    return {
      enabled: get(CHECKIN_CONFIG_KEYS.enabled) === true,
      cadence: asString(get(CHECKIN_CONFIG_KEYS.cadence)) || DEFAULT_CADENCE,
      deliveryChannel: asString(get(CHECKIN_CONFIG_KEYS.deliveryChannel)),
      quietHours: asString(get(CHECKIN_CONFIG_KEYS.quietHours)),
    };
  }

  async setConfig(input: SetCheckinConfigInput): Promise<CheckinConfig> {
    const set = this.deps.config.set.bind(this.deps.config);
    if (input.enabled !== undefined) set(CHECKIN_CONFIG_KEYS.enabled, input.enabled);
    if (input.cadence !== undefined) set(CHECKIN_CONFIG_KEYS.cadence, input.cadence.trim());
    if (input.deliveryChannel !== undefined) set(CHECKIN_CONFIG_KEYS.deliveryChannel, input.deliveryChannel.trim());
    if (input.quietHours !== undefined) set(CHECKIN_CONFIG_KEYS.quietHours, input.quietHours.trim());
    await this.syncScheduledJob();
    return this.getConfig();
  }

  async listReceipts(limit?: number): Promise<CheckinReceipt[]> {
    return this.deps.receipts.list(limit);
  }

  /** Wire this service as the automation manager's check-in evaluator, then sync the job. */
  async attach(): Promise<void> {
    this.deps.automation?.attachCheckinEvaluator((job) => this.evaluate('scheduled', job.id));
    await this.syncScheduledJob();
  }

  /**
   * Keep a single kind:'checkin' automation job in step with the config: create
   * it (enabled) when missing, update its cadence, and toggle enabled to match.
   * Best-effort — the automation subsystem must be enabled for a job to exist;
   * when it is off, createJob throws and we leave scheduling for when it is on.
   */
  async syncScheduledJob(): Promise<void> {
    const automation = this.deps.automation;
    if (!automation) return;
    const config = this.getConfig();
    let job: { id: string } | undefined;
    try {
      job = automation.listJobs().find((j) => j.kind === 'checkin');
    } catch {
      return;
    }
    try {
      if (!job) {
        if (!config.enabled) return;
        await automation.createJob({
          name: 'Proactive check-in',
          kind: 'checkin',
          prompt: '(proactive check-in — briefing assembled at run time)',
          schedule: { kind: 'cron', expression: config.cadence },
          target: { kind: 'isolated', createIfMissing: true },
          enabled: true,
        });
        return;
      }
      await automation.updateJob(job.id, {
        kind: 'checkin',
        schedule: { kind: 'cron', expression: config.cadence },
        enabled: config.enabled,
      });
      await automation.setEnabled(job.id, config.enabled);
    } catch {
      // Automation disabled or transient failure — the schedule syncs on the
      // next setConfig/attach once the automation subsystem is enabled.
    }
  }

  /**
   * Run one check-in evaluation and record its receipt. Returns the terminal
   * outcome the automation run records (see checkin-execution.ts). `_jobId` is
   * accepted for the scheduled path but the loop does not depend on it.
   */
  async evaluate(trigger: 'scheduled' | 'manual', _jobId?: string): Promise<AutomationCheckinOutcome> {
    const ranAt = this.now();
    const config = this.getConfig();
    if (!config.enabled) {
      return this.record(trigger, ranAt, 'skipped-disabled', 'check-in disabled', {});
    }
    if (isQuietHours(ranAt, config.quietHours)) {
      return this.record(trigger, ranAt, 'skipped-quiet-hours', 'quiet hours', {});
    }

    let briefingSummary = 'unavailable';
    try {
      const snapshot = await this.deps.stateReader.snapshot();
      briefingSummary = summarizeCheckinState(snapshot);
      const decision = await this.deps.judge.decide(assembleCheckinBriefing(snapshot));
      if (!decision.contact) {
        return this.record(trigger, ranAt, 'quiet', briefingSummary, { decisionReason: decision.reason });
      }
      const message = decision.message ?? '';
      const deliveryId = await this.deps.deliverer.deliver(config.deliveryChannel, message);
      return this.record(trigger, ranAt, 'delivered', briefingSummary, {
        decisionReason: decision.reason,
        deliveredMessage: message,
        deliveryChannel: config.deliveryChannel,
        deliveryId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.record(trigger, ranAt, 'error', briefingSummary, { error: detail });
    }
  }

  private async record(
    trigger: 'scheduled' | 'manual',
    ranAt: number,
    outcome: CheckinReceiptOutcome,
    briefingSummary: string,
    extra: {
      readonly decisionReason?: string | undefined;
      readonly deliveredMessage?: string | undefined;
      readonly deliveryChannel?: string | undefined;
      readonly deliveryId?: string | undefined;
      readonly error?: string | undefined;
    },
  ): Promise<AutomationCheckinOutcome> {
    const receipt: CheckinReceipt = {
      id: `checkin-${ranAt}-${randomUUID().slice(0, 6)}`,
      ranAt,
      trigger,
      outcome,
      briefingSummary,
      ...(extra.decisionReason ? { decisionReason: extra.decisionReason } : {}),
      ...(extra.deliveredMessage ? { deliveredMessage: extra.deliveredMessage } : {}),
      ...(extra.deliveryChannel ? { deliveryChannel: extra.deliveryChannel } : {}),
      ...(extra.deliveryId ? { deliveryId: extra.deliveryId } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    await this.deps.receipts.append(receipt);
    return toOutcome(outcome, receipt);
  }
}

function toOutcome(outcome: CheckinReceiptOutcome, receipt: CheckinReceipt): AutomationCheckinOutcome {
  switch (outcome) {
    case 'delivered':
      return { outcome: 'delivered', summary: `delivered: ${receipt.decisionReason ?? 'contacted user'}`, ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}) };
    case 'quiet':
      return { outcome: 'quiet', summary: `quiet: ${receipt.decisionReason ?? 'nothing warranted contact'}` };
    case 'error':
      return { outcome: 'error', summary: 'check-in evaluation failed', ...(receipt.error ? { error: receipt.error } : {}) };
    default:
      return { outcome: 'skipped', summary: outcome === 'skipped-quiet-hours' ? 'quiet hours' : 'check-in disabled' };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
