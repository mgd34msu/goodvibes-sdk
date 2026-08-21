/**
 * occasions/, dated things that need an action, and dated ranges that do not.
 *
 * The daemon holds durable facts about the owner's life, his wife's birthday,
 * an anniversary, a friend's birthday, and raises them ON ITS OWN, before they
 * matter, without being asked. It remembers what he answered so it does not keep
 * asking, and not forever, because the occasions recur.
 *
 * See `docs/occasions.md` for the decision record.
 *
 * ## What this barrel exports, and what it deliberately does not
 *
 * Exported: the SHAPES a surface renders, and the pure helpers it may need to
 * render them, occasion and plan types, nudge payloads, interview steps, the
 * line grammar and the date arithmetic.
 *
 * Not exported: `OccasionsService`, `OccasionStateStore`, the sweep and the
 * capture flow. The daemon owns exactly one of each, and every operation a
 * surface needs is a catalogued `occasions.*` verb. Handing out the classes
 * would invite a second instance writing the same file, and a surface that
 * computed a nudge itself would be a second implementation of the rule that the
 * nudge never carries the date.
 *
 * The composition root reaches the service by deep import from inside the SDK,
 * the same way `owner-profile/consumers.js` is reached.
 */

export {
  MAX_NUDGE_RAISES,
  OCCASION_ACK_SOURCES,
  OCCASION_ANSWERS,
  OCCASION_KINDS,
  OCCASION_SUBJECTS,
  RAISE_BOUNDARIES,
  OCCASIONS_CONFIG_KEYS,
  OCCASIONS_SECTION,
  PLANS_SECTION,
  isOccasionAckSource,
  isOccasionAnswer,
  isOccasionKind,
  isRaiseBoundary,
  type GiftRecord,
  type Interview,
  type InterviewAnswer,
  type InterviewStep,
  type IsoDate,
  type NudgeSubject,
  type Occasion,
  type OccasionAckSource,
  type OccasionAcknowledgement,
  type OccasionAnswer,
  type OccasionConflict,
  type OccasionDate,
  type OccasionKind,
  type OccasionMirrorRecord,
  type OccasionNudge,
  type OccasionRecurrence,
  type OccasionStateDisclosure,
  type OccasionSubject,
  type OccasionSweepReport,
  type OpenItem,
  type OpenItemKind,
  type Plan,
  type RaiseBoundary,
  type UnparsedOccasionLine,
  type UnparsedPlanLine,
} from './types.js';

export {
  addDays,
  daysBetween,
  daysInMonth,
  isIsoDate,
  isLeapYear,
  minutesOfDayInZone,
  nextOccurrence,
  occurrenceInYear,
  parseOccasionDate,
  renderOccasionDate,
  toIsoDate,
  todayInZone,
} from './dates.js';

export {
  OCCASION_SEPARATOR,
  occasionIdFor,
  parseOccasionLine,
  parsePlanLine,
  renderOccasionLine,
  renderPlanLine,
  splitSegments,
  withoutListMarker,
  type OccasionLineResult,
  type PlanLineResult,
} from './grammar.js';

export {
  AGENT_NOTICE_HEADING,
  composeAgentNotice,
  composeConflictMessage,
  composeNudge,
  composeNudgeMessage,
  nameOf,
  proximityOf,
  subjectFor,
} from './nudge.js';

export {
  isSelfAttribution,
  ownerAliasSet,
  possessiveSubject,
  pushableSubject,
  resolveOccasionSubject,
  selfOccasionReason,
} from './subject.js';

export {
  acknowledgementReply,
  type AcknowledgeOutcome,
} from './acknowledge.js';

export {
  interestLine,
  interviewIdFor,
  isComplete,
  nextStep,
  type OpenInterviewInput,
} from './interview.js';

export {
  awayPlanOn,
  isAwayOn,
  nextAwayPlanFrom,
  readOccasions,
  readPlans,
  type OccasionProfileSource,
  type OccasionReadResult,
  type PlanReadResult,
} from './reader.js';

export {
  OCCASIONS_DEFAULTS,
  type OccasionsConfigAccess,
} from './policy.js';

export {
  effectiveLead,
  isWithinActiveHours,
  type DueOccasion,
  type OccasionsPolicy,
  type SweepHold,
} from './sweep.js';

export {
  NUDGE_AGENT_SURFACE,
  NUDGE_FORBIDDEN_SURFACES,
  nudgeDeliveryText,
  nudgeDestinationSurface,
  resolveNudgeDestinations,
  type NudgeDeliveryText,
} from './destinations.js';

export {
  boundaryOn,
  dayOfBoundaryDate,
  hasServed,
  isSpent,
  reconcileRaiseLedger,
} from './cadence.js';

export {
  type InterviewProgress,
  type NudgeDelivery,
  type OccasionListResult,
  type OccasionView,
  type PendingResult,
  type PlanListResult,
  type SweepOutcome,
} from './service.js';

export type {
  OccasionProposal,
  OccasionWriteOutcome,
} from './capture.js';
