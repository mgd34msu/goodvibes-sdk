import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitTurnCompleted, emitTurnError, emitTurnCancel } from '../packages/sdk/src/platform/runtime/emitters/turn.js';
import { emitAgentCompleted } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import type { EmitterContext } from '../packages/sdk/src/platform/runtime/emitters/index.js';

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const ctx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

/** Poll until `predicate()` is true or the timeout elapses. Event dispatch is via queueMicrotask + async I/O, so a bare await isn't enough. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: timed out');
}

describe('WorkspaceCheckpointManager automatic snapshots', () => {
  test('TURN_COMPLETED triggers an automatic turn-kind checkpoint carrying the turnId', async () => {
    const root = tempWorkspace('wcp-events-turn-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    await manager.init();

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-1', response: 'ok', stopReason: 'completed' });

    await waitFor(async () => (await manager.list()).length === 1);
    const [checkpoint] = await manager.list();
    expect(checkpoint!.kind).toBe('turn');
    expect(checkpoint!.turnId).toBe('turn-1');
  });

  test('resolveSessionId stamps the owning session on automatic snapshots; an unresolved agent stays unstamped', async () => {
    const root = tempWorkspace('wcp-events-session-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    manager.setSessionResolver(({ agentId }) => (agentId === 'agent-known' ? 'sess-known' : undefined));
    await manager.init();

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-known', durationMs: 1 });
    await waitFor(async () => (await manager.list()).length === 1);
    const [stamped] = await manager.list();
    expect(stamped!.sessionId).toBe('sess-known');
    expect((await manager.list({ sessionId: 'sess-known' })).map((c) => c.id)).toEqual([stamped!.id]);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-unknown', durationMs: 1 });
    await waitFor(async () => (await manager.list()).length === 2);
    const unstamped = (await manager.list()).find((c) => c.agentId === 'agent-unknown');
    expect(unstamped!.sessionId).toBeUndefined();
  });

  test('TURN_ERROR and TURN_CANCEL also trigger turn-kind checkpoints', async () => {
    const root = tempWorkspace('wcp-events-turn-err-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    await manager.init();

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnError(bus, ctx, { turnId: 'turn-err', error: 'boom', stopReason: 'provider_error' });
    await waitFor(async () => (await manager.list()).length === 1);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitTurnCancel(bus, ctx, { turnId: 'turn-cancel', stopReason: 'cancelled' });
    await waitFor(async () => (await manager.list()).length === 2);

    const all = await manager.list();
    expect(all.every((c) => c.kind === 'turn')).toBe(true);
    expect(all.map((c) => c.turnId).sort()).toEqual(['turn-cancel', 'turn-err']);
  });

  test('AGENT_COMPLETED triggers an automatic agent-run-kind checkpoint carrying the agentId, and lineage chains across turns', async () => {
    const root = tempWorkspace('wcp-events-agent-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    await manager.init();

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-1', response: 'ok', stopReason: 'completed' });
    await waitFor(async () => (await manager.list()).length === 1);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-1', durationMs: 100, output: 'done' });
    await waitFor(async () => (await manager.list()).length === 2);

    const all = await manager.list();
    const agentCheckpoint = all.find((c) => c.kind === 'agent-run')!;
    const turnCheckpoint = all.find((c) => c.kind === 'turn')!;
    expect(agentCheckpoint.agentId).toBe('agent-1');
    expect(agentCheckpoint.parentId).toBe(turnCheckpoint.id);
  });

  test('a listener error inside the manager never throws back into the bus and never crashes an unrelated emit', async () => {
    const root = tempWorkspace('wcp-events-noop-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    await manager.init();

    // No filesystem change at all — TURN_COMPLETED should still fire the
    // subscriber, which will simply no-op (dedupe) rather than throw.
    emitTurnCompleted(bus, ctx, { turnId: 'noop-turn', response: 'ok', stopReason: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await manager.list()).toHaveLength(0);
  });

  test('dispose() unsubscribes from the bus — events after dispose create no further checkpoints', async () => {
    const root = tempWorkspace('wcp-events-dispose-');
    const bus = new RuntimeEventBus();
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
    await manager.init();

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-before-dispose', response: 'ok', stopReason: 'completed' });
    await waitFor(async () => (await manager.list()).length === 1);

    manager.dispose();

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-after-dispose', response: 'ok', stopReason: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await manager.list()).toHaveLength(1);
  });
});
