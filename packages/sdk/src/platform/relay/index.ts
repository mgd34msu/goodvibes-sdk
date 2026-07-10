// relay/index.ts
//
// Daemon-side relay surface: the reachability controller, the WebAuthn step-up
// policy hook, and the LAN certificate minter. Node-only (reached via the
// `@pellux/goodvibes-sdk/daemon` entry), never the browser index.

export {
  createRelayReachability,
  isRelayReachabilityEnabled,
  type RelayReachability,
  type RelayReachabilityOptions,
  type RelayReachabilityConfig,
  type RelayIdentityStore,
} from './reachability.js';

export { buildDaemonRelayReachability } from './daemon-wiring.js';

export {
  STEP_UP_ASSERTION_HEADER,
  evaluateStepUp,
  isMutatingMethod,
  type StepUpDecision,
  type StepUpEvaluationInput,
  type StepUpAssertionVerifier,
} from './step-up-policy.js';

export {
  mintLanCertificate,
  type MintLanCertificateOptions,
  type LanCertificateResult,
  type LanCertCommandRunner,
  type LanCertFs,
  type LanCertDeps,
} from './lan-cert.js';
