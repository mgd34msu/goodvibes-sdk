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
