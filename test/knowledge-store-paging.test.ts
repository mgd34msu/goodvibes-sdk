/**
 * knowledge-store-paging.test.ts
 *
 * Item 3 guard: the store exposes bounded, offset-paged reads so a single
 * self-improvement run's distinct-space discovery never materializes the whole
 * store at once. Pins that each page is capped to its limit and that an ascending
 * offset loop still visits every record (so behavior is unchanged).
 */
import { describe, expect, test } from 'bun:test';
import { getKnowledgeSpaceId } from '../packages/sdk/src/platform/knowledge/spaces.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

describe('knowledge store bounded paging', () => {
  test('listSourcesPage caps each page and an offset loop visits every source', async () => {
    const { store } = createStores();
    const spaces = ['space-a', 'space-b', 'space-c'];
    const total = 7;
    for (let i = 0; i < total; i++) {
      await store.upsertSource({
        connectorId: 'test',
        sourceType: 'document',
        title: `doc-${i}`,
        canonicalUri: `test://doc/${i}`,
        status: 'indexed',
        metadata: { knowledgeSpaceId: spaces[i % spaces.length] },
      });
    }

    // Each page is bounded to its limit.
    expect(store.listSourcesPage(0, 3).length).toBe(3);
    expect(store.listSourcesPage(6, 3).length).toBe(1); // tail is short
    expect(store.listSourcesPage(total, 3).length).toBe(0); // past the end

    // The ascending-offset loop collects every record exactly once.
    const seen = new Set<string>();
    const discoveredSpaces = new Set<string>();
    const page = 2;
    for (let offset = 0; ; offset += page) {
      const rows = store.listSourcesPage(offset, page);
      expect(rows.length).toBeLessThanOrEqual(page);
      for (const row of rows) {
        seen.add(row.id);
        discoveredSpaces.add(getKnowledgeSpaceId(row));
      }
      if (rows.length < page) break;
    }
    expect(seen.size).toBe(total);
    expect([...discoveredSpaces].sort()).toEqual(spaces);
  });

  test('listNodesPage pages nodes the same way', async () => {
    const { store } = createStores();
    for (let i = 0; i < 5; i++) {
      await store.upsertNode({
        kind: 'fact',
        slug: `fact-${i}`,
        title: `fact-${i}`,
        confidence: 50,
        metadata: { knowledgeSpaceId: i < 3 ? 'space-x' : 'space-y' },
      });
    }
    expect(store.listNodesPage(0, 2).length).toBe(2);
    expect(store.listNodesPage(4, 2).length).toBe(1);
    const spaces = new Set<string>();
    for (let offset = 0; ; offset += 2) {
      const rows = store.listNodesPage(offset, 2);
      for (const row of rows) spaces.add(getKnowledgeSpaceId(row));
      if (rows.length < 2) break;
    }
    expect([...spaces].sort()).toEqual(['space-x', 'space-y']);
  });
});
