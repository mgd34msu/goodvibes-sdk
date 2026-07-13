/**
 * ci-watch/types.ts
 *
 * Watching CI on a repo/PR with an honest, per-job verdict. The load-bearing
 * doctrine, quoted from the recorded decision:
 *
 *   "never report CI green from the run rollup; check per-job conclusions;
 *    continue-on-error jobs banned (2026-07-07 webui incident)"
 *
 * So the report is built from the PER-JOB conclusions, never a single rollup
 * status, and any job marked continue-on-error is surfaced as a violation
 * rather than being allowed to mask a failure.
 */

/** A GitHub job's run state (`status`) and, once complete, its `conclusion`. */
export interface CiJob {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  /** null while not yet completed; otherwise the GitHub conclusion string. */
  readonly conclusion: string | null;
  /** True when the job is configured continue-on-error — banned, because it masks a failure. */
  readonly continueOnError?: boolean | undefined;
  readonly url?: string | undefined;
}

/** The overall verdict, DERIVED from the per-job conclusions (never a rollup). */
export type CiOverall = 'passed' | 'failed' | 'pending' | 'unknown';

/** The per-job CI report the tool returns. */
export interface CiReport {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly overall: CiOverall;
  readonly jobs: readonly CiJob[];
  /** Policy violations found while deriving the verdict (e.g. continue-on-error jobs). */
  readonly violations: readonly string[];
  readonly checkedAt: number;
}

/** A conclusion string that counts as a per-job failure. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

/** A conclusion string that counts as a per-job pass. */
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'skipped', 'neutral']);

/** A standing watch on a repo/PR. */
export interface CiWatchSubscription {
  readonly id: string;
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  /** Channel to notify on completion ('surfaceKind' or 'surfaceKind:address'). */
  readonly deliveryChannel: string;
  /** Opt-in: when jobs fail, start a fix-session pre-briefed with the failing jobs' logs. */
  readonly triggerFixSession: boolean;
  /** The last overall verdict seen, so a watch fires once on transition to a terminal state. */
  readonly lastOverall?: CiOverall | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The source that fetches CI state (a gh-CLI or REST implementation; a fake in tests). */
export interface CiStatusSource {
  fetchJobs(input: { readonly repo: string; readonly ref?: string | undefined; readonly prNumber?: number | undefined }): Promise<readonly CiJob[]>;
  /** Optional: fetch the failing jobs' logs to pre-brief a fix-session. */
  fetchFailureLogs?(input: {
    readonly repo: string;
    readonly ref?: string | undefined;
    readonly prNumber?: number | undefined;
    readonly jobNames: readonly string[];
  }): Promise<string>;
}

/** The brief handed to a fix-session starter when a watched CI run fails. */
export interface FixSessionBrief {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly failingJobs: readonly string[];
  readonly logs: string;
}

/**
 * The starter's outcome: the REAL spawned session's id (the id session
 * attach/resume resolves — never a scheduling handle like an automation job
 * id), or the honest failure. The legacy bare string/undefined forms remain
 * accepted and are normalized by the service.
 */
export type FixSessionStartOutcome =
  | { readonly sessionId: string }
  | { readonly error: string };

/** Starts a fix-session pre-briefed with the failing jobs' context. */
export type FixSessionStarter = (brief: FixSessionBrief) => Promise<FixSessionStartOutcome | string | undefined>;

/**
 * The offer's outcome. The object form carries the approval ask's callId so
 * the service can stamp the started session's id back onto the RESOLVED
 * approval record (broker seam) — giving the surface that accepted an
 * in-process handle to the session its acceptance spawned. The bare boolean
 * form remains valid for wirings without an approval record.
 */
export type FixSessionOfferOutcome =
  | boolean
  | { readonly accepted: boolean; readonly offerCallId?: string | undefined };

/**
 * The "fix this?" offer for a red run on a watch that did NOT opt into
 * auto-start: surfaced through the approval/attention machinery (wired at the
 * composition root to the approval broker). Resolves accepted=true when the
 * operator accepts — the service then starts the fix-session with the SAME
 * brief, and (given an offerCallId) stamps the started id onto the approval
 * record.
 */
export type FixSessionOffer = (brief: FixSessionBrief) => Promise<FixSessionOfferOutcome>;

/** Delivers a channel notification; returns a delivery id when known. */
export type CiNotifier = (channel: string, title: string, body: string) => Promise<string | undefined>;

export type CiWatchErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND';

export class CiWatchError extends Error {
  readonly code: CiWatchErrorCode;
  constructor(message: string, code: CiWatchErrorCode) {
    super(message);
    this.name = 'CiWatchError';
    this.code = code;
  }
}
