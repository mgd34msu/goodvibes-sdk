/**
 * model-route.ts, a per-session model selection over one shared registry.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `ProviderRegistry.setCurrentModel` switches the model for the whole PROCESS.
 * That is correct for a terminal, which has one conversation. It is wrong for a
 * daemon hosting several: creating a session on one model would silently
 * re-route every other hosted session, every background agent, and the model
 * picker of any surface reading the same registry.
 *
 * `sessions.hosted.create` takes a model, so the field has to actually route
 * this session, a create argument that configures nothing is worse than no
 * argument at all. The Orchestrator asks the registry for `getCurrentModel()`
 * once per turn and otherwise treats the registry as shared state, so the
 * narrowest correct change is a VIEW of the shared registry whose answer to
 * that one question is this session's model, and whose every other member is
 * the shared registry's, operating on the shared registry's state.
 *
 * That is what this returns. Credential re-registration, discovery, pricing,
 * context-window reconciliation and every other mutation still land on the one
 * real registry, the view forwards them, so nothing about the shared model
 * stack is duplicated or diverges. Only the selection is per session.
 *
 * ── Refusing beats pretending ──────────────────────────────────────────────
 *
 * The reference is resolved against the live registry at composition time
 * through the same shared resolver the spawn path uses, so an unknown or
 * ambiguous id is refused when the session is created, naming real candidates,
 * rather than accepted and quietly ignored at the first turn.
 */

import type { ModelDefinition, ProviderRegistry } from '../providers/registry.js';
import { resolveModelReference } from '../providers/model-id-resolution.js';

/**
 * Resolve a model reference (a bare id or a `provider/model` registry key)
 * against the live registry.
 *
 * @throws when the reference names no model, names several, or names one that
 * is not selectable, with the resolver's own message, which lists candidates.
 */
export function resolveHostedModelDefinition(
  registry: Pick<ProviderRegistry, 'listModels'>,
  modelReference: string,
): ModelDefinition {
  const models = registry.listModels();
  const registryKey = resolveModelReference(modelReference, models);
  const definition = models.find((model) => model.registryKey === registryKey);
  if (!definition) {
    throw new Error(`Model '${modelReference}' is not in this daemon's model registry.`);
  }
  if (!definition.selectable) {
    throw new Error(`Model '${definition.registryKey}' is not selectable.`);
  }
  return definition;
}

/**
 * A view of `registry` whose `getCurrentModel()` is `definition` and whose
 * every other member is the shared registry's own, bound to the shared
 * registry so state stays single.
 */
export function withHostedSessionModel(
  registry: ProviderRegistry,
  definition: ModelDefinition,
): ProviderRegistry {
  return new Proxy(registry, {
    get(target, property): unknown {
      if (property === 'getCurrentModel') return () => definition;
      const value = Reflect.get(target, property, target) as unknown;
      // Bind methods to the REAL registry, never to the proxy: a method that
      // mutates must write through to the one shared instance.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set(target, property, value): boolean {
      return Reflect.set(target, property, value, target);
    },
  });
}
