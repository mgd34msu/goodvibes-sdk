export * from '@pellux/goodvibes-daemon-sdk';

// One-call daemon boot factory (thin composition over DaemonServer). Exposed on
// the public `@pellux/goodvibes-sdk/daemon` entry so embedders and tests can
// stand up a real daemon without hand-mirroring the construction graph.
export { bootDaemon, DaemonServer } from './platform/daemon/index.js';
export type { BootDaemonOptions, BootedDaemon } from './platform/daemon/index.js';

// Daemon-side relay surface: reachability control and the WebAuthn step-up
// policy hook + ceremony service (RuntimeServices.stepUpService —
// DaemonServer.start() calls its createVerifier() unconditionally, so a
// consumer composing its own RuntimeServices-compatible object needs the
// class, not a deep import). No certificate machinery: the daemon never mints
// certificates (no self-provisioned CA, ever); the recommended https path is
// tailscale serve (platform/remote-access/tailscale.ts).
export {
  createRelayReachability,
  isRelayReachabilityEnabled,
  buildDaemonRelayReachability,
  STEP_UP_ASSERTION_HEADER,
  evaluateStepUp,
  isMutatingMethod,
  StepUpService,
  parseAssertionHeader,
  encodeAssertionHeader,
  type RelayReachability,
  type RelayReachabilityOptions,
  type RelayReachabilityConfig,
  type RelayIdentityStore,
  type StepUpDecision,
  type StepUpEvaluationInput,
  type StepUpAssertionVerifier,
  type StepUpSecretStore,
  type StepUpServiceOptions,
  type UserVerificationRequirement,
  type RegisterStepUpCredentialInput,
  type StepUpCredentialSummary,
  type MintStepUpChallengeInput,
  type MintedStepUpChallenge,
  type StepUpChallengeFailure,
} from './platform/relay/index.js';
