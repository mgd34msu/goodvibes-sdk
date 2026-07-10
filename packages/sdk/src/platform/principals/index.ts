/**
 * principals/ — the cross-channel principal identity registry.
 *
 * Maps channel-specific sender identities (a Slack user id, an email address, a
 * phone number) onto one named principal so attribution and session continuity
 * survive a channel hop. Used by channel intake for attribution; unmapped
 * senders resolve to an honest unknown principal rather than a guess.
 */
export {
  PrincipalRegistry,
  type CreatePrincipalInput,
  type UpdatePrincipalInput,
  type PrincipalResolution,
} from './registry.js';
export { PrincipalStore } from './store.js';
export {
  PrincipalRegistryError,
  UNKNOWN_PRINCIPAL_ID,
  PRINCIPAL_KINDS,
  unknownPrincipal,
  isUnknownPrincipal,
  normalizeIdentity,
  identityKey,
  type PrincipalKind,
  type PrincipalIdentity,
  type PrincipalRecord,
  type PrincipalRegistryErrorCode,
} from './types.js';
