/**
 * ci-watch/service.ts
 *
 * The CI-watch service: the one-shot per-job status tool, plus the standing
 * subscription mechanism. A standing watch, when checked, fires a channel
 * notification on transition to a terminal verdict and — only when the
 * subscription has OPTED IN — starts a fix-session pre-briefed with the failing
 * jobs' logs.
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
  type FixSessionStarter,
} from './types.js';

export interface CiWatchServiceDeps {
  readonly source: CiStatusSource;
  readonly store: CiWatchStore;
  /** Delivers the completion notification to the subscription's channel (optional in tests). */
  readonly notifier?: CiNotifier | undefined;
  /** Starts the opt-in fix-session; absent → the trigger is recorded but not started. */
  readonly fixSessionStarter?: FixSessionStarter | undefined;
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
  readonly fixSessionId?: string | undefined;
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

    if (terminal && changed) {
      if (this.deps.notifier) {
        notificationId = await this.deps.notifier(
          subscription.deliveryChannel,
          `CI ${report.overall} — ${report.repo}`,
          renderCiReportLines(report),
        );
        notified = true;
      }
      if (report.overall === 'failed' && subscription.triggerFixSession) {
        fixSessionTriggered = true;
        if (this.deps.fixSessionStarter) {
          const failing = failingJobNames(report);
          const logs = this.deps.source.fetchFailureLogs
            ? await this.deps.source.fetchFailureLogs({ repo: subscription.repo, ref: subscription.ref, prNumber: subscription.prNumber, jobNames: failing })
            : `Failing jobs: ${failing.join(', ')}`;
          fixSessionId = await this.deps.fixSessionStarter({
            repo: subscription.repo,
            ref: subscription.ref,
            prNumber: subscription.prNumber,
            failingJobs: failing,
            logs,
          });
        }
      }
    }

    subs[index] = { ...subscription, lastOverall: report.overall, updatedAt: this.now() };
    await this.deps.store.save(subs);

    return {
      report,
      notified,
      ...(notificationId ? { notificationId } : {}),
      fixSessionTriggered,
      ...(fixSessionId ? { fixSessionId } : {}),
    };
  }
}
