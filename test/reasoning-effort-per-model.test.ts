/**
 * reasoning-effort-per-model.test.ts
 *
 * Per-model reasoning-effort resolution, and the adapter wire shapes it feeds.
 *
 * The defect this pins: every Anthropic-family adapter used to send
 * `thinking: {type: 'enabled', budget_tokens: N}` for any non-instant effort,
 * on every Claude model. Anthropic's extended-thinking documentation states
 * that "Claude 4.7 and later models do not support it and reject requests that
 * use it, returning a 400 error", so a turn on Opus 4.7 or later with a
 * reasoning effort set was a guaranteed failed request. Current models take
 * `output_config.effort` instead. The Claude-4.7+ case below asserts the
 * absence of `thinking` explicitly, not just the presence of the new field.
 *
 * Gemini has the mirror-image problem: 3-series models take `thinking_level`
 * and 2.5-series take `thinking_budget`, and Google's docs are explicit that a
 * request specifying both is rejected.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  budgetTokensForLevel,
  describeReasoningRejection,
  getActiveReasoningEffortOptions,
  isAcceptableReasoningEffortSetting,
  parseReasoningOptions,
  reasoningEffortSpecFromLevels,
  resolveEffortForModel,
  setActiveReasoningEffortOptions,
  snapEffortDown,
  FALLBACK_REASONING_EFFORT_SPEC,
  REASONING_EFFORT_SEVERITY,
  type ReasoningEffortBudgetSpec,
  type ReasoningEffortSpec,
} from '../packages/sdk/src/platform/providers/reasoning-effort.ts';
import { getDiscoveredTraits } from '../packages/sdk/src/platform/providers/discovered-traits.ts';
import { readAutomationReasoningEffort } from '../packages/sdk/src/platform/daemon/helpers.ts';
import {
  dispatchBatchRoutes,
  type DaemonBatchRouteContext,
} from '../packages/sdk/src/platform/daemon/http/batch-routes.ts';
import type { CreateDaemonBatchJobInput } from '../packages/sdk/src/platform/batch/types.ts';
import {
  findFamilyReasoningEffortSpec,
  normalizeReasoningModelId,
  resolveEffortForRequest,
  resolveReasoningEffortSpec,
} from '../packages/sdk/src/platform/providers/reasoning-effort-families.ts';
import { applyAnthropicReasoning } from '../packages/sdk/src/platform/providers/anthropic-stream.ts';
import { AnthropicSdkProvider } from '../packages/sdk/src/platform/providers/anthropic-sdk-provider.ts';
import { GeminiProvider } from '../packages/sdk/src/platform/providers/gemini.ts';
import { getCatalogModelDefinitionsFrom } from '../packages/sdk/src/platform/providers/model-catalog.ts';
import type { CatalogModel } from '../packages/sdk/src/platform/providers/model-catalog.ts';
import { BUILTIN_COMPAT_PROVIDERS } from '../packages/sdk/src/platform/providers/builtin-catalog.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

// ---------------------------------------------------------------------------
// 1. models.dev reasoning_options parser, all four published shapes
// ---------------------------------------------------------------------------

describe('models.dev reasoning_options parser', () => {
  test('effort shape keeps exactly the published values, in severity order', () => {
    // openai/gpt-5.2-pro publishes a subset that starts at medium.
    const spec = parseReasoningOptions([{ type: 'effort', values: ['xhigh', 'medium', 'high'] }]);
    expect(spec).toEqual({
      kind: 'effort',
      values: ['medium', 'high', 'xhigh'],
      source: 'catalog',
    });
  });

  test('toggle alongside effort adds an off state', () => {
    // anthropic/claude-sonnet-5 publishes both a toggle and named levels.
    const spec = parseReasoningOptions([
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
    expect(spec?.kind).toBe('effort');
    expect(spec?.values).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('budget_tokens shape bounds the levels by the published min and max', () => {
    // google/gemini-2.5-pro publishes min 128, max 32768.
    const spec = parseReasoningOptions([{ type: 'budget_tokens', min: 128, max: 32768 }]);
    expect(spec?.kind).toBe('budget_tokens');
    expect((spec as ReasoningEffortBudgetSpec).minBudgetTokens).toBe(128);
    expect((spec as ReasoningEffortBudgetSpec).maxBudgetTokens).toBe(32768);
    // xhigh (49152) and max (63999) exceed the model's ceiling and are dropped.
    expect(spec?.values).not.toContain('xhigh');
    expect(spec?.values).not.toContain('max');
    expect(spec?.values).toContain('high');
  });

  test('empty array means reasons-but-not-configurable, which is not the same as absent', () => {
    // deepseek/deepseek-reasoner publishes exactly `[]`.
    const empty = parseReasoningOptions([]);
    expect(empty).toEqual({
      kind: 'unavailable',
      values: [],
      source: 'catalog',
      note: expect.any(String),
    });
    // Absent is a different statement: the catalog said nothing at all.
    expect(parseReasoningOptions(undefined)).toBeUndefined();
  });

  test('toggle alone resolves to an on/off spec', () => {
    const spec = parseReasoningOptions([{ type: 'toggle' }]);
    expect(spec?.kind).toBe('toggle');
    expect(spec?.values).toEqual(['none', 'high']);
  });

  test('effort wins when a model publishes both effort and budget_tokens', () => {
    // anthropic/claude-sonnet-4-6 publishes both; budget_tokens is the
    // deprecated one there, so the named levels must be what we resolve to.
    const spec = parseReasoningOptions([
      { type: 'effort', values: ['low', 'medium', 'high', 'max'] },
      { type: 'budget_tokens', min: 1024 },
    ]);
    expect(spec?.kind).toBe('effort');
  });

  test('malformed entries are ignored rather than trusted', () => {
    const spec = parseReasoningOptions([
      { type: 'effort', values: ['low', 'not-a-level', 'high'] },
    ]);
    expect(spec?.values).toEqual(['low', 'high']);
  });
});

// ---------------------------------------------------------------------------
// 2. Source precedence: catalog > curated family table > labelled best guess
// ---------------------------------------------------------------------------

describe('reasoning-effort source precedence', () => {
  test('a live catalog spec outranks the curated family table', () => {
    const catalogSpec = parseReasoningOptions([{ type: 'effort', values: ['low', 'high'] }])!;
    const resolved = resolveReasoningEffortSpec({ modelId: 'claude-opus-4-7', spec: catalogSpec });
    expect(resolved.source).toBe('catalog');
    expect(resolved.values).toEqual(['low', 'high']);
  });

  test('the curated family table outranks a non-catalog spec and the best guess', () => {
    const resolved = resolveReasoningEffortSpec({ modelId: 'claude-sonnet-4-5' });
    expect(resolved.source).toBe('family');
    expect(resolved.kind).toBe('budget_tokens');
  });

  test('an unrecognized model falls back to a ladder that labels itself a guess', () => {
    const resolved = resolveReasoningEffortSpec({ modelId: 'some-unknown-vendor-model-v9' });
    expect(resolved.source).toBe('fallback');
    expect(resolved.values).toEqual(['low', 'medium', 'high']);
    expect(resolved.note).toContain('Best-guess');
  });

  test('provider routing decoration reaches the same family row', () => {
    expect(normalizeReasoningModelId('us.anthropic.claude-opus-4-7-v1:0')).toBe('claude-opus-4-7');
    expect(normalizeReasoningModelId('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeReasoningModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5');
    for (const id of ['us.anthropic.claude-opus-4-7-v1:0', 'anthropic/claude-opus-4-7']) {
      expect(findFamilyReasoningEffortSpec(id)?.kind).toBe('effort');
    }
  });

  test('an author-declared level list becomes a curated spec, not a guess', () => {
    const spec = reasoningEffortSpecFromLevels(['high', 'low']);
    expect(spec).toEqual({ kind: 'effort', values: ['low', 'high'], source: 'declared' });
    expect(reasoningEffortSpecFromLevels([])?.kind).toBe('unavailable');
    expect(reasoningEffortSpecFromLevels(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Requested level -> available level: snap down, never up
// ---------------------------------------------------------------------------

describe('resolveEffortForModel', () => {
  const threeLevel: ReasoningEffortSpec = {
    kind: 'effort',
    values: ['low', 'medium', 'high'],
    source: 'family',
  };

  test('an exactly-available level passes through with no remapping note', () => {
    const result = resolveEffortForModel('medium', { id: 'm', reasoningEffort: threeLevel });
    expect(result.value).toBe('medium');
    expect(result.note).toBeUndefined();
  });

  test('an unavailable level snaps down to the closest one below it', () => {
    const result = resolveEffortForModel('xhigh', { id: 'gpt-x', reasoningEffort: threeLevel });
    expect(result.value).toBe('high');
    expect(result.note).toContain('xhigh');
    expect(result.note).toContain('high');
  });

  test('snapping never promotes: with nothing at or below, the level is dropped', () => {
    // openai/gpt-5.2-pro starts at medium, so a request for none/low has no
    // lower option. Sending `medium` instead would spend more than asked.
    const proSpec: ReasoningEffortSpec = {
      kind: 'effort',
      values: ['medium', 'high', 'xhigh'],
      source: 'catalog',
    };
    const result = resolveEffortForModel('none', { id: 'gpt-5.2-pro', reasoningEffort: proSpec });
    expect(result.value).toBeUndefined();
    expect(result.note).toContain("isn't available");
  });

  test('snapEffortDown picks the highest option at or below the request', () => {
    expect(snapEffortDown('max', ['low', 'high', 'medium'])).toBe('high');
    expect(snapEffortDown('low', ['low', 'high'])).toBe('low');
    expect(snapEffortDown('minimal', ['low', 'high'])).toBeUndefined();
    expect(snapEffortDown('not-a-level', ['low'])).toBeUndefined();
  });

  test('a toggle turns on rather than snapping a light request down to off', () => {
    const toggle: ReasoningEffortSpec = {
      kind: 'toggle',
      values: ['none', 'high'],
      source: 'catalog',
    };
    // Snapping 'low' down the ladder would land on 'none' and silently disable
    // reasoning, the opposite of what a light-reasoning request means.
    expect(resolveEffortForModel('low', { id: 'm', reasoningEffort: toggle }).value).toBe('high');
    expect(resolveEffortForModel('none', { id: 'm', reasoningEffort: toggle }).value).toBe('none');
  });

  test('an unconfigurable model reports that honestly instead of guessing', () => {
    const spec: ReasoningEffortSpec = {
      kind: 'unavailable',
      values: [],
      source: 'catalog',
      note: 'fixed depth',
    };
    const result = resolveEffortForModel('high', { id: 'deepseek-reasoner', reasoningEffort: spec });
    expect(result.value).toBeUndefined();
    expect(result.note).toContain('deepseek-reasoner');
  });

  test('an unknown level name falls back to the default and says so', () => {
    const withDefault: ReasoningEffortSpec = {
      kind: 'effort',
      values: ['low', 'high'],
      source: 'family',
      defaultValue: 'high',
    };
    const result = resolveEffortForModel('turbo', { id: 'm', reasoningEffort: withDefault });
    expect(result.value).toBe('high');
    expect(result.note).toContain('turbo');
  });

  test('a budget spec clamps the level budget into the model range', () => {
    const spec: ReasoningEffortBudgetSpec = {
      kind: 'budget_tokens',
      values: ['none', 'low', 'medium', 'high'],
      source: 'catalog',
      minBudgetTokens: 4096,
      maxBudgetTokens: 16384,
      canDisableReasoning: true,
    };
    expect(budgetTokensForLevel('low', spec)).toBe(4096);
    expect(budgetTokensForLevel('high', spec)).toBe(16384);
    expect(budgetTokensForLevel('none', spec)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Anthropic adapters, the live 400 defect
// ---------------------------------------------------------------------------

function anthropicBody(model: string, effort: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model, max_tokens: 8192 };
  applyAnthropicReasoning(body, { model, reasoningEffort: effort }, Infinity);
  return body;
}

describe('Anthropic reasoning wire shape', () => {
  test('Claude 4.7 and later never receive budget_tokens (they 400 on it)', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      const body = anthropicBody(model, 'high');
      expect(body['thinking']).toBeUndefined();
      expect(body['output_config']).toEqual({ effort: 'high' });
    }
  });

  test('Claude 4.6 uses the effort field, not its deprecated token budget', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      const body = anthropicBody(model, 'high');
      expect(body['thinking']).toBeUndefined();
      expect(body['output_config']).toEqual({ effort: 'high' });
    }
  });

  test('Claude 4.6 has no xhigh, so a request for it snaps down to high', () => {
    const body = anthropicBody('claude-sonnet-4-6', 'xhigh');
    expect(body['output_config']).toEqual({ effort: 'high' });
  });

  test('Claude 3.7 through 4.5 still use the token budget and never the effort field', () => {
    for (const model of [
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-3-7-sonnet-20250219',
    ]) {
      const body = anthropicBody(model, 'high');
      expect(body['output_config']).toBeUndefined();
      expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32768 });
    }
  });

  test('generations older than extended thinking receive no reasoning field at all', () => {
    // Extended thinking arrived with Claude 3.7 Sonnet; every earlier model
    // rejects a `thinking` block, so a budget must never be built for one.
    for (const model of [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-2.1',
      'claude-instant-1.2',
    ]) {
      for (const effort of ['none', 'low', 'medium', 'high', 'max']) {
        const body = anthropicBody(model, effort);
        expect(body['thinking']).toBeUndefined();
        expect(body['output_config']).toBeUndefined();
      }
      expect(findFamilyReasoningEffortSpec(model)?.kind).toBe('unavailable');
    }
  });

  test('no model ever receives both fields', () => {
    const models = [
      'claude-opus-4-7', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-5',
      'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-haiku-4-5',
    ];
    for (const model of models) {
      for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
        const body = anthropicBody(model, effort);
        const both = body['thinking'] !== undefined && body['output_config'] !== undefined;
        expect(both).toBe(false);
      }
    }
  });

  test('an off request disables thinking only when the catalog published a toggle', () => {
    const body: Record<string, unknown> = { model: 'claude-sonnet-5' };
    applyAnthropicReasoning(
      body,
      {
        model: 'claude-sonnet-5',
        reasoningEffort: 'none',
        reasoningEffortSpec: parseReasoningOptions([
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
        ])!,
      },
      Infinity,
    );
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['output_config']).toBeUndefined();
  });

  test('a budget that would exceed the model output cap is skipped, not clamped past it', () => {
    const body: Record<string, unknown> = { model: 'claude-sonnet-4-5', max_tokens: 4096 };
    applyAnthropicReasoning(body, { model: 'claude-sonnet-4-5', reasoningEffort: 'high' }, 4096);
    expect(body['thinking']).toBeUndefined();
  });

  test('the shared AnthropicSdkProvider path puts the same shape on the wire', async () => {
    const captured: Record<string, unknown>[] = [];
    const provider = new AnthropicSdkProvider({
      name: 'test-anthropic-sdk',
      label: 'Test',
      defaultModel: 'claude-opus-4-7',
      models: ['claude-opus-4-7', 'claude-sonnet-4-5'],
      createClient: () => ({
        messages: {
          stream: (body: Record<string, unknown>) => {
            captured.push(body);
            return {
              [Symbol.asyncIterator]: async function* () {
                yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
              },
              finalMessage: async () => ({
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
              response: null,
            };
          },
        },
      }),
      auth: { mode: 'api-key', configured: true, detail: 'test' },
      streamProtocol: 'anthropic-sdk-stream',
    });

    await provider.chat({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'max',
    });
    await provider.chat({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'max',
    });

    expect(captured[0]?.['thinking']).toBeUndefined();
    expect(captured[0]?.['output_config']).toEqual({ effort: 'max' });
    expect(captured[1]?.['output_config']).toBeUndefined();
    expect((captured[1]?.['thinking'] as { type?: string } | undefined)?.type).toBe('enabled');
  });
});

describe('request-time rejections name the effort level', () => {
  test('a 400 mentioning a reasoning field points at the level that caused it', () => {
    const hint = describeReasoningRejection(
      400,
      'thinking.budget_tokens is not supported on this model',
      'high',
    );
    expect(hint).toContain("'high'");
    expect(hint).toContain('/effort');
  });

  test('an unrelated 400 is not blamed on the effort setting', () => {
    expect(describeReasoningRejection(400, 'messages: roles must alternate', 'high')).toBeUndefined();
  });

  test('non-400 statuses and unset levels produce no hint', () => {
    expect(describeReasoningRejection(429, 'reasoning effort', 'high')).toBeUndefined();
    expect(describeReasoningRejection(400, 'reasoning effort', undefined)).toBeUndefined();
  });

  test('an Anthropic-compat provider resolves against its default model, not an empty id', () => {
    // The compat adapter allows an omitted model and falls back to its own
    // default. Resolving against the omitted value would miss the family row
    // and hand a Claude 4.7 model a token budget.
    const body: Record<string, unknown> = {};
    applyAnthropicReasoning(body, { model: 'claude-opus-4-7', reasoningEffort: 'high' }, Infinity);
    expect(body['output_config']).toEqual({ effort: 'high' });

    const unresolved: Record<string, unknown> = {};
    applyAnthropicReasoning(unresolved, { model: '', reasoningEffort: 'high' }, Infinity);
    // An empty id matches no family and lands on the labelled guess, which is
    // exactly the wrong answer for a real Claude model, hence the fix.
    expect(unresolved['thinking']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Gemini, thinking_level vs thinking_budget, never both
// ---------------------------------------------------------------------------

describe('Gemini reasoning wire shape', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function geminiThinkingConfig(model: string, effort: string): Promise<Record<string, unknown> | undefined> {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    const provider = new GeminiProvider('test-key');
    await provider.chat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: effort,
    });
    const generationConfig = body?.['generationConfig'] as Record<string, unknown> | undefined;
    return generationConfig?.['thinking_config'] as Record<string, unknown> | undefined;
  }

  test('Gemini 3-series takes a named thinking_level and never a budget', async () => {
    for (const model of ['gemini-3-pro', 'gemini-3.5-flash', 'gemini-3.1-pro-preview']) {
      const config = await geminiThinkingConfig(model, 'high');
      expect(config).toEqual({ thinking_level: 'high' });
      expect(config?.['thinking_budget']).toBeUndefined();
    }
  });

  test('Gemini 2.5-series takes a token budget and never a level', async () => {
    const config = await geminiThinkingConfig('gemini-2.5-pro', 'high');
    expect(config?.['thinking_budget']).toBe(32768);
    expect(config?.['thinking_level']).toBeUndefined();
  });

  test('Gemini 2.5 clamps to its published ceiling rather than exceeding it', async () => {
    const config = await geminiThinkingConfig('gemini-2.5-flash', 'max');
    // max (63999) exceeds the family ceiling of 32768, so the request snaps
    // down to the highest level the model can actually express.
    expect(config?.['thinking_budget']).toBe(32768);
  });

  test('a model with no thinking configuration receives no thinking_config', async () => {
    expect(await geminiThinkingConfig('gemini-2.0-flash', 'high')).toBeUndefined();
  });

  test('an unrecognized model receives nothing rather than a guessed field', async () => {
    expect(await geminiThinkingConfig('some-experimental-model', 'high')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Adapters that used to send nothing at all
// ---------------------------------------------------------------------------

describe('OpenAI-compatible reasoning wiring', () => {
  test('xAI and DeepSeek declare a reasoning format instead of silently dropping', () => {
    const byId = new Map(BUILTIN_COMPAT_PROVIDERS.map((entry) => [entry.id, entry]));
    const xai = byId.get('xai');
    if (xai?.kind !== 'openai-compat') throw new Error('expected the xai builtin entry to be an openai-compat definition');
    expect(xai.reasoningFormat).toBe('reasoning-effort');
    const deepseek = byId.get('deepseek');
    if (deepseek?.kind !== 'openai-compat') throw new Error('expected the deepseek builtin entry to be an openai-compat definition');
    expect(deepseek.reasoningFormat).toBe('reasoning-effort');
  });

  test('the base grok-4 gets no level, because it rejects the parameter outright', () => {
    expect(resolveEffortForRequest('high', { modelId: 'grok-4' }).value).toBeUndefined();
    // Its successors do accept it.
    expect(resolveEffortForRequest('high', { modelId: 'grok-4-1-fast' }).value).toBe('high');
  });

  test('DeepSeek only accepts high and max, so medium resolves to the model default', () => {
    // Requesting medium has nothing at or below it, and DeepSeek's own default
    // is high, omitting the field is correct and is not a promotion we chose.
    expect(resolveEffortForRequest('medium', { modelId: 'deepseek-chat' }).value).toBeUndefined();
    expect(resolveEffortForRequest('max', { modelId: 'deepseek-chat' }).value).toBe('max');
    expect(resolveEffortForRequest('high', { modelId: 'deepseek-reasoner' }).value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Catalog definitions stop over-claiming reasoning support
// ---------------------------------------------------------------------------

function catalogModel(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: 'model-x',
    name: 'Model X',
    provider: 'OpenAI',
    providerId: 'openai',
    providerEnvVars: [],
    pricing: { input: 1, output: 2 },
    tier: 'paid',
    contextWindow: 128_000,
    ...overrides,
  };
}

describe('catalog model definitions', () => {
  test("a vendor's non-reasoning model is no longer flagged as effort-configurable", () => {
    const [definition] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'gpt-4o', reasoning: false }),
    ]);
    expect(definition?.capabilities.reasoning).toBe(false);
    expect(definition?.reasoningEffort).toBeUndefined();
  });

  test('published reasoning_options become the model definition spec', () => {
    const [definition] = getCatalogModelDefinitionsFrom([
      catalogModel({
        id: 'gpt-5.2-pro',
        reasoning: true,
        reasoningOptions: [{ type: 'effort', values: ['medium', 'high', 'xhigh'] }],
      }),
    ]);
    expect(definition?.reasoningEffort).toEqual({
      kind: 'effort',
      values: ['medium', 'high', 'xhigh'],
      source: 'catalog',
    });
  });

  test('a reasoning model with no published options resolves through the family table', () => {
    const [definition] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'claude-opus-4-7', provider: 'Anthropic', providerId: 'anthropic', reasoning: true }),
    ]);
    expect(definition?.reasoningEffort?.source).toBe('family');
    expect(definition?.reasoningEffort?.kind).toBe('effort');
  });

  test('an empty options array is carried through as unconfigurable', () => {
    const [definition] = getCatalogModelDefinitionsFrom([
      catalogModel({ id: 'deepseek-reasoner', reasoning: true, reasoningOptions: [] }),
    ]);
    expect(definition?.capabilities.reasoning).toBe(true);
    expect(definition?.reasoningEffort?.kind).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// 8. Config schema, set-time validation against the model in use
// ---------------------------------------------------------------------------

describe('provider.reasoningEffort config validation', () => {
  afterEach(() => {
    setActiveReasoningEffortOptions(null);
  });

  function manager(): ConfigManager {
    const configDir = join(tmpdir(), `gv-effort-${randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    return new ConfigManager({ configDir });
  }

  test('levels the old four-value enum rejected are now accepted', () => {
    const config = manager();
    for (const level of ['none', 'minimal', 'xhigh', 'max', 'instant', 'low', 'medium', 'high']) {
      config.set('provider.reasoningEffort', level);
      expect(config.get('provider.reasoningEffort')).toBe(level);
    }
  });

  test('a value that is not a reasoning level at all is still rejected', () => {
    const config = manager();
    expect(() => config.set('provider.reasoningEffort', 'turbo')).toThrow();
    expect(() => config.set('provider.reasoningEffort', '')).toThrow();
  });

  test('once the runtime publishes the model options, validation follows them', () => {
    const config = manager();
    setActiveReasoningEffortOptions(['low', 'high']);
    config.set('provider.reasoningEffort', 'high');
    expect(config.get('provider.reasoningEffort')).toBe('high');
    // `max` is a real level, but not one THIS model offers.
    expect(() => config.set('provider.reasoningEffort', 'max')).toThrow();
  });

  test('before any model publishes, the known severity ladder is the floor', () => {
    expect(isAcceptableReasoningEffortSetting('xhigh')).toBe(true);
    expect(isAcceptableReasoningEffortSetting('nonsense')).toBe(false);
    expect(isAcceptableReasoningEffortSetting(3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Source precedence, a spec attached to the model outranks the family table
// ---------------------------------------------------------------------------

describe('a declared spec outranks the prefix-matched family table', () => {
  test('a local deepseek-r1 on ollama keeps the levels its own adapter maps', () => {
    // The family table's `deepseek` row describes DeepSeek's hosted API, which
    // offers only high and max. Local weights served by ollama share the name
    // and nothing else: the ollama adapter maps low/medium/high and has no
    // mapping for max at all, so letting the table win would both hide three
    // working levels and silently drop the one it offered.
    const declared = getDiscoveredTraits('ollama').reasoningEffort;
    expect(declared).toBeDefined();

    const hosted = findFamilyReasoningEffortSpec('deepseek-r1:70b');
    expect(hosted?.values).toEqual(['high', 'max']);

    for (const modelId of ['deepseek-r1:70b', 'deepseek-r1:8b', 'deepseek-v3']) {
      const resolved = resolveReasoningEffortSpec({ modelId, spec: declared! });
      expect(resolved.source).toBe('declared');
      expect(resolved.values).toEqual(['instant', 'low', 'medium', 'high']);
      // The level the user picked survives instead of snapping up to 'high'.
      expect(resolveEffortForRequest('medium', { modelId, spec: declared! }).value).toBe('medium');
    }
  });

  test('the same shadowing would have hit every other vendor-named local model', () => {
    const declared = getDiscoveredTraits('lm-studio').reasoningEffort!;
    for (const modelId of ['gpt-5-local-gguf', 'grok-4-community', 'gemini-2.5-clone']) {
      const resolved = resolveReasoningEffortSpec({ modelId, spec: declared });
      expect(resolved.values).toEqual(['instant', 'low', 'medium', 'high']);
    }
  });

  test('the live catalog still outranks a declared spec', () => {
    const declared = reasoningEffortSpecFromLevels(['low', 'high'])!;
    const catalog = parseReasoningOptions([{ type: 'effort', values: ['medium', 'max'] }])!;
    expect(resolveReasoningEffortSpec({ modelId: 'deepseek-r1', spec: catalog })).toBe(catalog);
    expect(resolveReasoningEffortSpec({ modelId: 'deepseek-r1', spec: declared })).toBe(declared);
  });

  test('a fallback-sourced spec still loses to the family table', () => {
    const resolved = resolveReasoningEffortSpec({
      modelId: 'claude-opus-5',
      spec: FALLBACK_REASONING_EFFORT_SPEC,
    });
    expect(resolved.source).toBe('family');
    expect(resolved.values).toContain('xhigh');
  });
});

// ---------------------------------------------------------------------------
// 10. The ladder is read in one place at every HTTP boundary
// ---------------------------------------------------------------------------

describe('job payloads carry the whole ladder end to end', () => {
  test('an automation execution policy keeps xhigh and max', () => {
    for (const level of REASONING_EFFORT_SEVERITY) {
      expect(readAutomationReasoningEffort(level)).toBe(level);
    }
  });

  test('an automation policy still rejects a value that is not a level', () => {
    expect(readAutomationReasoningEffort('turbo')).toBeUndefined();
    expect(readAutomationReasoningEffort('')).toBeUndefined();
    expect(readAutomationReasoningEffort(7)).toBeUndefined();
  });

  test('a batch job created over HTTP with xhigh reaches the batch manager', async () => {
    for (const level of ['xhigh', 'max', 'none', 'minimal']) {
      const created: CreateDaemonBatchJobInput[] = [];
      const response = await dispatchBatchRoutes(
        new Request('http://daemon/api/batch/jobs', { method: 'POST' }),
        {
          batchManager: {
            createJob: async (input: CreateDaemonBatchJobInput) => {
              created.push(input);
              return { id: 'job-1' };
            },
          } as unknown as DaemonBatchRouteContext['batchManager'],
          parseJsonBody: async () => ({
            model: 'claude-opus-5',
            request: { messages: [], reasoningEffort: level },
          }),
          parseOptionalJsonBody: async () => null,
        },
      );
      expect(response?.status).toBe(202);
      expect(created[0]?.request.reasoningEffort).toBe(level);
    }
  });

  test('a batch job with a non-level value drops the field rather than passing it on', async () => {
    const created: CreateDaemonBatchJobInput[] = [];
    await dispatchBatchRoutes(
      new Request('http://daemon/api/batch/jobs', { method: 'POST' }),
      {
        batchManager: {
          createJob: async (input: CreateDaemonBatchJobInput) => {
            created.push(input);
            return { id: 'job-1' };
          },
        } as unknown as DaemonBatchRouteContext['batchManager'],
        parseJsonBody: async () => ({
          model: 'claude-opus-5',
          request: { messages: [], reasoningEffort: 'turbo' },
        }),
        parseOptionalJsonBody: async () => null,
      },
    );
    expect(created[0]?.request.reasoningEffort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Zero-budget levels are offered only where a zero budget is accepted
// ---------------------------------------------------------------------------

describe('budget models offer off only when they can be switched off', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function geminiThinkingBudget(model: string, effort: string): Promise<unknown> {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    await new GeminiProvider('test-key').chat({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: effort,
    });
    const generationConfig = body?.['generationConfig'] as Record<string, unknown> | undefined;
    return (generationConfig?.['thinking_config'] as Record<string, unknown> | undefined)?.['thinking_budget'];
  }

  test('Gemini 2.5 Pro is never offered a level that sends thinking_budget 0', async () => {
    const spec = findFamilyReasoningEffortSpec('gemini-2.5-pro')!;
    expect(spec.kind).toBe('budget_tokens');
    // Google documents a 128-token minimum for 2.5 Pro; a zero budget is a 400.
    expect(spec.values).not.toContain('none');
    expect(spec.values).not.toContain('instant');
    expect((spec as ReasoningEffortBudgetSpec).canDisableReasoning).toBe(false);

    // A request for one of those levels sends no budget at all rather than 0.
    for (const level of ['none', 'instant']) {
      expect(await geminiThinkingBudget('gemini-2.5-pro', level)).toBeUndefined();
    }
  });

  test('a catalog entry that publishes min 0 keeps the off levels', () => {
    const spec = parseReasoningOptions([{ type: 'budget_tokens', min: 0, max: 24576 }])!;
    expect(spec.values).toContain('none');
    expect((spec as ReasoningEffortBudgetSpec).canDisableReasoning).toBe(true);
  });

  test('Anthropic keeps its off levels despite a 1024-token floor', () => {
    // Anthropic turns thinking off by omitting the block entirely, so its
    // minimum budget says nothing about whether it can be disabled.
    const spec = findFamilyReasoningEffortSpec('claude-sonnet-4-5') as ReasoningEffortBudgetSpec;
    expect(spec.minBudgetTokens).toBe(1024);
    expect(spec.canDisableReasoning).toBe(true);
    expect(spec.values).toContain('none');
    expect(anthropicBody('claude-sonnet-4-5', 'none')['thinking']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Mercury keeps the one provider that names an 'instant' level
// ---------------------------------------------------------------------------

describe('Mercury reasoning levels', () => {
  test("mercury-2 keeps 'instant' on the wire", () => {
    const spec = findFamilyReasoningEffortSpec('mercury-2')!;
    expect(spec.values).toEqual(['instant', 'low', 'medium', 'high']);
    expect(resolveEffortForRequest('instant', { modelId: 'mercury-2' }).value).toBe('instant');
  });

  test('mercury-edit exposes no reasoning control', () => {
    expect(findFamilyReasoningEffortSpec('mercury-edit')?.kind).toBe('unavailable');
    expect(resolveEffortForRequest('high', { modelId: 'mercury-edit' }).value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 13. Nothing requested means nothing sent
// ---------------------------------------------------------------------------

describe('an unrequested level puts no field on the request', () => {
  test('a documented default is recorded but never sent back', () => {
    const spec = findFamilyReasoningEffortSpec('claude-opus-5')!;
    expect(spec.defaultValue).toBe('high');
    expect(resolveEffortForModel(undefined, { id: 'claude-opus-5', reasoningEffort: spec }).value)
      .toBeUndefined();
    expect(resolveEffortForModel('', { id: 'claude-opus-5', reasoningEffort: spec }).value)
      .toBeUndefined();
  });

  test('an adapter called without a level sends no reasoning field', () => {
    const body: Record<string, unknown> = { model: 'claude-opus-5', max_tokens: 8192 };
    applyAnthropicReasoning(body, { model: 'claude-opus-5' }, Infinity);
    expect(body['output_config']).toBeUndefined();
    expect(body['thinking']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 14. Published options are scoped to the session that published them
// ---------------------------------------------------------------------------

describe('published reasoning options do not bleed between sessions', () => {
  afterEach(() => {
    setActiveReasoningEffortOptions(null);
    setActiveReasoningEffortOptions(null, 'session-a');
    setActiveReasoningEffortOptions(null, 'session-b');
  });

  test('each session reads back its own model options', () => {
    setActiveReasoningEffortOptions(['low', 'medium', 'high', 'xhigh', 'max'], 'session-a');
    setActiveReasoningEffortOptions(['low', 'medium', 'high'], 'session-b');
    expect(getActiveReasoningEffortOptions('session-a')).toContain('xhigh');
    expect(getActiveReasoningEffortOptions('session-b')).not.toContain('xhigh');
  });

  test('the session that ran a turn most recently does not decide for the others', () => {
    setActiveReasoningEffortOptions(['low', 'medium', 'high', 'xhigh', 'max'], 'session-a');
    // A gpt-5 turn on another session lands after the Claude turn on session-a.
    setActiveReasoningEffortOptions(['low', 'medium', 'high'], 'session-b');
    expect(isAcceptableReasoningEffortSetting('xhigh', 'session-a')).toBe(true);
    expect(isAcceptableReasoningEffortSetting('xhigh', 'session-b')).toBe(false);
    // The config schema's validator holds no session, so a level that is real
    // on any live session is accepted rather than rejected by whoever ran last.
    expect(isAcceptableReasoningEffortSetting('xhigh')).toBe(true);
    // A level no live session offers is still rejected.
    expect(isAcceptableReasoningEffortSetting('minimal')).toBe(false);
    expect(isAcceptableReasoningEffortSetting('turbo')).toBe(false);
  });

  test('a session with nothing published falls back to the process-wide slot', () => {
    setActiveReasoningEffortOptions(['low', 'high']);
    expect(getActiveReasoningEffortOptions('session-never-seen')).toEqual(['low', 'high']);
  });
});
