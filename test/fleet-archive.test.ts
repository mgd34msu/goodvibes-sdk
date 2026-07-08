/**
 * Behavior pins for withFleetArchive — finished agent/swarm subtrees move out
 * of the live fleet view into a session-scoped archive, stay inspectable via
 * listArchived(), and running work can never be archived.
 */
import { describe, expect, test } from 'bun:test';
import { withFleetArchive } from '../packages/sdk/src/platform/runtime/fleet/archive.js';
import type {
  FleetSnapshot,
  ProcessNode,
  ProcessRegistry,
  ProcessState,
} from '../packages/sdk/src/platform/runtime/fleet/types.js';

function makeNode(id: string, state: ProcessState, parentId?: string): ProcessNode {
  return {
    id,
    kind: 'agent',
    ...(parentId !== undefined ? { parentId } : {}),
    label: id,
    state,
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  };
}

interface FakeRegistry {
  registry: ProcessRegistry;
  setNodes(nodes: ProcessNode[]): void;
  fireTick(): void;
  disposed: () => boolean;
}

function makeFakeRegistry(initial: ProcessNode[]): FakeRegistry {
  let nodes = initial;
  let disposed = false;
  const listeners = new Set<(snapshot: FleetSnapshot) => void>();
  const snapshot = (): FleetSnapshot => ({ capturedAt: 1, nodes });
  const registry: ProcessRegistry = {
    query: () => snapshot(),
    getNode: (id) => nodes.find((n) => n.id === id) ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interrupt: () => false,
    resume: () => false,
    kill: () => [],
    steer: () => ({ queued: false, reason: 'fake' }),
    dispose: () => { disposed = true; },
  };
  return {
    registry,
    setNodes: (next) => { nodes = next; },
    fireTick: () => { for (const l of listeners) l(snapshot()); },
    disposed: () => disposed,
  };
}

describe('withFleetArchive', () => {
  test('archiving a finished subtree hides it from query() and surfaces it in listArchived()', () => {
    const fake = makeFakeRegistry([
      makeNode('chain', 'done'),
      makeNode('member-1', 'done', 'chain'),
      makeNode('member-2', 'failed', 'chain'),
      makeNode('live', 'thinking'),
    ]);
    const archived = withFleetArchive(fake.registry);

    const result = archived.archive('chain');
    expect(result.archived).toBe(true);
    expect(result.count).toBe(3);

    expect(archived.query().nodes.map((n) => n.id)).toEqual(['live']);
    expect(archived.listArchived().nodes.map((n) => n.id).sort()).toEqual(['chain', 'member-1', 'member-2']);
    expect(archived.archivedCount()).toBe(3);
  });

  test('a subtree with a running member is refused with an honest reason', () => {
    const fake = makeFakeRegistry([
      makeNode('chain', 'done'),
      makeNode('member', 'executing-tool', 'chain'),
    ]);
    const archived = withFleetArchive(fake.registry);

    const result = archived.archive('chain');
    expect(result.archived).toBe(false);
    expect(result.count).toBe(0);
    expect(result.reason).toContain('still active');
    expect(archived.query().nodes).toHaveLength(2);
  });

  test('archiving an unknown id is refused', () => {
    const archived = withFleetArchive(makeFakeRegistry([]).registry);
    const result = archived.archive('ghost');
    expect(result.archived).toBe(false);
    expect(result.reason).toContain('not found');
  });

  test('archiveFinished() archives every all-terminal root subtree, leaving live swarms intact', () => {
    const fake = makeFakeRegistry([
      makeNode('done-root', 'done'),
      makeNode('done-child', 'killed', 'done-root'),
      makeNode('live-root', 'thinking'),
      makeNode('finished-under-live', 'done', 'live-root'),
      makeNode('failed-root', 'failed'),
    ]);
    const archived = withFleetArchive(fake.registry);

    expect(archived.archiveFinished()).toBe(3); // done-root + done-child + failed-root
    const remaining = archived.query().nodes.map((n) => n.id).sort();
    // The finished member of a still-running swarm stays with its parent.
    expect(remaining).toEqual(['finished-under-live', 'live-root']);
  });

  test('unarchive() returns the subtree to the live view', () => {
    const fake = makeFakeRegistry([
      makeNode('chain', 'done'),
      makeNode('member', 'done', 'chain'),
    ]);
    const archived = withFleetArchive(fake.registry);
    archived.archive('chain');
    expect(archived.query().nodes).toHaveLength(0);

    expect(archived.unarchive('chain')).toBe(2);
    expect(archived.query().nodes).toHaveLength(2);
    expect(archived.archivedCount()).toBe(0);
  });

  test('subscribers receive filtered snapshots, and archive mutations notify immediately', () => {
    const fake = makeFakeRegistry([
      makeNode('finished', 'done'),
      makeNode('live', 'thinking'),
    ]);
    const archived = withFleetArchive(fake.registry);
    const seen: string[][] = [];
    archived.subscribe((snapshot) => { seen.push(snapshot.nodes.map((n) => n.id)); });

    fake.fireTick();
    expect(seen.at(-1)).toEqual(['finished', 'live']);

    archived.archive('finished');
    expect(seen.at(-1)).toEqual(['live']);
  });

  test('getNode still resolves archived nodes (they stay inspectable)', () => {
    const fake = makeFakeRegistry([makeNode('finished', 'done')]);
    const archived = withFleetArchive(fake.registry);
    archived.archive('finished');
    expect(archived.getNode('finished')?.id).toBe('finished');
  });

  test('dispose() clears listeners and disposes the underlying registry', () => {
    const fake = makeFakeRegistry([]);
    const archived = withFleetArchive(fake.registry);
    archived.subscribe(() => {});
    archived.dispose();
    expect(fake.disposed()).toBe(true);
  });
});
