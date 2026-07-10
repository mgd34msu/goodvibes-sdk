// relay/step-up-policy.ts
//
// A policy hook for requiring a recent WebAuthn (passkey) step-up assertion on
// MUTATING operator calls that arrive over the relay. Reaching the daemon from
// outside the LAN is a higher-risk path than a call on the trusted LAN, so an
// operator can require that state-changing calls carry fresh proof of presence.
//
// This module ships the POLICY and the verb-metadata signal (mutating vs read).
// It deliberately does NOT implement WebAuthn assertion verification: a real
// verification needs a consumer-side ceremony (a credential store, a challenge
// issued and checked per call). That is an honest deferral — the verifier is an
// injected dependency, and when the policy requires step-up but no verifier is
// wired, the decision FAILS CLOSED (deny) rather than silently allowing or
// faking a pass. Nothing here ever reports an unverified assertion as verified.

/** Header carrying an opaque WebAuthn step-up assertion on a tunneled request. */
export const STEP_UP_ASSERTION_HEADER = 'x-goodvibes-stepup-assertion';

/**
 * Verifies a step-up assertion. Returns true only on genuine verification.
 * Consumers wire a real WebAuthn verifier here; until then the policy fails
 * closed. `context` carries the request essentials a verifier binds against.
 */
export type StepUpAssertionVerifier = (
  assertion: string,
  context: { readonly method: string; readonly path: string },
) => Promise<boolean>;

/** The outcome of a step-up policy evaluation. */
export type StepUpDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: 'step-up-required' | 'step-up-verifier-unavailable'; readonly message: string };

/** Inputs to a step-up evaluation — all already-resolved facts, so this is pure. */
export interface StepUpEvaluationInput {
  /** Did the request arrive over the relay (vs the trusted LAN)? */
  readonly viaRelay: boolean;
  /** Is the call state-changing (mutating verb)? */
  readonly mutating: boolean;
  /** Is the step-up requirement switched on? */
  readonly requireStepUp: boolean;
  /**
   * Verification result: true = genuinely verified, false = present-but-invalid
   * or absent, null = no verifier available (fail closed).
   */
  readonly assertionVerified: boolean | null;
}

/** HTTP methods that do not change state. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether an HTTP method is mutating. This mirrors the operator catalog, where
 * read-only methods carry `read:<domain>` scope and a GET binding while mutating
 * methods carry `write:<domain>` and a POST/PUT/PATCH/DELETE binding.
 */
export function isMutatingMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

/**
 * Decide whether a request may proceed. The control only bites on mutating
 * relay calls when the requirement is enabled; every other request is allowed
 * unchanged. When it does bite, it fails closed unless a verifier genuinely
 * confirmed a fresh assertion.
 */
export function evaluateStepUp(input: StepUpEvaluationInput): StepUpDecision {
  if (!input.viaRelay || !input.mutating || !input.requireStepUp) {
    return { allow: true };
  }
  if (input.assertionVerified === true) {
    return { allow: true };
  }
  if (input.assertionVerified === null) {
    return {
      allow: false,
      code: 'step-up-verifier-unavailable',
      message:
        'Step-up is required for mutating relay calls but no WebAuthn verifier is configured. '
        + 'Wire a StepUpAssertionVerifier to enable this control (failing closed until then).',
    };
  }
  return {
    allow: false,
    code: 'step-up-required',
    message: 'This mutating call arrived over the relay and requires a recent WebAuthn step-up assertion.',
  };
}
