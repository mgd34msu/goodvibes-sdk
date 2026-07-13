/**
 * ci-watch/ — watch CI on a repo/PR with an honest, per-job verdict.
 *
 * The one-shot tool (CiWatchService.status) reports every job and its
 * conclusion; the verdict is derived from those per-job conclusions, never a
 * rollup, and continue-on-error jobs are surfaced as violations. Standing
 * watches are polled by the daemon (poller.ts), fire a channel notification on
 * their terminal verdict, raise a "fix this?" offer (or auto-start, when opted
 * in) on a red run, and retire once the verdict is delivered.
 */
export { CiWatchService, type CiWatchServiceDeps, type CreateCiWatchInput, type CiWatchCheckResult } from './service.js';
export {
  registerCiWatchPolling,
  runCiWatchPollPass,
  CI_WATCH_POLLER_ID,
  DEFAULT_CI_POLL_INTERVAL_MS,
  MIN_CI_POLL_INTERVAL_MS,
  type CiPollingHost,
  type CiWatchPollTarget,
} from './poller.js';
export { CiWatchStore } from './subscriptions.js';
export { createGhCliCiSource, type GhCliCiSourceOptions } from './gh-source.js';
export { deriveCiReport, deriveOverall, failingJobNames, renderCiReportLines } from './report.js';
export {
  CiWatchError,
  FAILING_CONCLUSIONS,
  PASSING_CONCLUSIONS,
  type CiJob,
  type CiOverall,
  type CiReport,
  type CiStatusSource,
  type CiWatchSubscription,
  type CiNotifier,
  type FixSessionBrief,
  type FixSessionOffer,
  type FixSessionStarter,
} from './types.js';
