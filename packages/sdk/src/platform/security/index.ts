export { SpawnTokenManager } from './spawn-tokens.js';
export type { SpawnToken, OrchestrationPolicyConfig } from './spawn-tokens.js';
export { UserAuthManager } from './user-auth.js';
export type { AuthUser, AuthSession, LocalAuthSnapshot } from './user-auth.js';
export {
  OPERATOR_SESSION_COOKIE_NAME,
  authenticateOperatorRequest,
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
} from './http-auth.js';
export { ApiTokenAuditor } from './token-audit.js';
export type {
  ApiTokenMetadata,
  TokenScopePolicy,
  TokenScopeAuditResult,
  TokenRotationAuditResult,
  TokenAuditResult,
  TokenAuditReport,
  TokenAuditorConfig,
  ScopeAuditOutcome,
  RotationAuditOutcome,
} from './token-audit.js';
export { DEFAULT_ROTATION_CADENCE_MS, DEFAULT_ROTATION_WARNING_THRESHOLD_MS } from './token-audit.js';
export {
  UNTRUSTED_CONTENT_RULE,
  UntrustedContentLedger,
  createUntrustedContentPort,
  evaluateOutwardEffect,
  getProcessUntrustedContentLedger,
  grantOwnerApproval,
  labelUntrustedContent,
  originOf,
  resetProcessUntrustedContentLedgerForTests,
  surfaceHasCommandAuthority,
} from './untrusted-content.js';
export type {
  AuthoritySurface,
  OutwardEffectDecision,
  OutwardEffectRequest,
  OwnerApproval,
  OwnerRemedy,
  UntrustedContentEnvelope,
  UntrustedContentPortOptions,
  UntrustedExposure,
  UntrustedIngest,
  UntrustedSurface,
} from './untrusted-content.js';
export {
  OWNER_APPROVAL_TTL_MS,
  OwnerApprovalStore,
  checkOwnerApproval,
  fingerprintOutwardContent,
} from './owner-approval.js';
export type { ApprovalMismatch, ApprovalSurface } from './owner-approval.js';
export {
  describeExposures,
  describeUntrustedSource,
  describeWhoControls,
} from './untrusted-surface-language.js';
export {
  OWNER_DIRECT_INPUT_SOURCES,
  inputOriginIsOwnerDirect,
  startTurnForOwnerInput,
  startTurnForOwnerRequest,
} from './turn-boundary.js';
export {
  MIN_SHARED_CHARS,
  MIN_SHARED_WORDS,
  describeContentTaint,
  findContentTaint,
  stripQuotedRegions,
} from './content-taint.js';
export type { TaintFinding, TaintOptions, TaintSource } from './content-taint.js';
export {
  OWNER_ADDRESS_CONFIG_KEYS,
  isSendToOwnerOnly,
  normalizeOwnerAddress,
  resolveOwnerAddresses,
  splitRecipients,
} from './owner-identity.js';
export type { OwnerConfigReader } from './owner-identity.js';
