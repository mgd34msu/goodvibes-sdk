/**
 * ci-watch/service.ts
 *
 * The CI-watch service: the one-shot per-job status tool, plus the standing
 * subscription mechanism. A standing watch, when checked, fires a channel
 * notification on transition to a terminal verdict; on a RED verdict it
 * either starts a fix-session directly (the triggerFixSession opt-in) or
 * raises a "fix this?" offer through the approval machinery whose acceptance
 * starts the session, pre-briefed with the failing jobs' logs. A watch whose
 * terminal verdict has been delivered retires itself — checks come from the
 * daemon poller (ci-watch/poller.ts) or the manual ci.watches.run verb.
 */
import { randomUUID } from 'node:crypto';
import { deriveCiReport, failingJobNames, renderCiReportLines } from './report.js';
import type { CiWatchStore } from './subscriptions.js';
import {
  CiWatchError,
  type CiNotifier,
  type CiReport,
  type CiStatusSource,
  type CiWatchSubscription,
  type FixSessionBrief,
  type FixSessionOffer,
  type FixSessionStartOutcome,
  type FixSessionStarter,
} from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface CiWatchServiceDeps {
  readonly source: CiStatusSource;
  readonly store: CiWatchStore;
  /** Delivers the completion notification to the subscription's channel (optional in tests). */
  readonly notifier?: CiNotifier | undefined;
  /** Starts the opt-in fix-session; absent → the trigger is recorded but not started. */
  readonly fixSessionStarter?: FixSessionStarter | undefined;
  /**
   * The "fix this?" offer for red runs on watches WITHOUT the auto-start
   * opt-in: acceptance starts the fix-session with the same brief. Absent →
   * red runs on non-opted-in watches only notify (today's behavior).
   */
  readonly fixSessionOffer?: FixSessionOffer | undefined;
  /**
   * Stamps the started fix-session's id onto the accepted offer's RESOLVED
   * approval record (broker seam) and publishes the update, so the surface
   * that accepted gets a live in-process handle. Absent → the id is still
   * delivered via the channel notification only.
   */
  readonly stampFixSession?: ((offerCallId: string, outcome: FixSessionStartOutcome) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CreateCiWatchInput {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly deliveryChannel: string;
  readonly triggerFixSession?: boolean | undefined;
}

export interface CiWatchCheckResult {
  readonly report: CiReport;
  readonly notified: boolean;
  readonly notificationId?: string | undefined;
  readonly fixSessionTriggered: boolean;
  /** The REAL spawned session's id (attach/resume-resolvable) — never a scheduling handle. */
  readonly fixSessionId?: string | undefined;
  /** The honest failure when the auto-start fix-session did not produce an attachable session. */
  readonly fixSessionError?: string | undefined;
  /** A "fix this?" offer was raised through the approval machinery (its acceptance runs async). */
  readonly fixSessionOffered?: boolean | undefined;
  /** The watch was retired: its terminal verdict was delivered, so its job is done. */
  readonly retired?: boolean | undefined;
}

/** Normalize the starter's legacy string/undefined forms into the honest outcome shape. */
function normalizeStartOutcome(result: FixSessionStartOutcome | string | undefined): FixSessionStartOutcome {
  if (result === undefined) return { error: 'the fix session failed to start' };
  return typeof result === 'string' ? { sessionId: result } : result;
}

export class CiWatchService {
  private subscriptions: CiWatchSubscription[] | null = null;

  constructor(private readonly deps: CiWatchServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async all(): Promise<CiWatchSubscription[]> {
    if (this.subscriptions === null) this.subscriptions = await this.deps.store.load();
    return this.subscriptions;
  }

  /** One-shot: the per-job CI status report for a repo/ref/PR. */
  async status(input: { repo: string; ref?: string; prNumber?: number }): Promise<CiReport> {
    const repo = input.repo?.trim();
    if (!repo) throw new CiWatchError('repo is required (owner/name)', 'INVALID_ARGUMENT');
    const jobs = await this.deps.source.fetchJobs({ repo, ref: input.ref, prNumber: input.prNumber });
    return deriveCiReport({ repo, ref: input.ref, prNumber: input.prNumber, jobs, now: this.now() });
  }

  async listWatches(): Promise<CiWatchSubscription[]> {
    return [...(await this.all())];
  }

  async createWatch(input: CreateCiWatchInput): Promise<CiWatchSubscription> {
    const repo = input.repo?.trim();
    if (!repo) throw new CiWatchError('repo is required (owner/name)', 'INVALID_ARGUMENT');
    if (input.ref === undefined && input.prNumber === undefined) {
      throw new CiWatchError('a ref or prNumber is required', 'INVALID_ARGUMENT');
    }
    const channel = input.deliveryChannel?.trim();
    if (!channel) throw new CiWatchError('deliveryChannel is required', 'INVALID_ARGUMENT');
    const now = this.now();
    const subscription: CiWatchSubscription = {
      id: `ciwatch-${randomUUID().slice(0, 10)}`,
      repo,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      deliveryChannel: channel,
      triggerFixSession: input.triggerFixSession === true,
      createdAt: now,
      updatedAt: now,
    };
    const subs = await this.all();
    subs.push(subscription);
    await this.deps.store.save(subs);
    return subscription;
  }

  async deleteWatch(id: string): Promise<boolean> {
    const subs = await this.all();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) return false;
    subs.splice(index, 1);
    await this.deps.store.save(subs);
    return true;
  }

  /**
   * Check one standing watch: poll its per-job status, and if the verdict has
   * transitioned to a terminal state (passed/failed) since last time, fire the
   * channel notification — and, when failed AND the subscription opted in, start
   * a fix-session pre-briefed with the failing jobs' logs.
   */
  async checkWatch(id: string): Promise<CiWatchCheckResult> {
    const subs = await this.all();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) throw new CiWatchError(`No CI watch with id ${id}`, 'NOT_FOUND');
    const subscription = subs[index]!;
    const report = await this.status({ repo: subscription.repo, ...(subscription.ref ? { ref: subscription.ref } : {}), ...(subscription.prNumber !== undefined ? { prNumber: subscription.prNumber } : {}) });

    const terminal = report.overall === 'passed' || report.overall === 'failed';
    const changed = report.overall !== subscription.lastOverall;
    let notified = false;
    let notificationId: string | undefined;
    let fixSessionTriggered = false;
    let fixSessionId: string | undefined;
    let fixSessionError: string | undefined;
    let fixSessionOffered = false;

    if (terminal && changed) {
      if (this.deps.notifier) {
        notificationId = await this.deps.notifier(
          subscription.deliveryChannel,
          `CI ${report.overall} — ${report.repo}`,
          renderCiReportLines(report),
        );
        notified = true;
      }
      if (report.overall === 'failed') {
        if (subscription.triggerFixSession) {
          // The auto-start opt-in: no offer, straight to the fix-session. The
          // started session's id rides the verb result AND a follow-up channel
          // notification so a surface can open/attach it.
          fixSessionTriggered = true;
          if (this.deps.fixSessionStarter) {
            const started = normalizeStartOutcome(await this.deps.fixSessionStarter(await this.composeFixBrief(subscription, report)));
            if ('sessionId' in started) {
              fixSessionId = started.sessionId;
              await this.notifyFixSessionStarted(subscription, report, started.sessionId);
            } else {
              // The honest failure rides the verb result — never a dead id.
              fixSessionError = started.error;
              logger.warn('[ci-watch] auto-start fix-session failed', { repo: subscription.repo, error: started.error });
            }
          }
        } else if (this.deps.fixSessionOffer && this.deps.fixSessionStarter) {
          // "Fix this?" — an actionable offer through the approval/attention
          // machinery. Fire-and-forget: a human decision must never block the
          // poll loop or the manual verb; acceptance starts the seeded session,
          // and the started id is delivered via the channel notification (the
          // verb result has already returned by then).
          fixSessionOffered = true;
          const brief = await this.composeFixBrief(subscription, report);
          const offer = this.deps.fixSessionOffer;
          const starter = this.deps.fixSessionStarter;
          void (async () => {
            try {
              const outcome = await offer(brief);
              const accepted = typeof outcome === 'boolean' ? outcome : outcome.accepted;
              const offerCallId = typeof outcome === 'boolean' ? undefined : outcome.offerCallId;
              if (!accepted) return;
              const started = normalizeStartOutcome(await starter(brief));
              // The accepting surface is attached NOW: stamp the outcome onto
              // the resolved approval record (published live through the
              // broker) so it has an in-process handle to open the session —
              // or the honest failure, never a dead id. The channel
              // notification below stays for paired channels.
              if (offerCallId && this.deps.stampFixSession) {
                await this.deps.stampFixSession(offerCallId, started);
              }
              if ('sessionId' in started) {
                await this.notifyFixSessionStarted(subscription, report, started.sessionId);
              } else {
                logger.warn('[ci-watch] accepted fix-session failed to start', { repo: subscription.repo, error: started.error });
              }
            } catch (error) {
              logger.warn('[ci-watch] fix-session offer did not complete', {
                repo: subscription.repo, error: summarizeError(error),
              });
            }
          })();
        }
      }
    }

    // Retirement: a watch exists to deliver ONE terminal verdict. Once that
    // verdict has been delivered (notified), its job is done and it is
    // removed. Without a notifier the verdict was NOT delivered, so the watch
    // stays (honest fire-once semantics survive missing wiring).
    const retired = terminal && changed && notified;
    if (retired) {
      subs.splice(index, 1);
    } else {
      subs[index] = { ...subscription, lastOverall: report.overall, updatedAt: this.now() };
    }
    await this.deps.store.save(subs);

    return {
      report,
      notified,
      ...(notificationId ? { notificationId } : {}),
      fixSessionTriggered,
      ...(fixSessionId ? { fixSessionId } : {}),
      ...(fixSessionError ? { fixSessionError } : {}),
      ...(fixSessionOffered ? { fixSessionOffered } : {}),
      ...(retired ? { retired } : {}),
    };
  }

  /**
   * Deliver the started fix-session's id to the watch's channel so a surface
   * can open/attach the session. The id is the payload's machine-readable
   * tail line (sessionId: <id>), mirroring how surfaces parse other
   * structured notification lines. Failure to notify never fails the start.
   */
  private async notifyFixSessionStarted(subscription: CiWatchSubscription, report: CiReport, sessionId: string): Promise<void> {
    if (!this.deps.notifier) return;
    try {
      await this.deps.notifier(
        subscription.deliveryChannel,
        `CI fix session started — ${report.repo}`,
        [
          `A fix session is working on the failing jobs (${failingJobNames(report).join(', ') || 'unknown'}).`,
          `sessionId: ${sessionId}`,
        ].join('\n'),
      );
    } catch (error) {
      logger.warn('[ci-watch] fix-session start notification failed', {
        repo: subscription.repo, sessionId, error: summarizeError(error),
      });
    }
  }

  /** The failing-jobs brief (names + logs) shared by the auto-start and offer paths. */
  private async composeFixBrief(subscription: CiWatchSubscription, report: CiReport): Promise<FixSessionBrief> {
    const failing = failingJobNames(report);
    const logs = this.deps.source.fetchFailureLogs
      ? await this.deps.source.fetchFailureLogs({ repo: subscription.repo, ref: subscription.ref, prNumber: subscription.prNumber, jobNames: failing })
      : `Failing jobs: ${failing.join(', ')}`;
    return {
      repo: subscription.repo,
      ref: subscription.ref,
      prNumber: subscription.prNumber,
      failingJobs: failing,
      logs,
    };
  }
}
