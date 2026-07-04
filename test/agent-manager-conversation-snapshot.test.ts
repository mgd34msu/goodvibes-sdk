/**
 * W3.1 Part C6 (SDK side) — conversation-snapshot bridge.
 *
 * The audit's central finding: a fleet agent's real ConversationManager (full
 * message content) is a local variable in orchestrator-runner.ts's
 * runAgentTask, created per run and never retained anywhere once the run
 * ends. AgentManager.registerConversationSource/releaseConversationSource/
 * getConversationSnapshot bridges that gap for RUNNING agents (live read)
 * and gives a bounded grace window for just-completed agents (frozen final
 * snapshot, retained until evicted from a size-bounded ring) — without
 * retaining every finished agent's full history forever.
 *
 * These tests exercise AgentManager's public bridge API directly (the
 * load-bearing contract downstream tab code is built against). A companion
 * test in orchestrator-conversation-snapshot-bridge.test.ts proves
 * orchestrator-runner.ts's actual call sites (register right after creating
 * ConversationManager, release on every exit path) really invoke it.
 */
import { describe, expect, test } from 'bun:test';
import {
  AgentManager,
  DEFAULT_CONVERSATION_SNAPSHOT_RETENTION,
} from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { ConversationMessageSnapshot } from '../packages/sdk/src/platform/core/conversation.js';

function makeManager(conversationSnapshotRetention?: number): AgentManager {
  return new AgentManager({
    configManager: { get: () => null },
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    ...(conversationSnapshotRetention !== undefined ? { conversationSnapshotRetention } : {}),
  });
}

const snap = (text: string): ConversationMessageSnapshot[] => [{ role: 'user', content: text }];

describe('AgentManager — conversation snapshot bridge (W3.1 Part C6)', () => {
  test('unknown / never-registered agent returns an empty array', () => {
    const manager = makeManager();
    expect(manager.getConversationSnapshot('never-seen')).toEqual([]);
  });

  test('running agent: getConversationSnapshot reads the live source on every call (not a one-time copy)', () => {
    const manager = makeManager();
    let live = snap('turn 1');
    manager.registerConversationSource('ag-running', () => live);
    expect(manager.getConversationSnapshot('ag-running')).toEqual(snap('turn 1'));
    // The agent keeps talking — the bridge must reflect growth, proving it
    // calls the source function each time rather than caching turn 1 forever.
    live = snap('turn 1 + turn 2');
    expect(manager.getConversationSnapshot('ag-running')).toEqual(snap('turn 1 + turn 2'));
  });

  test('completed agent: releaseConversationSource freezes one final snapshot, retained per the retention rule', () => {
    const manager = makeManager();
    let live = snap('in progress');
    manager.registerConversationSource('ag-done', () => live);
    live = snap('final content'); // last mutation before the run ends
    manager.releaseConversationSource('ag-done');
    // The live source is gone: further mutation of the (now-orphaned)
    // variable must not change what's served.
    live = snap('mutated after release — must not leak through');
    expect(manager.getConversationSnapshot('ag-done')).toEqual(snap('final content'));
  });

  test('releaseConversationSource is a safe no-op for an agent that never registered a source (e.g. a WRFC owner)', () => {
    const manager = makeManager();
    expect(() => manager.releaseConversationSource('owner-never-ran-a-turn-loop')).not.toThrow();
    expect(manager.getConversationSnapshot('owner-never-ran-a-turn-loop')).toEqual([]);
  });

  test('releaseConversationSource is idempotent — a second release is a no-op, not a re-freeze', () => {
    const manager = makeManager();
    manager.registerConversationSource('ag-idem', () => snap('final'));
    manager.releaseConversationSource('ag-idem');
    expect(() => manager.releaseConversationSource('ag-idem')).not.toThrow();
    expect(manager.getConversationSnapshot('ag-idem')).toEqual(snap('final'));
  });

  test('a source that throws while live degrades to an empty array instead of throwing', () => {
    const manager = makeManager();
    manager.registerConversationSource('ag-throws', () => {
      throw new Error('conversation source exploded');
    });
    expect(() => manager.getConversationSnapshot('ag-throws')).not.toThrow();
    expect(manager.getConversationSnapshot('ag-throws')).toEqual([]);
  });

  test('a source that throws on release does not crash and freezes nothing', () => {
    const manager = makeManager();
    manager.registerConversationSource('ag-throws-release', () => {
      throw new Error('boom at release time');
    });
    expect(() => manager.releaseConversationSource('ag-throws-release')).not.toThrow();
    // Source removed from the live map either way; nothing was frozen.
    expect(manager.getConversationSnapshot('ag-throws-release')).toEqual([]);
  });

  test('bound respected: DEFAULT_CONVERSATION_SNAPSHOT_RETENTION is a positive, sane default', () => {
    expect(DEFAULT_CONVERSATION_SNAPSHOT_RETENTION).toBeGreaterThan(0);
  });

  test('bound respected: releasing more agents than the retention limit evicts the oldest first', () => {
    const manager = makeManager(2);
    manager.registerConversationSource('ag-1', () => snap('one'));
    manager.releaseConversationSource('ag-1');
    manager.registerConversationSource('ag-2', () => snap('two'));
    manager.releaseConversationSource('ag-2');
    // Ring is now full (size 2). Completing a third evicts ag-1 (oldest).
    manager.registerConversationSource('ag-3', () => snap('three'));
    manager.releaseConversationSource('ag-3');

    expect(manager.getConversationSnapshot('ag-1')).toEqual([]); // evicted
    expect(manager.getConversationSnapshot('ag-2')).toEqual(snap('two'));
    expect(manager.getConversationSnapshot('ag-3')).toEqual(snap('three'));
  });

  test('bound respected: re-completing an already-frozen agent refreshes its recency (does not double-count against the bound)', () => {
    const manager = makeManager(2);
    manager.registerConversationSource('ag-a', () => snap('a-first'));
    manager.releaseConversationSource('ag-a');
    manager.registerConversationSource('ag-b', () => snap('b'));
    manager.releaseConversationSource('ag-b');
    // ag-a runs again (e.g. re-spawned under the same id in a test harness)
    // and completes again — this should move it to "freshest", not create a
    // duplicate ring slot.
    manager.registerConversationSource('ag-a', () => snap('a-second'));
    manager.releaseConversationSource('ag-a');
    manager.registerConversationSource('ag-c', () => snap('c'));
    manager.releaseConversationSource('ag-c');

    // Ring bound is 2: ag-b should now be the oldest and get evicted, while
    // the refreshed ag-a survives alongside the newest, ag-c.
    expect(manager.getConversationSnapshot('ag-b')).toEqual([]);
    expect(manager.getConversationSnapshot('ag-a')).toEqual(snap('a-second'));
    expect(manager.getConversationSnapshot('ag-c')).toEqual(snap('c'));
  });

  test('clear() drops both live sources and the frozen retention ring', () => {
    const manager = makeManager();
    manager.registerConversationSource('ag-live', () => snap('live'));
    manager.registerConversationSource('ag-done', () => snap('done'));
    manager.releaseConversationSource('ag-done');
    manager.clear();
    expect(manager.getConversationSnapshot('ag-live')).toEqual([]);
    expect(manager.getConversationSnapshot('ag-done')).toEqual([]);
  });
});
