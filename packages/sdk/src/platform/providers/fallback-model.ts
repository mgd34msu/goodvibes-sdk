/**
 * fallback-model.ts, the pre-catalog fallback registration for the
 * configured model: before the model catalog cache has loaded, the
 * configured `provider:model` is registered with family-aware context-window
 * and reasoning-effort inference, so the context meter and the compaction
 * denominator agree with the post-catalog window instead of a placeholder.
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ──────────────────────────
 *
 * Both the TUI (`runtime/provider-fallback.ts`) and the agent
 * (`runtime/services.ts`) carried an identical `ensureConfiguredModelIsRoutable`
 * and a near-identical `buildFallbackModelDefinition`, this module unifies
 * them. The TUI's `buildFallbackModelDefinition` is the superset adopted
 * here: it calls this package's own {@link inferFallbackContextWindow} and
 * {@link resolveReasoningEffortSpec} for family-aware inference, where the
 * agent's copy hardcoded a flat 128k/32k window split and a fixed
 * `['instant', 'low', 'medium', 'high']` reasoning-effort level set, which
 * silently mis-stated the window for any model outside the two curated
 * families and offered 'instant' to models that reject it while hiding
 * 'xhigh'/'max'/'none' from models that accept them. `codeEditing` is `true`
 * here (the TUI's value); the agent's copy set it `false` with no comment
 * explaining a deliberate difference, so it is treated as unintentional drift
 * rather than a real divergence to preserve.
 */
import type { ConfigManager } from '../config/manager.js';
import { inferFallbackContextWindow } from './context-window-fallback.js';
import { resolveReasoningEffortSpec } from './reasoning-effort-families.js';
import type { ModelDefinition } from './registry-types.js';
import type { ProviderRegistry } from './registry.js';

/**
 * Build the fallback `ModelDefinition` for a configured `provider:model` that
 * has not yet appeared in the live model catalog. Marked
 * `contextWindowProvenance: 'fallback'` so a later catalog entry for the same
 * `registryKey` is honestly understood to supersede it, never silently merged.
 */
export function buildFallbackModelDefinition(provider: string, modelId: string): ModelDefinition {
  const providerLower = provider.toLowerCase();
  const isReasoningProvider = providerLower.includes('openai')
    || providerLower.includes('anthropic')
    || providerLower.includes('gemini')
    || providerLower.includes('google');

  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Configured model available before the model catalog cache has loaded.',
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: isReasoningProvider,
      multimodal: isReasoningProvider,
    },
    contextWindow: inferFallbackContextWindow(provider, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    tier: 'standard',
    // Which levels this model accepts is a property of the model, not of the
    // provider it sits behind: a hardcoded fixed level set would offer levels
    // some models reject and hide levels others accept. The family-aware
    // resolver answers from the curated family table when the catalog has
    // not loaded yet, and otherwise returns its own labelled best guess,
    // which callers treat as "send nothing" rather than as verified levels.
    ...(isReasoningProvider
      ? { reasoningEffort: resolveReasoningEffortSpec({ modelId }) }
      : {}),
  };
}

/**
 * If the configured `provider.model` is provider-qualified, has a registered
 * provider, and is not yet in the live model catalog, register it as a
 * runtime fallback model so it resolves and meters correctly before the
 * catalog cache loads. A no-op when the model is unqualified, already
 * present, or its provider is not (yet) registered.
 */
export function ensureConfiguredModelIsRoutable(providerRegistry: ProviderRegistry, configManager: ConfigManager): void {
  const configuredModel = String(configManager.get('provider.model') ?? '').trim();
  if (!configuredModel.includes(':')) return;
  if (providerRegistry.listModels().some((model) => model.registryKey === configuredModel)) return;

  const [providerId, ...modelParts] = configuredModel.split(':');
  const modelId = modelParts.join(':').trim();
  if (!providerId || !modelId) return;

  const provider = providerRegistry.tryGet(providerId);
  if (!provider) return;

  providerRegistry.registerRuntimeProvider({
    provider,
    replace: true,
    models: [buildFallbackModelDefinition(providerId, modelId)],
  });
}
