/**
 * companion-chat-tool-registry.test.ts
 *
 * Verifies ToolRegistry DI in CompanionChatManager.
 *
 * TR1: When toolRegistry is injected and LLM emits a tool_call chunk,
 *      the registry.execute() is called with the expected arguments.
 * TR2: A turn.tool_result event is published after the tool executes.
 * TR3: Tool execution errors are published as isError=true tool_results.
 * TR4: When no toolRegistry is provided, tool_call chunks are published
 *      as events but the registry is not called (graceful degradation).
 */

import { describe, expect, test } from 'bun:test';
import { CompanionChatManager } from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';
import type {
  CompanionLLMProvider,
  CompanionChatEventPublisher,
  CompanionProviderChunk,
} from '../packages/sdk/src/_internal/platform/companion/companion-chat-manager.js';
import { ToolRegistry } from '../packages/sdk/src/_internal/platform/tools/registry.js';
import type { ToolResult } from '../packages/sdk/src/_internal/platform/types/tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

/** Build a mock ToolRegistry that records calls and returns a fixed output. */
function makeMockRegistry(
  toolOutput: string = 'tool-result-value',
  shouldThrow = false,
): { registry: ToolRegistry; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: 'mock_tool',
      description: 'A mock tool for testing',
      parameters: { type: 'object', properties: {} },
    },
    async execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
      calls.push({ callId: '', name: 'mock_tool', args });
      if (shouldThrow) {
        throw new Error('Tool execution failed');
      }
      return { success: true, output: toolOutput };
    },
  });

  return { registry, calls };
}

/** Build a provider that emits a tool_call followed by done. */
function makeToolCallProvider(
  toolName = 'mock_tool',
  toolCallId = 'call-123',
  toolInput: Record<string, unknown> = { x: 1 },
): CompanionLLMProvider {
  return {
    async *chatStream() {
      yield {
        type: 'tool_call',
        toolCallId,
        toolName,
        toolInput,
      } satisfies CompanionProviderChunk;
      yield { type: 'done' } satisfies CompanionProviderChunk;
    },
  };
}

interface PublishedEvent {
  event: string;
  payload: unknown;
  filter?: { clientId?: string };
}

function makeRecordingPublisher(): { publisher: CompanionChatEventPublisher; events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  const publisher: CompanionChatEventPublisher = {
    publishEvent(event, payload, filter) {
      events.push({ event, payload, filter });
    },
  };
  return { publisher, events };
}

// ---------------------------------------------------------------------------
// TR1: Registry.execute() called with expected args
// ---------------------------------------------------------------------------

describe('TR1: ToolRegistry.execute() called when LLM emits tool_call', () => {
  test('registry receives the correct toolName and toolInput', async () => {
    const { registry, calls } = makeMockRegistry('result-output');
    const { publisher } = makeRecordingPublisher();

    const manager = new CompanionChatManager({
      provider: makeToolCallProvider('mock_tool', 'call-xyz', { query: 'hello' }),
      eventPublisher: publisher,
      toolRegistry: registry,
      gcIntervalMs: 999_999,
      persist: false,
      rateLimiter: false,
    });

    const session = manager.createSession();
    await manager.postMessage(session.id, 'use a tool please');

    // Give async turn time to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({ query: 'hello' });

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// TR2: turn.tool_result event published after execution
// ---------------------------------------------------------------------------

describe('TR2: turn.tool_result event published after tool executes', () => {
  test('tool_result event contains the registry output and isError=false', async () => {
    const { registry } = makeMockRegistry('my-tool-output');
    const { publisher, events } = makeRecordingPublisher();

    const manager = new CompanionChatManager({
      provider: makeToolCallProvider('mock_tool', 'call-abc', { n: 42 }),
      eventPublisher: publisher,
      toolRegistry: registry,
      gcIntervalMs: 999_999,
      persist: false,
      rateLimiter: false,
    });

    const session = manager.createSession();
    await manager.postMessage(session.id, 'run tool');

    await new Promise((r) => setTimeout(r, 100));

    const toolResultEvents = events.filter((e) => e.event === 'companion-chat.turn.tool_result');
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);

    const resultPayload = toolResultEvents[0]!.payload as {
      type: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

    expect(resultPayload.type).toBe('turn.tool_result');
    expect(resultPayload.toolName).toBe('mock_tool');
    expect(resultPayload.toolCallId).toBe('call-abc');
    expect(resultPayload.result).toBe('my-tool-output');
    expect(resultPayload.isError).toBe(false);

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// TR3: Tool execution errors published as isError=true
// ---------------------------------------------------------------------------

describe('TR3: tool execution error published as isError=true', () => {
  test('when tool throws, turn.tool_result event has isError=true', async () => {
    const { registry } = makeMockRegistry('unused', /* shouldThrow */ true);
    const { publisher, events } = makeRecordingPublisher();

    const manager = new CompanionChatManager({
      provider: makeToolCallProvider('mock_tool', 'call-err', {}),
      eventPublisher: publisher,
      toolRegistry: registry,
      gcIntervalMs: 999_999,
      persist: false,
      rateLimiter: false,
    });

    const session = manager.createSession();
    await manager.postMessage(session.id, 'run failing tool');

    await new Promise((r) => setTimeout(r, 100));

    const toolResultEvents = events.filter((e) => e.event === 'companion-chat.turn.tool_result');
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);

    const resultPayload = toolResultEvents[0]!.payload as { isError: boolean; result: unknown };
    expect(resultPayload.isError).toBe(true);
    expect(typeof resultPayload.result).toBe('string'); // error message

    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// TR4: No registry — tool_call event published, registry not invoked
// ---------------------------------------------------------------------------

describe('TR4: no toolRegistry — tool_call event published, graceful degradation', () => {
  test('turn.tool_call event emitted even without toolRegistry', async () => {
    const { publisher, events } = makeRecordingPublisher();

    const manager = new CompanionChatManager({
      provider: makeToolCallProvider('mock_tool', 'call-noop', { a: 'b' }),
      eventPublisher: publisher,
      // No toolRegistry
      gcIntervalMs: 999_999,
      persist: false,
      rateLimiter: false,
    });

    const session = manager.createSession();
    await manager.postMessage(session.id, 'run tool with no registry');

    await new Promise((r) => setTimeout(r, 100));

    const toolCallEvents = events.filter((e) => e.event === 'companion-chat.turn.tool_call');
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

    const payload = toolCallEvents[0]!.payload as { toolName: string; toolCallId: string; toolInput: unknown };
    expect(payload.toolName).toBe('mock_tool');
    expect(payload.toolCallId).toBe('call-noop');

    // No tool_result event should have been emitted (no registry to call)
    const toolResultEvents = events.filter((e) => e.event === 'companion-chat.turn.tool_result');
    expect(toolResultEvents.length).toBe(0);

    manager.dispose();
  });
});
