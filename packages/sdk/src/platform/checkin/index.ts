/**
 * checkin/ — the proactive check-in (the "heartbeat initiative").
 *
 * On a configured cadence the platform assembles a compact briefing of current
 * state and the model judges whether anything warrants contacting the user; if
 * so, the message is delivered through the channel delivery substrate. Off by
 * default; every run leaves a visible receipt. Rides the existing automation
 * scheduler as a kind:'checkin' job.
 */
export { CheckinService, type CheckinServiceDeps, type SetCheckinConfigInput } from './service.js';
export { CheckinReceiptStore } from './receipts.js';
export { assembleCheckinBriefing, summarizeCheckinState } from './briefing.js';
export { isQuietHours, parseQuietHours } from './quiet-hours.js';
export { createProviderBackedCheckinJudge, parseCheckinDecision } from './judge.js';
export {
  createRuntimeCheckinStateReader,
  type CheckinRuntimeReaders,
  type CheckinSessionView,
  type CheckinRunView,
} from './state-reader.js';
export {
  CHECKIN_CONFIG_KEYS,
  CHECKIN_JOB_ID,
  type CheckinConfig,
  type CheckinDecision,
  type CheckinDeliverer,
  type CheckinJudge,
  type CheckinReceipt,
  type CheckinReceiptOutcome,
  type CheckinStateReader,
  type CheckinStateSnapshot,
} from './types.js';
