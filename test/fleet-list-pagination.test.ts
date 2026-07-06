/**
 * fleet-list-pagination.test.ts
 *
 * Finding 3 (Wave-3 review): `fleet.list`'s paginateItems call sorted nodes by
 * `id` but handed `startedAt` to paginateItems as the deleted-cursor recovery
 * key WITHOUT `{ descending }` matching that sort — the recovery key and the
 * array's actual order disagreed, so once a process is gc'd between page
 * fetches, the createdAt-based recovery walk (which assumes the array is
 * ordered by the field it's given) could resume at the wrong index: repeating
 * already-returned nodes or skipping unseen ones. The fix (routes/fleet.ts,
 * createFleetListHandler) sorts by startedAt DESC with an id tiebreak and
 * hands paginateItems that SAME startedAt extractor + `{ descending: true }`
 * — mirroring routes/session-search.ts's sortSessions-then-paginateItems
 * pattern (updatedAt desc, id asc tiebreak, `getCreatedAt: updatedAt`,
 * `{ descending: true }`).
 *
 * These tests drive `createFleetListHandler` directly against a fake
 * `FleetQueryOnlyRegistry` (the exact structural dependency the handler
 * declares) so a "process gc'd between pages" is just mutating the fake
 * registry's backing array between two handler calls — no real daemon, no
 * real process spawn needed.
 */
import { describe, expect, test } from 'bun:test';
import {
  createFleetListHandler,
  type FleetQueryOnlyRegistry,
} from '../packages/sdk/src/platform/control-plane/routes/fleet.js';
import type {
  FleetQueryFilter,
  FleetSnapshot,
  ProcessNode,
} from '../packages/sdk/src/platform/runtime/fleet/types.js';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.js';

function node(id: string, startedAt: number | undefined): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: id,
    state: 'thinking',
    startedAt,
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: {
      interruptible: false,
      killable: false,
      pausable: false,
      resumable: false,
      steerable: false,
    },
  };
}

/** A fake ProcessRegistry whose `query()` reads a mutable backing array — lets a test "gc" a node between two handler calls. */
function fakeRegistry(nodes: ProcessNode[]): FleetQueryOnlyRegistry {
  return {
    query(_filter?: FleetQueryFilter): FleetSnapshot {
      return { capturedAt: Date.now(), nodes: [...nodes] };
    },
  };
}

function invoke(body: Record<string, unknown>): GatewayMethodInvocation {
  return { body, context: {} };
}

interface FleetListResult {
  readonly items: readonly ProcessNode[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly capturedAt: number;
}

async function callFleetList(registry: FleetQueryOnlyRegistry, body: Record<string, unknown>): Promise<FleetListResult> {
  const handler = createFleetListHandler(registry);
  return (await handler(invoke(body))) as FleetListResult;
}

describe('fleet.list pagination — sort key and recovery key must agree (Finding 3)', () => {
  test('sorts newest-first by startedAt (not alphabetically by id)', async () => {
    // ids deliberately scrambled vs startedAt order, so an id-sorted array
    // would disagree with a startedAt-sorted array — proves which key is
    // actually driving the order.
    const nodes = [
      node('zebra', 500),
      node('apple', 400),
      node('mango', 300),
      node('kiwi', 200),
      node('banana', 100),
    ];
    const result = await callFleetList(fakeRegistry(nodes), { limit: 10 });
    expect(result.items.map((n) => n.id)).toEqual(['zebra', 'apple', 'mango', 'kiwi', 'banana']);
  });

  test('a node without startedAt sorts as if startedAt=0 (oldest), consistently between sort and recovery', async () => {
    const nodes = [node('has-time', 100), node('no-time', undefined)];
    const result = await callFleetList(fakeRegistry(nodes), { limit: 10 });
    expect(result.items.map((n) => n.id)).toEqual(['has-time', 'no-time']);
  });

  test('gc-between-pages: the cursor node disappearing before page 2 neither skips nor repeats a node', async () => {
    const nodes = [
      node('zebra', 500),
      node('apple', 400),
      node('mango', 300),
      node('kiwi', 200),
      node('banana', 100),
    ];
    const backing = [...nodes];
    const registry = fakeRegistry(backing);

    const page1 = await callFleetList(registry, { limit: 2 });
    expect(page1.items.map((n) => n.id)).toEqual(['zebra', 'apple']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    // Simulate the cursor's own node (apple, startedAt=400) being gc'd
    // between the two page fetches — the exact scenario the finding
    // describes ("a process is gc'd between pages").
    backing.splice(backing.findIndex((n) => n.id === 'apple'), 1);

    const page2 = await callFleetList(registry, { limit: 2, cursor: page1.nextCursor });

    // No skip: mango (the true next node after apple in startedAt order) must appear.
    expect(page2.items.map((n) => n.id)).toContain('mango');
    // No repeat: neither zebra nor apple (already served on page 1) may reappear.
    expect(page2.items.map((n) => n.id)).not.toContain('zebra');
    expect(page2.items.map((n) => n.id)).not.toContain('apple');
    expect(page2.items.map((n) => n.id)).toEqual(['mango', 'kiwi']);
  });

  test('gc-between-pages: removing a NOT-yet-returned node (not the cursor itself) still walks forward with no skip/repeat', async () => {
    const nodes = [
      node('n1', 500),
      node('n2', 400),
      node('n3', 300),
      node('n4', 200),
      node('n5', 100),
    ];
    const backing = [...nodes];
    const registry = fakeRegistry(backing);

    const page1 = await callFleetList(registry, { limit: 2 });
    expect(page1.items.map((n) => n.id)).toEqual(['n1', 'n2']);

    // gc n4 (not yet returned, not the cursor) between pages.
    backing.splice(backing.findIndex((n) => n.id === 'n4'), 1);

    const page2 = await callFleetList(registry, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((n) => n.id)).toEqual(['n3', 'n5']);
  });

  test('no gc: a plain multi-page walk visits every node exactly once', async () => {
    const nodes = Array.from({ length: 7 }, (_, i) => node(`p${i}`, 700 - i * 10));
    const registry = fakeRegistry(nodes);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await callFleetList(registry, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((n) => n.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(nodes.map((n) => n.id));
  });
});
