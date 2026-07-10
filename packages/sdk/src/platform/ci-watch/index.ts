/**
 * ci-watch/ — watch CI on a repo/PR with an honest, per-job verdict.
 *
 * The one-shot tool (CiWatchService.status) reports every job and its
 * conclusion; the verdict is derived from those per-job conclusions, never a
 * rollup, and continue-on-error jobs are surfaced as violations. Standing
 * watches fire a channel notification on completion and, when opted in, start a
 * fix-session pre-briefed with the failing jobs' logs.
 */
export { CiWatchService, type CiWatchServiceDeps, type CreateCiWatchInput, type CiWatchCheckResult } from './service.js';
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
  type FixSessionStarter,
} from './types.js';
