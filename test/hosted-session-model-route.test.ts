/**
 * hosted-session-model-route.test.ts
 *
 * Per-session model selection over ONE shared provider registry.
 *
 * `setCurrentModel` switches the model for the whole process, which is correct
 * for a terminal with one conversation and wrong for a daemon hosting several:
 * creating a session on one model would re-route every other hosted session and
 * every background agent. So `sessions.hosted.create`'s model argument routes
 * through a VIEW whose only difference is the answer to `getCurrentModel()`.
 *
 * The two properties that makes load-bearing: the view answers with this
 * session's model, and everything else it forwards still operates on the one
 * real registry, otherwise a credential re-registration or a discovery pass
 * would land on a copy and the shared stack would silently diverge.
 */

import { expect, test } from 'bun:test';
import {
  resolveHostedModelDefinition,
  withHostedSessionModel,
} from '../packages/sdk/src/platform/hosted-sessions/model-route.ts';
import type { ModelDefinition, ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';

function model(registryKey: string, selectable = true): ModelDefinition {
  const [provider, id] = registryKey.split(':');
  return {
    registryKey,
    id: id ?? registryKey,
    provider: provider ?? '',
    name: registryKey,
    selectable,
  } as unknown as ModelDefinition;
}

/** A registry stand-in that records the mutations it was asked to perform. */
function registry(models: ModelDefinition[]) {
  const mutations: string[] = [];
  const real = {
    models,
    current: models[0],
    listModels(): ModelDefinition[] { return this.models; },
    getCurrentModel(): ModelDefinition | undefined { return this.current; },
    setCurrentModel(reference: string): void {
      mutations.push(`setCurrentModel:${reference}`);
      this.current = this.models.find((m) => m.registryKey === reference);
    },
  };
  return { real, mutations };
}

test('an unknown model is refused when the session is created, not at the first turn', () => {
  const { real } = registry([model('anthropic:one')]);
  expect(() => resolveHostedModelDefinition(real as unknown as ProviderRegistry, 'nope')).toThrow();
  // A provider-qualified reference passes the shared resolver through unchanged,
  // so the registry check here is what catches one this daemon does not have.
  expect(() => resolveHostedModelDefinition(real as unknown as ProviderRegistry, 'openai:absent'))
    .toThrow(/not in this daemon's model registry/);
});

test('a model that exists but is not selectable is refused by name', () => {
  const { real } = registry([model('anthropic:retired', false)]);
  expect(() => resolveHostedModelDefinition(real as unknown as ProviderRegistry, 'anthropic:retired'))
    .toThrow(/not selectable/);
});

test('a resolvable reference comes back as the definition it names', () => {
  const { real } = registry([model('anthropic:one'), model('openai:two')]);
  const resolved = resolveHostedModelDefinition(real as unknown as ProviderRegistry, 'openai:two');
  expect(resolved.registryKey).toBe('openai:two');
});

test('the view answers with this session\'s model while the shared registry keeps its own', () => {
  const { real } = registry([model('anthropic:one'), model('openai:two')]);
  const view = withHostedSessionModel(real as unknown as ProviderRegistry, model('openai:two'));

  expect(view.getCurrentModel().registryKey).toBe('openai:two');
  // The process-wide selection is untouched: another hosted session, and every
  // background agent, still see what they saw.
  expect(real.getCurrentModel()?.registryKey).toBe('anthropic:one');
});

test('every other member forwards to the one real registry', () => {
  const { real, mutations } = registry([model('anthropic:one'), model('openai:two')]);
  const view = withHostedSessionModel(real as unknown as ProviderRegistry, model('openai:two'));

  expect(view.listModels()).toBe(real.models);
  // A mutation through the view must land on the shared instance, or the model
  // stack quietly becomes two stacks.
  view.setCurrentModel('anthropic:one');
  expect(mutations).toEqual(['setCurrentModel:anthropic:one']);
  expect(real.getCurrentModel()?.registryKey).toBe('anthropic:one');
  // And the session's own answer is still its own.
  expect(view.getCurrentModel().registryKey).toBe('openai:two');
});
