// relay/index.ts
//
// Daemon-side relay surface: the reachability controller and the WebAuthn
// step-up policy hook. Node-only (reached via the `@pellux/goodvibes-sdk/daemon`
// entry), never the browser index.
//
// Deliberately NO certificate machinery lives here: the daemon never mints
// certificates (no self-provisioned CA, ever — owner ruling). The recommended
// https path is tailscale serve, which terminates TLS with tailscale's own
// certificates (see platform/remote-access/tailscale.ts).

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
  StepUpService,
  parseAssertionHeader,
  encodeAssertionHeader,
  type StepUpSecretStore,
  type StepUpServiceOptions,
  type UserVerificationRequirement,
  type RegisterStepUpCredentialInput,
  type StepUpCredentialSummary,
  type MintStepUpChallengeInput,
  type MintedStepUpChallenge,
  type StepUpChallengeFailure,
} from './step-up-service.js';
