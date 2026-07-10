/**
 * acp-agent-adapter.test.ts
 *
 * Exercises the agent-side ACP adapter (GoodVibesAcpAgent): honest capability
 * reporting, session lifecycle over an injected embedded-session substrate,
 * prompt streaming (runtime turn/tool events forwarded as ACP session updates),
 * terminal stop-reason mapping, permission bridging, and cancellation.
 *
 * The substrate is a fake EmbeddedSession built around a REAL RuntimeEventBus,
 * so the event-forwarding path under test is the real subscription machinery;
 * only the daemon behind it is faked (no LLM turn runs in unit tests).
 */
import { describe, expect, test } from 'bun:test';
import {
  GoodVibesAcpAgent,
  promptText,
  mapStopReason,
  mapPermissionOutcome,
} from '../packages/sdk/src/platform/acp/agent.ts';
import type { EmbeddedSession } from '../packages/sdk/src/platform/embed/session.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.ts';
import type { SharedSessionSubmission } from '../packages/sdk/src/platform/control-plane/session-types.ts';
import type { PermissionRequestHandler } from '../packages/sdk/src/platform/permissions/prompt.ts';
import type { TurnEvent } from '../packages/sdk/src/events/turn.ts';
import type { ToolEvent } from '../packages/sdk/src/events/tools.ts';

interface RecordedUpdate {
  sessionId: string;
  update: Record<string, unknown>;
}

function makeConn(permissionOptionId = 'allow-once'): {
  updates: RecordedUpdate[];
  permissionRequests: Record<string, unknown>[];
  conn: ConstructorParameters<typeof GoodVibesAcpAgent>[0];
} {
  const updates: RecordedUpdate[] = [];
  const permissionRequests: Record<string, unknown>[] = [];
  return {
    updates,
    permissionRequests,
    conn: {
      sessionUpdate: async (params: unknown) => {
        updates.push(params as RecordedUpdate);
      },
      requestPermission: async (params: unknown) => {
        permissionRequests.push(params as Record<string, unknown>);
        return { outcome: { outcome: 'selected', optionId: permissionOptionId } };
      },
    } as unknown as ConstructorParameters<typeof GoodVibesAcpAgent>[0],
  };
}

function makeFakeSubstrate(runtimeSessionId: string): {
  bus: RuntimeEventBus;
  submitted: string[];
  cancelled: string[];
  stopped: { value: boolean };
  permissionHandlers: PermissionRequestHandler[];
  factory: (options: { workspace: string; requestPermission: PermissionRequestHandler }) => Promise<EmbeddedSession>;
  emitTurn: (event: TurnEvent) => void;
  emitTool: (event: ToolEvent) => void;
} {
  const bus = new RuntimeEventBus();
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const stopped = { value: false };
  const permissionHandlers: PermissionRequestHandler[] = [];
  const emitTurn = (event: TurnEvent): void => {
    bus.emit('turn', createEventEnvelope(event.type, event, { sessionId: runtimeSessionId, source: 'test' }));
  };
  const emitTool = (event: ToolEvent): void => {
    bus.emit('tools', createEventEnvelope(event.type, event, { sessionId: runtimeSessionId, source: 'test' }));
  };
  const factory = async (options: {
    workspace: string;
    requestPermission: PermissionRequestHandler;
  }): Promise<EmbeddedSession> => {
    permissionHandlers.push(options.requestPermission);
    const fake: Partial<EmbeddedSession> = {
      workspace: options.workspace,
      url: 'http://127.0.0.1:0',
      events: bus,
      submit: async (input) => {
        submitted.push(typeof input === 'string' ? input : input.body);
        return {
          session: { id: runtimeSessionId },
          input: { id: 'input-1' },
          mode: 'spawn',
          created: true,
        } as unknown as SharedSessionSubmission;
      },
      sessions: {
        cancelInput: async (sessionId: string, inputId: string) => {
          cancelled.push(`${sessionId}:${inputId}`);
          return null;
        },
      } as unknown as EmbeddedSession['sessions'],
      stop: async () => {
        stopped.value = true;
      },
    };
    return fake as EmbeddedSession;
  };
  return { bus, submitted, cancelled, stopped, permissionHandlers, factory, emitTurn, emitTool };
}

describe('pure mappings', () => {
  test('promptText joins text blocks and resource links, skipping unsupported kinds', () => {
    expect(
      promptText([
        { type: 'text', text: 'fix the bug' },
        { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ]),
    ).toBe('fix the bug\n\nfile:///a.ts');
  });

  test('mapStopReason covers terminal turn events honestly', () => {
    expect(mapStopReason({ type: 'TURN_COMPLETED', turnId: 't', response: 'r', stopReason: 'completed' })).toBe('end_turn');
    expect(mapStopReason({ type: 'TURN_CANCEL', turnId: 't', stopReason: 'cancelled' })).toBe('cancelled');
    expect(mapStopReason({ type: 'TURN_ERROR', turnId: 't', error: 'x', stopReason: 'context_overflow' })).toBe('max_tokens');
    expect(mapStopReason({ type: 'TURN_ERROR', turnId: 't', error: 'x', stopReason: 'tool_loop_circuit_breaker' })).toBe('max_turn_requests');
    expect(mapStopReason({ type: 'TURN_ERROR', turnId: 't', error: 'x', stopReason: 'provider_error' })).toBe('refusal');
    expect(mapStopReason({ type: 'STREAM_DELTA', turnId: 't', content: 'c', accumulated: 'c' })).toBeNull();
  });

  test('mapPermissionOutcome maps selections and cancellation', () => {
    expect(mapPermissionOutcome({ outcome: 'cancelled' })).toEqual({ approved: false });
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'allow-once' })).toEqual({ approved: true });
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'allow-always' })).toEqual({ approved: true, remember: true });
    expect(mapPermissionOutcome({ outcome: 'selected', optionId: 'reject-once' })).toEqual({ approved: false });
  });
});

describe('initialize reports honest capabilities', () => {
  test('unsupported protocol features are false, never stubbed', async () => {
    const { conn } = makeConn();
    const agent = new GoodVibesAcpAgent(conn);
    const response = await agent.initialize({ protocolVersion: 1 });
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities.loadSession).toBe(false);
    expect(response.agentCapabilities.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    });
    expect(response.agentCapabilities.mcpCapabilities).toEqual({ http: false, sse: false });
    expect(response.authMethods).toEqual([]);
  });

  test('authenticate is a no-op success (no auth needed for a local daemon)', async () => {
    const { conn } = makeConn();
    const agent = new GoodVibesAcpAgent(conn);
    await expect(agent.authenticate({ methodId: 'anything' })).resolves.toBeUndefined();
  });
});

describe('session lifecycle + prompt streaming', () => {
  test('newSession boots a substrate session against cwd; prompt streams and completes', async () => {
    const substrate = makeFakeSubstrate('runtime-session-1');
    const { conn, updates } = makeConn();
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: substrate.factory });

    const created = await agent.newSession({ cwd: '/work/project', mcpServers: [] });
    expect(created.sessionId.startsWith('gv-')).toBe(true);

    const promptPromise = agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'do the thing' }],
    });
    await Bun.sleep(10); // allow submit + subscriptions to settle

    substrate.emitTurn({ type: 'STREAM_DELTA', turnId: 't1', content: 'hello ', accumulated: 'hello ' });
    substrate.emitTool({ type: 'TOOL_EXECUTING', callId: 'c1', turnId: 't1', tool: 'read_file', startedAt: Date.now() });
    substrate.emitTool({ type: 'TOOL_SUCCEEDED', callId: 'c1', turnId: 't1', tool: 'read_file', durationMs: 5 });
    substrate.emitTurn({ type: 'TURN_COMPLETED', turnId: 't1', response: 'hello world', stopReason: 'completed' });

    const result = await promptPromise;
    expect(result.stopReason).toBe('end_turn');
    expect(substrate.submitted).toEqual(['do the thing']);

    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    const chunk = updates.find((u) => u.update.sessionUpdate === 'agent_message_chunk')!;
    expect((chunk.update.content as { text: string }).text).toBe('hello ');
    const toolDone = updates.find((u) => u.update.sessionUpdate === 'tool_call_update')!;
    expect(toolDone.update.status).toBe('completed');
    expect(toolDone.update.toolCallId).toBe('c1');
  });

  test('cancel resolves the in-flight prompt with cancelled and cancels the queued input', async () => {
    const substrate = makeFakeSubstrate('runtime-session-2');
    const { conn } = makeConn();
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: substrate.factory });
    const created = await agent.newSession({ cwd: '/work/p2', mcpServers: [] });
    const promptPromise = agent.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'long task' }] });
    await Bun.sleep(10);
    await agent.cancel({ sessionId: created.sessionId });
    const result = await promptPromise;
    expect(result.stopReason).toBe('cancelled');
    expect(substrate.cancelled).toEqual(['runtime-session-2:input-1']);
  });

  test('permission asks bridge to ACP requestPermission and map the outcome back', async () => {
    const substrate = makeFakeSubstrate('runtime-session-3');
    const { conn, permissionRequests } = makeConn('allow-always');
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: substrate.factory });
    await agent.newSession({ cwd: '/work/p3', mcpServers: [] });

    const handler = substrate.permissionHandlers[0]!;
    const decision = await handler({
      callId: 'call-9',
      tool: 'write_file',
      args: { path: 'x.ts' },
      category: 'write',
      analysis: { classification: 'write', riskLevel: 'medium', summary: 'write a file', reasons: [] },
    });
    expect(decision).toEqual({ approved: true, remember: true });
    expect(permissionRequests.length).toBe(1);
    const toolCall = permissionRequests[0]!.toolCall as Record<string, unknown>;
    expect(toolCall.toolCallId).toBe('call-9');
    expect(toolCall.title).toBe('write_file');
    const options = permissionRequests[0]!.options as { kind: string }[];
    expect(options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
  });

  test('dispose stops every substrate session', async () => {
    const substrate = makeFakeSubstrate('runtime-session-4');
    const { conn } = makeConn();
    const agent = new GoodVibesAcpAgent(conn, { sessionFactory: substrate.factory });
    await agent.newSession({ cwd: '/work/p4', mcpServers: [] });
    await agent.dispose();
    expect(substrate.stopped.value).toBe(true);
  });
});
