/**
 * Channel health, one rule for turning what a surface can be SEEN to be doing
 * into the state it reports.
 *
 * The rule lives here, alone, because the previous arrangement had each
 * surface's `getStatus` decide for itself and every one of them decided the
 * same wrong way: a resolved credential (or, for several surfaces, merely a
 * delivery switch left on) was reported as `healthy`. A Telegram bot whose
 * poll loop had stopped therefore reported healthy for as long as its token
 * stayed in config, which is the shape of failure that costs the most, the
 * owner's message goes nowhere and every surface says it is fine.
 *
 * Two properties this file exists to hold:
 *
 * 1. Configuration is never health. A credential proves a channel COULD work,
 *    which is what `configured` reports and nothing more.
 * 2. Where liveness cannot be observed, the answer is `unknown`. Inventing a
 *    green for a surface nobody watches is the defect, not a workaround for it.
 */
import type { ChannelHealthState, ChannelRuntimeObservation } from './types.js';

export interface ChannelHealthInput {
  /** The operator's switch for this surface. */
  readonly enabled: boolean;
  /** At least one credential for this surface is DECLARED in some backend. */
  readonly configured: boolean;
  /**
   * At least one declared credential RESOLVES to a value in the store this
   * process reads. Defaults to `configured` when a caller cannot tell them
   * apart, which preserves the old (weaker) reading rather than inventing a
   * failure, but every built-in surface supplies the real answer.
   */
  readonly credentialResolves?: boolean | undefined;
  /** What this node can see of the live path. */
  readonly runtime: ChannelRuntimeObservation;
}

/**
 * Resolve the reported state.
 *
 * Ordered deliberately:
 *
 * 1. An operator who switched a surface off is not owed a fault.
 * 2. A surface with nothing declared cannot be dead, it was never alive.
 * 3. An OBSERVED working path beats every inference below it. Direct evidence
 *    that messages are flowing outranks a guess drawn from credential shape.
 * 4. A declared credential that resolves to nothing is a definite, named
 *    failure. It ranks above `unknown` and above `dead` because it says WHICH
 *    thing to fix, and above `unconfigured` because the operator believes this
 *    surface is set up.
 * 5. Only then does the live observation decide, and an absent observation
 *    yields `unknown` rather than falling through to a default of healthy.
 */
export function resolveChannelHealthState(input: ChannelHealthInput): ChannelHealthState {
  if (!input.enabled) return 'disabled';
  if (!input.configured) return 'unconfigured';
  if (input.runtime.observable && input.runtime.running === true) {
    return input.runtime.lastError ? 'degraded' : 'healthy';
  }
  if (!(input.credentialResolves ?? input.configured)) return 'unresolved';
  if (!input.runtime.observable || input.runtime.running === null) return 'unknown';
  return 'dead';
}

/**
 * The observation for a surface whose liveness nothing here watches.
 *
 * Takes the reason as an argument rather than composing a generic one, so each
 * call site has to state WHY it cannot tell. "Configuration is all we know" is
 * a legitimate answer; leaving the reader to guess is not.
 */
export function unobservableRuntime(reason: string): ChannelRuntimeObservation {
  return { observable: false, running: null, reason };
}

/** An observed live path. */
export function observedRuntime(
  running: boolean,
  reason: string,
  lastError?: string | undefined,
): ChannelRuntimeObservation {
  return {
    observable: true,
    running,
    reason,
    ...(lastError ? { lastError } : {}),
    observedAt: Date.now(),
  };
}

/**
 * States in which the owner is NOT being served by this channel and would want
 * to know.
 *
 * `unresolved` counts: the operator switched the surface on and put a
 * credential reference in its config, so he believes it works, and it cannot
 * send a byte. `unconfigured` does not, nobody believes an unconfigured
 * surface is working. `unknown` does not either: it is not evidence of failure,
 * and treating it as one would make every webhook-delivered surface cry wolf on
 * every sweep.
 */
export function isChannelFailing(state: ChannelHealthState): boolean {
  return state === 'dead' || state === 'degraded' || state === 'unresolved';
}

/** True when the channel is confirmed to be carrying traffic. */
export function isChannelWorking(state: ChannelHealthState): boolean {
  return state === 'healthy';
}
