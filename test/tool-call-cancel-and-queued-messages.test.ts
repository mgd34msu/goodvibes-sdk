/**
 * tool-call-cancel-and-queued-messages.test.ts — two small interaction wins.
 *
 * 1. Per-tool cancel: ONE running tool call can be killed through the
 *    cooperative abort machinery (Tool.execute opts.signal). The cancelled call
 *    settles as a structured "cancelled by user" result (cancelled: true) and
 *    the TURN CONTINUES — sibling calls in the same batch are unaffected and
 *    still execute. Previously the only lever was the whole-turn abort.
 *
 * 2. Queued mid-turn messages: the orchestrator queue was push/shift only.
 *    Entries now carry stable ids and stay listable/editable/deletable until
 *    delivery; a delivered message is immutable.
 *
 * Both are exposed over the operator contract (sessions.toolCalls.cancel,
 * sessions.queuedMessages.*) via the live-turn controls holder.
 */
import { describe, expect, test } from 'bun:test';
import { executeToolCalls, TOOL_CALL_CANCELLED_MESSAGE } from '../packages/sdk/src/platform/core/orchestrator-tool-runtime.ts';
import {
  ToolCallAbortRegistry,
  listQueuedMessages,
  editQueuedMessage,
  deleteQueuedMessage,
  type QueuedMessageEntry,
} from '../packages/sdk/src/platform/core/orchestrator-live-turn.ts';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.ts';
import type { PermissionManager } from '../packages/sdk/src/platform/permissions/manager.ts';
import {
  createSessionRuntimeControls,
  createSessionToolCallCancelHandler,
  createSessionQueuedMessagesListHandler,
  createSessionQueuedMessageEditHandler,
  createSessionQueuedMessageDeleteHandler,
  SessionLiveTurnControlsHolder,
  type SessionLiveTurnControls,
} from '../packages/sdk/src/platform/control-plane/routes/session-runtime.ts';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';

const allowAll = { check: async () => true } as unknown as PermissionManager;

function makeRegistryWithTools(): ToolRegistry {
  const registry = new ToolRegistry();
  // A slow, signal-aware tool: resolves cancelled-early when aborted, or
  // completes after 5s otherwise (the test cancels it long before that).
  registry.register({
    definition: { name: 'slow', description: 'slow tool', parameters: { type: 'object', properties: {} } },
    execute: (_args, opts) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: true, output: 'slow completed' }), 5_000);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ success: false, error: 'aborted' });
      });
    }),
  });
  registry.register({
    definition: { name: 'fast', description: 'fast tool', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ success: true, output: 'fast completed' }),
  });
  return registry;
}

describe('per-tool cancel — one call dies, the turn continues', () => {
  test('cancelling one call mid-flight yields a structured cancelled result; the sibling call still executes', async () => {
    const aborts = new ToolCallAbortRegistry();
    const deps = {
      toolRegistry: makeRegistryWithTools(),
      permissionManager: allowAll,
      hookDispatcher: null,
      runtimeBus: null,
      sessionId: 'test-session',
      emitterContext: (turnId: string) => ({ sessionId: 'test-session', traceId: turnId, source: 'orchestrator' as const }),
      toolCallSignals: aborts,
    };

    // Cancel the slow call shortly after it starts (calls run sequentially:
    // slow first, then fast — exactly the mid-turn shape).
    setTimeout(() => {
      expect(aborts.cancel('call-slow')).toBe(true);
    }, 50);

    const results = await executeToolCalls(deps, 'turn-1', [
      { id: 'call-slow', name: 'slow', arguments: {} },
      { id: 'call-fast', name: 'fast', arguments: {} },
    ]);

    // BOTH results exist — the batch (and thus the turn) continued.
    expect(results.length).toBe(2);
    const slow = results.find((r) => r.callId === 'call-slow')!;
    const fast = results.find((r) => r.callId === 'call-fast')!;
    // The cancelled call is a structured "cancelled by user" result.
    expect(slow.success).toBe(false);
    expect(slow.cancelled).toBe(true);
    expect(slow.error).toBe(TOOL_CALL_CANCELLED_MESSAGE);
    // The other call is untouched by the cancel.
    expect(fast.success).toBe(true);
    expect(fast.output).toBe('fast completed');
    expect(fast.cancelled).toBeUndefined();
    // The registry retired both calls after settlement.
    expect(aborts.list().length).toBe(0);
  });

  test('cancel of an unknown/settled call returns false', () => {
    const aborts = new ToolCallAbortRegistry();
    expect(aborts.cancel('never-started')).toBe(false);
  });

  test('a whole-turn abortAll cancels every in-flight call', () => {
    const aborts = new ToolCallAbortRegistry();
    const first = aborts.open('a');
    const second = aborts.open('b');
    aborts.abortAll();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true);
    expect(aborts.list().length).toBe(0);
  });
});

describe('queued mid-turn messages — editable/deletable until delivery', () => {
  function makeQueue(): QueuedMessageEntry[] {
    return [
      { id: 'qm-1', queuedAt: 1000, text: 'first pending' },
      { id: 'qm-2', queuedAt: 2000, text: 'second pending' },
    ];
  }

  test('list returns pending entries in delivery order', () => {
    const queue = makeQueue();
    expect(listQueuedMessages(queue)).toEqual([
      { id: 'qm-1', queuedAt: 1000, text: 'first pending' },
      { id: 'qm-2', queuedAt: 2000, text: 'second pending' },
    ]);
  });

  test('edit replaces text (and clears multimodal content) before delivery', () => {
    const queue = makeQueue();
    queue[0]!.content = [{ type: 'text', text: 'old' }];
    expect(editQueuedMessage(queue, 'qm-1', 'rewritten')).toBe(true);
    expect(queue[0]!.text).toBe('rewritten');
    expect(queue[0]!.content).toBeUndefined();
  });

  test('delete removes a pending entry before delivery', () => {
    const queue = makeQueue();
    expect(deleteQueuedMessage(queue, 'qm-1')).toBe(true);
    expect(listQueuedMessages(queue).map((m) => m.id)).toEqual(['qm-2']);
  });

  test('a delivered message is immutable — edit and delete both refuse', () => {
    const queue = makeQueue();
    // Delivery is a shift() (drainMessageQueue's exact mechanics).
    const delivered = queue.shift()!;
    expect(delivered.id).toBe('qm-1');
    expect(editQueuedMessage(queue, 'qm-1', 'too late')).toBe(false);
    expect(deleteQueuedMessage(queue, 'qm-1')).toBe(false);
    // The remaining pending entry is still editable.
    expect(editQueuedMessage(queue, 'qm-2', 'still pending')).toBe(true);
  });

  test('blank edit text is refused', () => {
    const queue = makeQueue();
    expect(editQueuedMessage(queue, 'qm-1', '   ')).toBe(false);
    expect(queue[0]!.text).toBe('first pending');
  });
});

describe('operator wire — sessions.toolCalls.cancel and sessions.queuedMessages.*', () => {
  function makeControlsWith(live: SessionLiveTurnControls | null) {
    const holder = new SessionLiveTurnControlsHolder();
    if (live) holder.bind(live);
    return createSessionRuntimeControls({
      config: { get: () => 'prompt' as const, set: () => {} },
      store: { getState: () => ({ session: { id: 'sess-1' }, conversation: { estimatedContextTokens: 0 }, model: { tokenLimits: { contextWindow: 100000 } } }) },
      liveTurnHolder: holder,
    });
  }

  function makeLiveDouble() {
    const queue: QueuedMessageEntry[] = [{ id: 'qm-9', queuedAt: 42, text: 'pending' }];
    const cancelled: string[] = [];
    const live: SessionLiveTurnControls = {
      cancelToolCall: (callId) => {
        if (callId !== 'call-live') return false;
        cancelled.push(callId);
        return true;
      },
      listQueuedMessages: () => listQueuedMessages(queue),
      editQueuedMessage: (id, text) => editQueuedMessage(queue, id, text),
      deleteQueuedMessage: (id) => deleteQueuedMessage(queue, id),
    };
    return { live, queue, cancelled };
  }

  test('cancel routes to the bound runtime and 404s for a non-running call', () => {
    const { live, cancelled } = makeLiveDouble();
    const handler = createSessionToolCallCancelHandler(makeControlsWith(live));
    const ok = handler({ body: { sessionId: 'sess-1', callId: 'call-live' }, context: {} }) as Record<string, unknown>;
    expect(ok.cancelled).toBe(true);
    expect(cancelled).toEqual(['call-live']);
    expect(() => handler({ body: { sessionId: 'sess-1', callId: 'gone' }, context: {} }))
      .toThrow(/TOOL_CALL_NOT_RUNNING|not.*in flight|already settled/i);
  });

  test('queuedMessages list/edit/delete round-trip over the wire handlers', () => {
    const { live } = makeLiveDouble();
    const controls = makeControlsWith(live);
    const list = createSessionQueuedMessagesListHandler(controls);
    const edit = createSessionQueuedMessageEditHandler(controls);
    const del = createSessionQueuedMessageDeleteHandler(controls);

    const first = list({ body: { sessionId: 'sess-1' }, context: {} }) as { messages: Array<{ id: string; text: string }> };
    expect(first.messages.map((m) => m.id)).toEqual(['qm-9']);

    const edited = edit({ body: { sessionId: 'sess-1', messageId: 'qm-9', text: 'edited' }, context: {} }) as Record<string, unknown>;
    expect(edited.text).toBe('edited');

    const deleted = del({ body: { sessionId: 'sess-1', messageId: 'qm-9' }, context: {} }) as Record<string, unknown>;
    expect(deleted.deleted).toBe(true);
    // Now delivered/absent: edit and delete refuse with MESSAGE_NOT_QUEUED.
    expect(() => edit({ body: { sessionId: 'sess-1', messageId: 'qm-9', text: 'x' }, context: {} })).toThrow(GatewayVerbError);
    expect(() => del({ body: { sessionId: 'sess-1', messageId: 'qm-9' }, context: {} })).toThrow(GatewayVerbError);
  });

  test('with no live runtime bound the verbs refuse honestly', () => {
    const handler = createSessionToolCallCancelHandler(makeControlsWith(null));
    expect(() => handler({ body: { sessionId: 'sess-1', callId: 'x' }, context: {} }))
      .toThrow(/live-turn controls are unavailable/i);
  });

  test('a non-local session id is a 404 SESSION_NOT_LOCAL', () => {
    const { live } = makeLiveDouble();
    const handler = createSessionQueuedMessagesListHandler(makeControlsWith(live));
    expect(() => handler({ body: { sessionId: 'other-sess' }, context: {} }))
      .toThrow(/does not host a live runtime/i);
  });
});
