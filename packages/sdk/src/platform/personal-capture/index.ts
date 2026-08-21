/**
 * personal-capture, recording what the owner tells you about himself.
 *
 * Three pieces, deliberately separable:
 *  - `authority.ts` decides whether THIS turn may write to the profile.
 *  - `spawn-contract.ts` says what a conversational turn is given and told.
 *  - `port.ts` is the narrow store/service surface the capture tool calls.
 */
export {
  parseOwnerChannelList,
  resolveCaptureAuthority,
} from './authority.js';
export type {
  CaptureAuthorityDecision,
  CaptureAuthorityInput,
  CaptureAuthoritySource,
  CaptureChannelIdentity,
} from './authority.js';
export {
  CONVERSATIONAL_TURN_TOOLS,
  buildConversationalTurnContext,
  conversationalTurnSpawnOptions,
} from './spawn-contract.js';
export type {
  ConversationalSpawnContextInput,
  ConversationalTurnConfigReader,
  ConversationalTurnInputLike,
} from './spawn-contract.js';
export { PersonalCaptureHolder } from './port.js';
export type {
  CaptureOccasionsAccess,
  CaptureProfileAccess,
  PersonalCapturePort,
} from './port.js';
