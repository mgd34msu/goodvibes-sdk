import { describe, expect, test } from 'bun:test';

/**
 * OBS-06: Prompt/response privacy at the telemetry egress boundary.
 *
 * Design:
 * - Internal RuntimeEventBus carries RAW prompt/response strings (internal
 *   consumers — conversation reducer, reply pipeline, stream UI — need them).
 * - TelemetryApiService ring buffer stores raw payloads so operators with
 *   explicit raw-view authorization can read them.
 * - EGRESS boundary: `listEvents({view: 'safe'})` (the default) runs payloads
 *   through `sanitizeRecord` → `redactStructuredData`, which matches the
 *   CONTENT_KEY_PATTERN (prompt, response, content, body, text, stdout, stderr,
 *   output, input, reasoning, transcript, command, arguments, query, detail,
 *   summary, message) and replaces the value with `[REDACTED_TEXT length=N]`.
 * - `listEvents({view: 'raw'})` skips redaction for callers with raw privilege.
 *
 * Config: `telemetry.includeRawPrompts` gates whether view='raw' is permitted
 * at all. Default false (home/production deployments get safe view always,
 * even if a caller requests raw). Opt-in with a startup WARN.
 */
describe('obs-06 summarizePromptContent helper', () => {
  test('returns PromptSummary by default (redacted)', async () => {
    const { summarizePromptContent } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    const content = 'Tell me about the weather in Paris.';
    const result = summarizePromptContent(content, false);
    const summary = result as { length: number; sha256: string; first100chars: string };
    expect(summary.length).toBe(content.length);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('returns raw string when includeRaw is true', async () => {
    const { summarizePromptContent } = await import('../packages/sdk/src/platform/runtime/llm-observability.js');
    expect(summarizePromptContent('secret', true)).toBe('secret');
  });
});

describe('obs-06 redaction-config module', () => {
  test('setTelemetryIncludeRawPrompts and getTelemetryIncludeRawPrompts round-trip', async () => {
    const { setTelemetryIncludeRawPrompts, getTelemetryIncludeRawPrompts } = await import('../packages/sdk/src/platform/runtime/telemetry/redaction-config.js');
    setTelemetryIncludeRawPrompts(false);
    expect(getTelemetryIncludeRawPrompts()).toBe(false);
    setTelemetryIncludeRawPrompts(true);
    expect(getTelemetryIncludeRawPrompts()).toBe(true);
    setTelemetryIncludeRawPrompts(false);
  });
});

describe('obs-06 existing redactor strips prompt/response at safe view', () => {
  test('redactStructuredData redacts TURN_SUBMITTED.prompt key', async () => {
    const { redactStructuredData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const payload = {
      type: 'TURN_SUBMITTED',
      turnId: 't1',
      prompt: 'My API key is sk-very-secret-123 and password hunter2 with lots of extra text to exceed the preview length cap here',
    };
    const redacted = redactStructuredData(payload) as Record<string, unknown>;
    expect(typeof redacted['prompt']).toBe('string');
    // The existing redactor replaces content-keyed string values with [REDACTED_TEXT length=N]
    expect(redacted['prompt']).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
    // raw secrets must not leak
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-very-secret-123');
    expect(serialized).not.toContain('hunter2');
  });

  test('redactStructuredData redacts STREAM_DELTA.content/accumulated/reasoning keys', async () => {
    const { redactStructuredData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const payload = {
      type: 'STREAM_DELTA',
      turnId: 't2',
      content: 'CONTENT-SECRET with enough text to trip the length gate sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
      accumulated: 'ACCUMULATED-SECRET with enough text aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reasoning: 'REASONING-SECRET with enough text rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
    };
    const redacted = redactStructuredData(payload) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('CONTENT-SECRET');
    expect(serialized).not.toContain('ACCUMULATED-SECRET');
    expect(serialized).not.toContain('REASONING-SECRET');
  });

  test('redactStructuredData redacts TURN_COMPLETED.response key', async () => {
    const { redactStructuredData } = await import('../packages/sdk/src/platform/utils/redaction.js');
    const payload = {
      type: 'TURN_COMPLETED',
      turnId: 't3',
      response: 'model-reply-SECRET-with-enough-text-to-definitely-trigger-the-content-key-redaction-pattern-here-please',
      stopReason: 'completed',
    };
    const redacted = redactStructuredData(payload) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('model-reply-SECRET');
  });
});

describe('obs-06 end-to-end through TelemetryApiService safe view', () => {
  test('TURN_SUBMITTED raw prompt → safe-view listEvents redacts prompt field', async () => {
    const { RuntimeEventBus } = await import('../packages/sdk/src/platform/runtime/events/index.js');
    const { TelemetryApiService } = await import('../packages/sdk/src/platform/runtime/telemetry/api.js');
    const { createRuntimeStore } = await import('../packages/sdk/src/platform/runtime/store/index.js');
    const { emitTurnSubmitted } = await import('../packages/sdk/src/platform/runtime/emitters/turn.js');

    const bus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    const telemetry = new TelemetryApiService({ runtimeBus: bus, runtimeStore });

    emitTurnSubmitted(bus, { sessionId: 's1', traceId: 't1', source: 'test' }, {
      turnId: 'turn1',
      prompt: 'sk-very-secret-token plus password hunter2 and enough extra text to guarantee the safe-view redactor fires on this prompt field',
    });
    await new Promise((r) => setImmediate(r));

    // Default view is 'safe' — prompt field must be redacted
    const safeEvents = telemetry.listEvents({});
    const safeRecord = safeEvents.find((e) => e.type === 'TURN_SUBMITTED')
    expect(safeRecord?.type).toBe('TURN_SUBMITTED');
    const serialized = JSON.stringify(safeRecord);
    expect(serialized).not.toContain('sk-very-secret-token');
    expect(serialized).not.toContain('hunter2');
  });

  test('TURN_SUBMITTED raw prompt → raw-view listEvents returns unredacted', async () => {
    const { RuntimeEventBus } = await import('../packages/sdk/src/platform/runtime/events/index.js');
    const { TelemetryApiService } = await import('../packages/sdk/src/platform/runtime/telemetry/api.js');
    const { createRuntimeStore } = await import('../packages/sdk/src/platform/runtime/store/index.js');
    const { emitTurnSubmitted } = await import('../packages/sdk/src/platform/runtime/emitters/turn.js');

    const bus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    const telemetry = new TelemetryApiService({ runtimeBus: bus, runtimeStore });

    emitTurnSubmitted(bus, { sessionId: 's2', traceId: 't2', source: 'test' }, {
      turnId: 'turn2',
      prompt: 'raw visible prompt',
    });
    await new Promise((r) => setImmediate(r));

    const rawEvents = telemetry.listEvents({ view: 'raw' });
    const rawRecord = rawEvents.find((e) => e.type === 'TURN_SUBMITTED')
    expect(rawRecord?.type).toBe('TURN_SUBMITTED');
    const payload = rawRecord!.payload as Record<string, unknown>;
    expect(payload['prompt']).toBe('raw visible prompt');
  });
});
