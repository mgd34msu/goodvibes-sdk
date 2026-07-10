/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * The single derivation of context-window usage from a token count and a
 * window size, so the in-process read model (ui-read-models-core.ts) and the
 * operator-wire verb (control-plane/routes/session-runtime.ts) can never drift
 * on how a percentage / remaining figure is computed.
 *
 * HONESTY: `usedTokens` is an ESTIMATE (the token estimator's figure), not a
 * measured provider prompt-token count. Callers that surface these values must
 * label them as estimates — this helper only does the arithmetic.
 */
export interface ContextUsageDerived {
  /** Context usage as a 0–100 percentage (0 when the window is unknown). */
  readonly contextUsagePct: number;
  /** Tokens remaining before the window is full (0 when unknown/exhausted). */
  readonly contextRemainingTokens: number;
}

export function deriveContextUsage(usedTokens: number, window: number): ContextUsageDerived {
  return {
    contextUsagePct: window > 0 ? Math.min(100, Math.round((usedTokens / window) * 100)) : 0,
    contextRemainingTokens: window > 0 ? Math.max(0, window - usedTokens) : 0,
  };
}
