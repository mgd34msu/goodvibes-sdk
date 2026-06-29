/**
 * Provider/model-family-aware context-window fallback.
 *
 * Used only when neither the live catalog (models.dev) nor the provider API
 * reports a context window for a model — e.g. a model newer than the models.dev
 * snapshot (the "brand-new gpt-5.5" case). A single flat default badly mis-sizes
 * the window and drives auto-compaction to fire far too early (small default) or
 * too late (large default, risking a provider "context length exceeded" error).
 * Infer a sane family default from the provider and model id instead.
 *
 * The real window always wins whenever the catalog / OpenRouter / provider_api
 * supplies one; this is the last line of defense, not a primary source.
 */

/** Last-resort default when neither provider nor model id is recognised. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Best-effort context window (in tokens) inferred from provider + model id.
 *
 * Over-estimating is the dangerous direction (it risks context-overflow errors),
 * so only known-large families get a large window; older/unknown families stay at
 * the conservative {@link FALLBACK_CONTEXT_WINDOW}.
 */
export function inferFallbackContextWindow(provider: string, modelId?: string): number {
  const p = provider.toLowerCase();
  const id = (modelId ?? '').toLowerCase();

  if (p.includes('google') || p.includes('gemini') || id.startsWith('gemini')) return 1_000_000;
  if (p.includes('anthropic') || id.startsWith('claude')) return 200_000;
  if (p.includes('xai') || p.includes('grok') || id.startsWith('grok')) return 256_000;

  const looksOpenAI =
    p.includes('openai') ||
    id.startsWith('gpt') ||
    id.startsWith('chatgpt') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4');
  if (looksOpenAI) {
    // gpt-5 / gpt-4.1 families are 400k; the o-series reasoning models are 200k;
    // gpt-4o / gpt-4-turbo / gpt-4o-mini and anything unrecognised stay at 128k.
    if (id.startsWith('gpt-5') || id.startsWith('gpt-4.1') || id.startsWith('gpt-4-1')) return 400_000;
    if (id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 200_000;
    return 128_000;
  }

  return FALLBACK_CONTEXT_WINDOW;
}
