/**
 * keyless-default.ts — the single honest source for "does the default model
 * work without an API key?".
 *
 * PROBLEM. The shipped default model (`provider.model`, e.g.
 * `openrouter:openrouter/free`) was promised as keyless by onboarding copy
 * written by hand, while its provider was registered auth-required — a fresh
 * install's first prompt ended in a dead-end 401. The promise and the
 * registration state had no structural connection.
 *
 * FIX. Readiness is DERIVED from the same registration state that decides
 * `isConfigured()` (see {@link ProviderAuthState}); onboarding copy is
 * GENERATED from that readiness, and the only branch that can ever produce a
 * "no API key needed" promise is the branch proven keyless by the provider's
 * own auth state — a false promise is structurally unwritable. Consumers that
 * still hardcode a keyless claim gate it with
 * {@link assertKeylessDefaultPairing}, which fails loudly when the claimed
 * pairing points at an auth-required provider.
 *
 * The runtime half of the guarantee lives in the compat providers themselves:
 * an unconfigured provider's chat() refuses the request before the wire with
 * copy naming the key it needs, so even a stale surface cannot reach the 401.
 */
import type { LLMProvider, ProviderAuthState } from './interface.js';

/** The honest keyless readiness of a model's provider, derived — never asserted. */
export type DefaultModelReadiness =
  | {
      /** The provider genuinely works right now without a stored credential. */
      readonly kind: 'keyless';
      readonly modelKey: string;
      readonly provider: string;
    }
  | {
      /** A credential is present; the model works, but it is not keyless. */
      readonly kind: 'configured';
      readonly modelKey: string;
      readonly provider: string;
    }
  | {
      /** Auth-required and unconfigured — the first prompt must ask for a key. */
      readonly kind: 'needs-key';
      readonly modelKey: string;
      readonly provider: string;
      readonly authEnvVars: readonly string[];
    }
  | {
      /** The model key does not resolve to a registered provider at all. */
      readonly kind: 'unresolvable';
      readonly modelKey: string;
      readonly detail: string;
    };

/** The slice of ProviderRegistry this module needs. */
export interface ModelProviderSource {
  getForModel(modelId: string, provider?: string): LLMProvider;
}

function authStateOf(provider: LLMProvider): ProviderAuthState {
  if (provider.describeAuthState) return provider.describeAuthState();
  // Fallback derivation for providers without the sync auth-state surface:
  // credentialAuthority 'anonymous' is a registration-time keyless
  // declaration; isConfigured() (absent ⇒ assumed configured) covers the rest.
  const configured = provider.isConfigured?.() ?? true;
  const anonymous = provider.credentialAuthority === 'anonymous';
  return {
    configured: configured && !anonymous,
    allowAnonymous: anonymous,
    anonymousReady: anonymous && configured,
    authEnvVars: [],
  };
}

/**
 * Resolve the default model's keyless readiness from live registration state.
 * Never throws — an unresolvable model key is itself an honest answer.
 */
export function resolveDefaultModelReadiness(
  registry: ModelProviderSource,
  modelKey: string,
): DefaultModelReadiness {
  let provider: LLMProvider;
  try {
    provider = registry.getForModel(modelKey);
  } catch (err) {
    return {
      kind: 'unresolvable',
      modelKey,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const auth = authStateOf(provider);
  if (auth.anonymousReady && !auth.configured) {
    return { kind: 'keyless', modelKey, provider: provider.name };
  }
  if (auth.configured || (provider.isConfigured?.() ?? true)) {
    return { kind: 'configured', modelKey, provider: provider.name };
  }
  return { kind: 'needs-key', modelKey, provider: provider.name, authEnvVars: auth.authEnvVars };
}

/** Onboarding copy for the default model — generated, never hand-written. */
export interface OnboardingModelCopy {
  /** True ONLY when the provider's own auth state proves keyless readiness. */
  readonly keyless: boolean;
  /** One-line label for the start action. */
  readonly headline: string;
  /** Supporting detail (names the env var when a key is needed). */
  readonly detail: string;
}

/**
 * Generate the onboarding copy for a model from its derived readiness. The
 * `keyless: true` branch — the only source of a "no API key needed" promise —
 * is reachable solely from a `keyless` readiness, which itself only comes
 * from the provider's registered auth state. Every other branch honestly asks
 * for (or acknowledges) a key.
 */
export function buildOnboardingModelCopy(readiness: DefaultModelReadiness): OnboardingModelCopy {
  switch (readiness.kind) {
    case 'keyless':
      return {
        keyless: true,
        headline: 'Start now',
        detail: `Use the default model (${readiness.modelKey}) — no API key needed`,
      };
    case 'configured':
      return {
        keyless: false,
        headline: 'Start now',
        detail: `Use the default model (${readiness.modelKey}) with your configured ${readiness.provider} credentials`,
      };
    case 'needs-key': {
      const envHint = readiness.authEnvVars.length > 0
        ? ` (set ${readiness.authEnvVars.join(' or ')})`
        : '';
      return {
        keyless: false,
        headline: 'Add an API key to start',
        detail: `The default model (${readiness.modelKey}) uses ${readiness.provider}, which requires an API key${envHint}`,
      };
    }
    case 'unresolvable':
      return {
        keyless: false,
        headline: 'Choose a model to start',
        detail: `The configured default model (${readiness.modelKey}) is not available: ${readiness.detail}`,
      };
  }
}

/**
 * The pairing gate for any surface that CLAIMS a keyless default: fails
 * loudly unless the default model's provider genuinely works without a key.
 * A keyless-default claim pointing at an auth-required provider — the exact
 * defect that shipped a dead-end 401 — cannot pass this check.
 */
export function assertKeylessDefaultPairing(
  registry: ModelProviderSource,
  modelKey: string,
): void {
  const readiness = resolveDefaultModelReadiness(registry, modelKey);
  if (readiness.kind === 'keyless') return;
  const why = readiness.kind === 'unresolvable'
    ? `it does not resolve to a registered provider (${readiness.detail})`
    : readiness.kind === 'needs-key'
      ? `provider "${readiness.provider}" requires an API key${readiness.authEnvVars.length > 0 ? ` (${readiness.authEnvVars.join(', ')})` : ''} and none is configured`
      : `provider "${readiness.provider}" is key-configured, not keyless`;
  throw new Error(
    `Keyless-default pairing violated: the default model "${modelKey}" is claimed keyless, but ${why}. ` +
    `Either point the default at a provider whose registered auth state is genuinely anonymous-ready, ` +
    `or generate the onboarding copy from resolveDefaultModelReadiness() instead of claiming keyless.`,
  );
}
