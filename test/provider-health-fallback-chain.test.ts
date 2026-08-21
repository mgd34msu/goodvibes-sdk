/**
 * provider-health-fallback-chain.test.ts
 *
 * The fallback chain's nodes must all report the registry key that was STORED
 * for them, not one recomposed from `${providerId}:${modelId}`.
 *
 * Node 0 (the active model) always read `modelState.registryKey`. Nodes 1..N
 * recomposed theirs, so for any model whose id already carries a namespace,
 * an OpenRouter `vendor/model`, a Bedrock-style id, the same model was
 * described by two different keys depending on whether it happened to be
 * active or a fallback. Anything keyed off the visualizer's `registryKey`
 * (the model picker's position map, a click-to-switch handler) then failed to
 * match the registry entry it was pointing at.
 */

import { describe, expect, test } from 'bun:test';
import {
  createInitialModelState,
  type ModelDomainState,
} from '../packages/sdk/src/platform/runtime/store/domains/model.ts';
import { createInitialProviderHealthState } from '../packages/sdk/src/platform/runtime/store/domains/provider-health.ts';
import { buildFallbackChainData } from '../packages/sdk/src/platform/runtime/ui/provider-health/fallback-visualizer.ts';

/**
 * A model whose registry key is NOT `${providerId}:${modelId}` naively joined
 * in the shape the old code assumed, the id itself carries a slash-namespace,
 * which is the everyday OpenRouter case.
 */
function stateWithNamespacedChain(): ModelDomainState {
  return {
    ...createInitialModelState(),
    activeProviderId: 'openrouter',
    activeModelId: 'anthropic/claude-fable-5',
    displayName: 'Fable 5',
    registryKey: 'openrouter:anthropic/claude-fable-5',
    fallbackChain: [
      {
        providerId: 'openrouter',
        modelId: 'meta-llama/llama-4-70b',
        registryKey: 'openrouter:meta-llama/llama-4-70b',
        displayName: 'Llama 4 70B',
        reason: 'rate_limit',
      },
      {
        providerId: 'ollama',
        modelId: 'qwen3',
        registryKey: 'ollama:qwen3',
        displayName: 'Qwen 3 (local)',
        reason: 'unavailable',
      },
    ],
    activeFallbackIndex: -1,
  };
}

describe('buildFallbackChainData', () => {
  test('every node reports its stored registry key, primary and fallbacks alike', () => {
    const data = buildFallbackChainData(stateWithNamespacedChain(), createInitialProviderHealthState());

    expect(data.nodes.map((node) => node.registryKey)).toEqual([
      'openrouter:anthropic/claude-fable-5',
      'openrouter:meta-llama/llama-4-70b',
      'ollama:qwen3',
    ]);
  });

  test('a stored key is used verbatim even when it differs from provider:model', () => {
    const state = stateWithNamespacedChain();
    // The registry knows this fallback by a key that a naive join would never
    // produce. The node must carry the key the registry uses.
    state.fallbackChain[0] = {
      providerId: 'bedrock',
      modelId: 'claude-fable-5',
      registryKey: 'bedrock:us.anthropic.claude-fable-5-v1:0',
      displayName: 'Fable 5 (Bedrock)',
      reason: 'manual',
    };

    const data = buildFallbackChainData(state, createInitialProviderHealthState());

    expect(data.nodes[1]?.registryKey).toBe('bedrock:us.anthropic.claude-fable-5-v1:0');
    // The recomposed form is what the old code produced, assert it is gone.
    expect(data.nodes[1]?.registryKey).not.toBe('bedrock:claude-fable-5');
  });

  test('positions, current-node marking and provider ids are unaffected', () => {
    const state = stateWithNamespacedChain();
    state.activeFallbackIndex = 1;

    const data = buildFallbackChainData(state, createInitialProviderHealthState());

    expect(data.nodes.map((node) => node.position)).toEqual([0, 1, 2]);
    expect(data.nodes.map((node) => node.isCurrent)).toEqual([false, false, true]);
    expect(data.nodes.map((node) => node.providerId)).toEqual(['openrouter', 'openrouter', 'ollama']);
    expect(data.activeIndex).toBe(1);
  });

  test('an empty chain still yields the primary node with its stored key', () => {
    const state = { ...stateWithNamespacedChain(), fallbackChain: [] };

    const data = buildFallbackChainData(state, createInitialProviderHealthState());

    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0]?.registryKey).toBe('openrouter:anthropic/claude-fable-5');
    expect(data.nodes[0]?.isCurrent).toBe(true);
  });
});
