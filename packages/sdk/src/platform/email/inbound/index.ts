/**
 * The inbound-mail watcher: IMAP IDLE with an adaptive poll fallback.
 *
 * Deliberately NOT re-exported from `platform/email/index.ts`. That barrel is
 * the mail-sending and mail-reading service surface; this is a long-lived
 * listener that holds a socket, and folding it in would mean every importer of
 * the email module pulled a supervisor's worth of machinery behind it. The
 * daemon wiring imports this path directly.
 *
 * Nothing exported here can start work. There is no `trySpawnAgent`, no
 * session broker and no reply queue in any argument of any function below —
 * an arriving message can cause a store write, a delivered notice and a status
 * change, and there is nothing else to call.
 */

export {
  BackoffSchedule,
  DEFAULT_BACKOFF_POLICY,
  backoffWindowMs,
  fullJitterDelayMs,
  type BackoffPolicy,
} from './backoff.js';

export {
  CapabilityStateTracker,
  capabilityVerdict,
  classifyLocalFailure,
  classifyOpenFailure,
  classifyReadFailure,
  errorText,
  resolveIdleSupport,
  stateForReason,
  verdictForOpenConnection,
  type OpenFailureVerdict,
} from './capability.js';

export {
  imapMailboxConnectionPort,
  type ImapMailboxConnectionOptions,
} from './connection.js';

export {
  isIdleWakeLine,
  runIdleLoop,
  runIdleRound,
  type IdleLoopDeps,
  type IdleLoopOutcome,
  type IdleLoopResult,
  type IdleRoundDeps,
  type IdleRoundOutcome,
  type IdleRoundResult,
  type IdleWakeSummary,
} from './idle-watcher.js';

export {
  drainMailboxDelta,
  runPollLoop,
  searchAboveCursor,
  type MailboxDeltaDeps,
  type MailboxDeltaOutcome,
  type MailboxDeltaReport,
  type PollLoopOutcome,
  type PollLoopResult,
} from './poll-loop.js';

export {
  DEFAULT_INBOUND_WATCHER_SETTINGS,
  IDLE_REISSUE_ADVISORY_BOUND_MS,
  resolveWatcherSettings,
  systemWatcherClock,
  type InboundCapabilityReason,
  type InboundCapabilityState,
  type InboundCapabilityTransition,
  type InboundCapabilityVerdict,
  type GmailInboundMessage,
  type ImapInboundMessage,
  type InboundMailNote,
  type InboundMailObserver,
  type InboundMailSink,
  type InboundMailTerminalFailure,
  type InboundMailboxMessage,
  type InboundMessageCommon,
  type InboundWatcherSettings,
  type MailboxConnection,
  type MailboxConnectionPort,
  type MailboxCursorKey,
  type MailboxCursorPort,
  type MailboxOpenReport,
  type MailboxReader,
  type MailboxWire,
  type MailboxWireReadOptions,
  type RandomSource,
  type WatcherClock,
} from './ports.js';

export {
  InboundMailboxWatcher,
  type InboundMailboxWatcherDeps,
  type InboundMailboxWatcherStatus,
} from './watcher.js';

export {
  MailboxCursorStore,
  validateMailboxCursor,
  type AccountConfiguredAnswer,
  type CursorSweepReport,
} from './cursor-store.js';
export {
  InboundMailStore,
  validateInboundMailRecord,
  type InboundMailMessageKey,
  type InboundNoticeStatus,
} from './record-store.js';
export {
  createInboundNoticeHealth,
  describeNoticeRefusal,
  type InboundNoticeHealth,
  type InboundNoticeHealthOptions,
  type InboundNoticeRefusalEvent,
  type InboundNoticeRefusalState,
} from './notice-health.js';
export { PersistedExpectationStore } from './expectation-store.js';
export {
  InboundMailHousekeeper,
  type InboundMailHousekeepingReport,
  type InboundMailSweepFailure,
} from './housekeeping.js';
export {
  createInboundTerminalFailureAnnouncer,
  type InboundNoticeDelivery,
  type InboundTerminalFailureAnnouncer,
  type InboundTerminalFailureAnnouncerOptions,
} from './terminal-notice.js';
export {
  InboundExpectationRegistry,
  ExpectationMailboxUnreadableError,
  type ExpectationCapabilityProbe,
  type ExpectationExpiryReason,
  type ExpectationExpiryReport,
  type ExpectationMatcher,
  type DisclosedExpectation,
  type InboundExpectationRegistryOptions,
} from './expectation-registry.js';
export {
  createInboundMailDedup,
  DedupingInboundMailSink,
  type InboundMailSourceId,
} from './sink.js';
export { describeSourceLatency, type InboundMailSource, type SourceLatency } from './source.js';
export {
  selectInboundMailSource,
  type InboundMailSourceKind,
  type InboundSourceSelection,
} from './source-selection.js';
export { ImapMailSource } from './imap-source.js';
export {
  createInboundMailSourceFactory,
  type GmailSourceBuilder,
  type InboundMailSourceFactoryDeps,
} from './source-factory.js';
export {
  createInboundMailIntake,
  InboundNoticeTransportError,
  type InboundMailIntakeDeps,
  type InboundMailNoticeRoute,
  type InboundNoticeMode,
  type NoticeRouteBinding,
  type NoticeRouteResolution,
} from './intake.js';
export {
  describeInboundMailHealth,
  type InboundMailHealthEntry,
  type InboundMailHealthInput,
} from './health.js';
export {
  InboundMailSupervisor,
  type InboundMailSourceFactory,
  type InboundMailStatusSnapshot,
  type InboundMailStoreHealth,
  type InboundMailSupervisorDeps,
  type InboundMailSupervisorStatus,
} from './supervisor.js';
export type { MailboxCursor } from './types.js';
