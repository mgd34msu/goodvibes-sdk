/**
 * checkin/types.ts
 *
 * The proactive check-in (the "heartbeat initiative"): on a configured cadence
 * the platform assembles a compact briefing of current state and the model
 * exercises judgment about whether anything warrants contacting the user. It is
 * OFF by default and every run leaves a visible receipt (ran-quiet / delivered /
 * skipped), so the automatic behavior is always accountable.
 *
 * Named `checkin` rather than "heartbeat" deliberately: the automation subsystem
 * already owns `automation.heartbeat.*` (the scheduler's wake-tick queue), a
 * different mechanism. This is the proactive check-in that rides that scheduler
 * as a `kind: 'checkin'` job.
 */

/** The check-in configuration, read from the checkin.* config keys. */
export interface CheckinConfig {
  /** Off by default. When false, the scheduled check-in job is not created and evaluate() no-ops. */
  readonly enabled: boolean;
  /** The cadence as a cron expression (a standard 5-field cron, e.g. every 4 hours). */
  readonly cadence: string;
  /** Where a check-in message is delivered: 'surfaceKind' or 'surfaceKind:address' (e.g. 'slack:C123'). */
  readonly deliveryChannel: string;
  /** Quiet hours as 'HH:MM-HH:MM' (local time); empty string disables quiet hours. During quiet hours a run is skipped with a receipt. */
  readonly quietHours: string;
}

/** A compact, structured snapshot of current state the briefing is built from. */
export interface CheckinStateSnapshot {
  readonly runningSessions: number;
  readonly blockedSessions: number;
  readonly unreadChannelItems: number;
  readonly recentCompletions: number;
  /** Short human lines describing anything that may need attention. */
  readonly needsAttention: readonly string[];
}

/** The model's judgment: whether to contact the user, and (if so) with what message. */
export interface CheckinDecision {
  readonly contact: boolean;
  readonly reason: string;
  readonly message?: string | undefined;
}

/** The outcome recorded on every check-in run receipt. */
export type CheckinReceiptOutcome =
  | 'delivered'
  | 'quiet'
  | 'skipped-disabled'
  | 'skipped-quiet-hours'
  | 'error';

/** The visible receipt every check-in run leaves — ran / decided-quiet / delivered-what. */
export interface CheckinReceipt {
  readonly id: string;
  readonly ranAt: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly outcome: CheckinReceiptOutcome;
  readonly briefingSummary: string;
  readonly decisionReason?: string | undefined;
  readonly deliveredMessage?: string | undefined;
  readonly deliveryChannel?: string | undefined;
  readonly deliveryId?: string | undefined;
  readonly error?: string | undefined;
}

/** The narrow state reader the check-in depends on (the daemon binds it to the live services). */
export interface CheckinStateReader {
  snapshot(): Promise<CheckinStateSnapshot>;
}

/** The judgment seam: given a briefing, decide whether to contact the user. */
export interface CheckinJudge {
  decide(briefing: string): Promise<CheckinDecision>;
}

/** The delivery seam: put a check-in message on a channel, returning a delivery id when known. */
export interface CheckinDeliverer {
  deliver(channel: string, message: string): Promise<string | undefined>;
}

export const CHECKIN_CONFIG_KEYS = {
  enabled: 'checkin.enabled',
  cadence: 'checkin.cadence',
  deliveryChannel: 'checkin.deliveryChannel',
  quietHours: 'checkin.quietHours',
} as const;

/** The durable automation job id the check-in schedule is synced to. */
export const CHECKIN_JOB_ID = 'checkin-scheduled';
