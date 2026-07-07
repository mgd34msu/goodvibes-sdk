import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { KnowledgeService } from '../packages/sdk/src/platform/knowledge/service.js';
import { KnowledgeSemanticService } from '../packages/sdk/src/platform/knowledge/semantic/service.js';
import type { KnowledgeSemanticLlm } from '../packages/sdk/src/platform/knowledge/semantic/types.js';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { HomeGraphService } from '../packages/sdk/src/platform/knowledge/home-graph/service.js';
import { isRepairedAnswerGap } from '../packages/sdk/src/platform/knowledge/semantic/answer-gaps.js';
import { resetHomeGraphSpace } from '../packages/sdk/src/platform/knowledge/home-graph/reset.js';
import { homeAssistantKnowledgeSpaceId, knowledgeSpaceMetadata } from '../packages/sdk/src/platform/knowledge/spaces.js';
import type { KnowledgeNodeRecord } from '../packages/sdk/src/platform/knowledge/types.js';
import { createDaemonKnowledgeRouteHandlers } from '../packages/daemon-sdk/dist/index.js';
import type { DaemonKnowledgeRouteContext } from '../packages/daemon-sdk/dist/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(dbFileName = 'knowledge.sqlite', extra: Record<string, unknown> = {}): KnowledgeStore {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-wiki-honesty-'));
  tmpRoots.push(root);
  return new KnowledgeStore({ dbPath: join(root, dbFileName), ...extra });
}

function createStores(): { store: KnowledgeStore; artifactStore: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-wiki-honesty-'));
  tmpRoots.push(root);
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge-home-graph.sqlite'), family: 'home-graph' }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  };
}

function reviewState(node: KnowledgeNodeRecord | undefined): string | undefined {
  const provenance = node?.metadata.reviewProvenance;
  return provenance && typeof provenance === 'object' ? (provenance as Record<string, unknown>).state as string : undefined;
}

describe('knowledge wiki honesty — revision history (Defect 1)', () => {
  test('every content-changing upsert preserves prior content and records what changed', async () => {
    const store = createStore();
    await store.upsertNode({ kind: 'topic', slug: 'widget', title: 'Widget', summary: 'First summary', confidence: 90 });
    const created = store.getNodeByKindAndSlug('topic', 'widget')!;
    await store.upsertNode({ id: created.id, kind: 'topic', slug: 'widget', title: 'Widget Pro', summary: 'Second summary', confidence: 90 });

    const revisions = store.listNodeRevisions(created.id);
    expect(revisions.length).toBe(2);
    expect(revisions[0]!.changeKind).toBe('create');
    expect(revisions[0]!.title).toBe('Widget');
    expect(revisions[0]!.summary).toBe('First summary');
    expect(revisions[1]!.changeKind).toBe('update');
    expect(revisions[1]!.title).toBe('Widget Pro');
    expect(revisions[1]!.changedFields).toEqual(expect.arrayContaining(['title', 'summary']));
    // prior content is retained, not silently overwritten
    expect(revisions.some((rev) => rev.title === 'Widget' && rev.summary === 'First summary')).toBe(true);
  });

  test('an idempotent re-upsert (no content change) records no new revision', async () => {
    const store = createStore();
    const node = await store.upsertNode({ kind: 'topic', slug: 'stable', title: 'Stable', confidence: 90 });
    await store.upsertNode({ id: node.id, kind: 'topic', slug: 'stable', title: 'Stable', confidence: 90 });
    expect(store.listNodeRevisions(node.id).length).toBe(1);
  });

  test('a slug-only identity change records a revision listing slug — the prior slug is not lost (Finding 3)', async () => {
    const store = createStore();
    // Everything identical except the slug: an id-based upsert that renames the slug.
    const created = await store.upsertNode({ kind: 'topic', slug: 'old-slug', title: 'Widget', summary: 'S', confidence: 90 });
    await store.upsertNode({ id: created.id, kind: 'topic', slug: 'new-slug', title: 'Widget', summary: 'S', confidence: 90 });

    const revisions = store.listNodeRevisions(created.id);
    // Before the fix diffKnowledgeNodeFields never compared slug, so changedFields
    // was [] → the early return recorded NO revision (length 1, the create alone),
    // silently dropping the prior slug from history.
    expect(revisions.length).toBe(2);
    expect(revisions[1]!.changeKind).toBe('update');
    expect(revisions[1]!.changedFields).toContain('slug');
    expect(revisions[1]!.slug).toBe('new-slug');
    expect(revisions.some((rev) => rev.slug === 'old-slug')).toBe(true);
  });

  test('a kind-only identity change records a revision listing kind (Finding 3)', async () => {
    const store = createStore();
    const created = await store.upsertNode({ kind: 'topic', slug: 'k', title: 'K', confidence: 90 });
    await store.upsertNode({ id: created.id, kind: 'concept', slug: 'k', title: 'K', confidence: 90 });
    const revisions = store.listNodeRevisions(created.id);
    expect(revisions.length).toBe(2);
    expect(revisions[1]!.changedFields).toContain('kind');
  });
});

describe('knowledge wiki honesty — confidence scale + non-finite guard (Findings 4 & 5)', () => {
  test('a non-finite (NaN) confidence resolves to the auto-accept default, never a silent draft (Finding 5)', async () => {
    const store = createStore();
    // NaN slips past `??` (which only catches null/undefined); before the fix the
    // inline min/max left confidence = NaN and `NaN >= autoAccept` is false → draft.
    const node = await store.upsertNode({ kind: 'topic', slug: 'nanconf', title: 'NaN conf', confidence: Number.NaN });
    expect(Number.isFinite(node.confidence)).toBe(true);
    expect(node.confidence).toBe(40); // DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE
    expect(node.status).toBe('active');
  });

  test('an LLM that answers confidence as a 0-1 probability scales to 0-100, so a strong node is not held as a draft (Finding 4)', async () => {
    const store = createStore();
    const source = await store.upsertSource({
      connectorId: 'manual', sourceType: 'manual', title: 'Widget manual',
      canonicalUri: 'manual://widget', tags: ['manual'], status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id, extractorId: 'manual', format: 'text', sections: ['Features'],
      structure: { searchText: 'The Widget supports HDMI, Bluetooth, and a rechargeable battery for portable use.' },
    });

    // A model that ignores the 0-100 contract and emits a 0-1 probability for a
    // high-confidence entity.
    const probabilityLlm: KnowledgeSemanticLlm = {
      async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
        if (input.purpose !== 'knowledge-semantic-enrichment') return null;
        return {
          summary: 'Widget capabilities.',
          entities: [{ title: 'Widget', kind: 'device', aliases: [], summary: 'A portable widget.', confidence: 0.9 }],
          facts: [],
          relations: [],
          gaps: [],
        };
      },
      async completeText(): Promise<string | null> { return null; },
    };
    const semantic = new KnowledgeSemanticService(store, { llm: probabilityLlm });
    const result = await semantic.enrichSource(source.id, { force: true });

    expect(result?.extractor).toBe('llm');
    const entity = result?.entities.find((node) => node.title === 'Widget');
    expect(entity).toBeDefined();
    // Before the fix: clampConfidence(round(0.9)) = 1 → below the auto-accept floor →
    // draft. After: 0.9 is recognized as a probability and scaled to 90 → active.
    expect(entity!.confidence).toBe(90);
    expect(entity!.status).toBe('active');
  });
});

describe('knowledge wiki honesty — review gate (Defect 2)', () => {
  test('a low-confidence synthesized node is held as draft with pending-review provenance', async () => {
    const store = createStore('knowledge-wiki.sqlite', { family: 'wiki' });
    const node = await store.upsertNode({ kind: 'topic', slug: 'weak', title: 'Weak', confidence: 20 });
    expect(node.status).toBe('draft');
    expect(reviewState(node)).toBe('pending-review');
  });

  test('a high-confidence node auto-accepts with honest provenance', async () => {
    const store = createStore();
    const node = await store.upsertNode({ kind: 'topic', slug: 'strong', title: 'Strong', confidence: 90 });
    expect(node.status).toBe('active');
    expect(reviewState(node)).toBe('auto-accepted');
  });

  test('a configurable higher threshold holds an otherwise-default node for review', async () => {
    const store = createStore('knowledge.sqlite', { nodeAutoAcceptConfidence: 95 });
    const node = await store.upsertNode({ kind: 'topic', slug: 'mid', title: 'Mid', confidence: 70 });
    expect(node.status).toBe('draft');
    expect(reviewState(node)).toBe('pending-review');
  });

  test('an already-active node stays active and is labelled pre-gate on the first restamp', async () => {
    const store = createStore();
    // seed an active node directly (simulating a pre-gate migration record)
    await store.replaceNodeRecord({
      id: 'legacy-1', kind: 'topic', slug: 'legacy', title: 'Legacy', aliases: [], status: 'active',
      confidence: 10, metadata: {}, createdAt: 1, updatedAt: 1,
    });
    const updated = await store.upsertNode({ id: 'legacy-1', kind: 'topic', slug: 'legacy', title: 'Legacy v2', confidence: 10 });
    expect(updated.status).toBe('active');
    expect(reviewState(updated)).toBe('pre-gate');
  });

  test('reviewNode accepts a draft into active with reviewed provenance', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    const draft = await store.upsertNode({ kind: 'topic', slug: 'candidate', title: 'Candidate', confidence: 10 });
    expect(draft.status).toBe('draft');
    const result = await service.reviewNode({ id: draft.id, decision: 'accept', reviewer: 'operator' });
    expect(result.ok).toBe(true);
    expect(result.node?.status).toBe('active');
    expect(reviewState(result.node)).toBe('reviewed');
  });

  test('draft nodes are not served by search', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    const draft = await store.upsertNode({ kind: 'topic', slug: 'zephyr-draft', title: 'Zephyr draft note', confidence: 10 });
    const active = await store.upsertNode({ kind: 'topic', slug: 'zephyr-active', title: 'Zephyr active note', confidence: 90 });
    const ids = service.search('zephyr', 20).map((hit) => hit.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(draft.id);
  });
});

describe('knowledge wiki honesty — fabricated answer-gap evidence (Defect 3)', () => {
  const base: KnowledgeNodeRecord = {
    id: 'gap-1', kind: 'knowledge_gap', slug: 'g', title: 'g', aliases: [], status: 'active',
    confidence: 70, metadata: {}, createdAt: 1, updatedAt: 1,
  };

  test('a merely stale gap is NOT treated as repaired', () => {
    expect(isRepairedAnswerGap({ ...base, status: 'stale' })).toBe(false);
  });

  test('a not_applicable gap is NOT treated as repaired', () => {
    expect(isRepairedAnswerGap({ ...base, metadata: { repairStatus: 'not_applicable' } })).toBe(false);
  });

  test('a gap is repaired only with real promoted-fact or accepted-source evidence', () => {
    expect(isRepairedAnswerGap({ ...base, metadata: { repairStatus: 'repaired' } })).toBe(false);
    expect(isRepairedAnswerGap({ ...base, metadata: { repairStatus: 'repaired', promotedFactCount: 2 } })).toBe(true);
    expect(isRepairedAnswerGap({ ...base, metadata: { repairStatus: 'repaired', acceptedSourceIds: ['src-1'] } })).toBe(true);
  });
});

describe('knowledge wiki honesty — mergeNodes re-points edges (Defect 5)', () => {
  test('merging re-points cross-reference edges onto the survivor and marks the loser', async () => {
    const store = createStore();
    const winner = await store.upsertNode({ kind: 'topic', slug: 'winner', title: 'Winner', confidence: 90 });
    const loser = await store.upsertNode({ kind: 'topic', slug: 'loser', title: 'Loser', confidence: 90 });
    const other = await store.upsertNode({ kind: 'topic', slug: 'other', title: 'Other', confidence: 90 });
    await store.upsertEdge({ fromKind: 'node', fromId: other.id, toKind: 'node', toId: loser.id, relation: 'references' });

    const result = await store.mergeNodes(loser.id, winner.id);
    expect(result.merged).toBe(true);
    expect(result.repointedEdges).toBeGreaterThan(0);

    const edges = store.listEdges();
    expect(edges.some((e) => e.fromId === other.id && e.toId === winner.id && e.relation === 'references')).toBe(true);
    expect(edges.some((e) => e.toId === loser.id && e.relation === 'references')).toBe(false);
    expect(edges.some((e) => e.fromId === loser.id && e.toId === winner.id && e.relation === 'merged_into')).toBe(true);
    const merged = store.getNode(loser.id)!;
    expect(merged.status).toBe('stale');
    expect(merged.metadata.mergedInto).toBe(winner.id);
  });
});

describe('knowledge wiki honesty — honest hard delete and forget filter (Defect 6)', () => {
  test('queryNodes hides forgotten (stale) nodes by default but returns them on request', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    const node = await store.upsertNode({ kind: 'topic', slug: 'forgettable', title: 'Forgettable', confidence: 90 });
    await store.upsertNode({ id: node.id, kind: 'topic', slug: 'forgettable', title: 'Forgettable', status: 'stale', confidence: 90 });
    expect(service.queryNodes({ limit: 100 }).items.map((n) => n.id)).not.toContain(node.id);
    expect(service.queryNodes({ limit: 100, includeStale: true }).items.map((n) => n.id)).toContain(node.id);
  });

  test('deleteNode is an honest hard delete that also purges revision history', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    const node = await store.upsertNode({ kind: 'topic', slug: 'gone', title: 'Gone', confidence: 90 });
    expect(store.listNodeRevisions(node.id).length).toBeGreaterThan(0);
    const result = await service.deleteNode(node.id);
    expect(result.deleted).toBe(true);
    expect(store.getNode(node.id)).toBeNull();
    expect(store.listNodeRevisions(node.id).length).toBe(0);
    // honest on unknown id
    expect((await service.deleteNode('nope')).deleted).toBe(false);
  });
});

describe('knowledge wiki honesty — delete cascades refinement tasks (Defect 7)', () => {
  test('deleting a node removes refinement tasks that reference it', async () => {
    const store = createStore();
    const node = await store.upsertNode({ kind: 'topic', slug: 'subject', title: 'Subject', confidence: 90 });
    await store.upsertRefinementTask({
      spaceId: 'default', subjectKind: 'node', subjectId: node.id, state: 'pending', trigger: 'manual',
    });
    expect(store.listRefinementTasks(100).some((t) => t.subjectId === node.id)).toBe(true);
    await store.deleteNode(node.id);
    expect(store.listRefinementTasks(100).some((t) => t.subjectId === node.id)).toBe(false);
  });
});

describe('knowledge wiki honesty — packet truncation disclosure (Defect 9)', () => {
  test('a packet that drops candidates over the limit reports it honestly', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    for (let i = 0; i < 8; i += 1) {
      await store.upsertSource({
        connectorId: 'manual', sourceType: 'document', title: `Widget manual ${i}`,
        canonicalUri: `manual://widget-${i}`, summary: 'widget calibration guide', tags: ['widget'], status: 'indexed',
      });
    }
    // A generous token budget so the ITEM CAP (not the budget) is what drops
    // candidates — droppedForBudget must be 0 and budgetExhausted false.
    const truncated = await service.buildPacket('widget', [], 2, { budgetLimit: 100_000 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.droppedCount).toBeGreaterThan(0);
    expect(truncated.totalCandidates).toBeGreaterThan(truncated.items.length);
    expect(truncated.totalCandidates).toBe(truncated.items.length + truncated.droppedCount);
    expect(truncated.droppedForBudget).toBe(0);
    expect(truncated.budgetExhausted).toBe(false);

    const complete = await service.buildPacket('widget', [], 50);
    expect(complete.truncated).toBe(false);
    expect(complete.droppedCount).toBe(0);
    expect(complete.droppedForBudget).toBe(0);
    expect(complete.budgetExhausted).toBe(false);
  });

  test('a packet whose token budget binds distinguishes budget-drops from rank-cap drops', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    for (let i = 0; i < 8; i += 1) {
      await store.upsertSource({
        connectorId: 'manual', sourceType: 'document', title: `Widget manual ${i}`,
        canonicalUri: `manual://widget-${i}`,
        summary: 'widget calibration guide with a summary long enough to consume token budget when several are combined',
        tags: ['widget'], status: 'indexed',
      });
    }
    // A high item limit but a tiny token budget: the budget is the binding
    // constraint, so at least one candidate is dropped FOR BUDGET, and
    // budgetExhausted is true. The first item always fits (never budget-dropped).
    const packet = await service.buildPacket('widget', [], 50, { budgetLimit: 90 });
    expect(packet.items.length).toBeGreaterThanOrEqual(1);
    expect(packet.budgetExhausted).toBe(true);
    expect(packet.droppedForBudget).toBeGreaterThan(0);
    // droppedForBudget is a subset of the honest total droppedCount.
    expect(packet.droppedCount).toBeGreaterThanOrEqual(packet.droppedForBudget);
  });

  test('the knowledge.packet wire schema exposes the truncation disclosure fields', async () => {
    const { KNOWLEDGE_PACKET_SCHEMA } = await import(
      '../packages/sdk/src/platform/control-plane/operator-contract-schemas-knowledge.js'
    );
    const schema = KNOWLEDGE_PACKET_SCHEMA as { properties?: Record<string, unknown>; required?: string[] };
    for (const field of ['truncated', 'totalCandidates', 'droppedCount', 'droppedForBudget', 'budgetExhausted']) {
      expect(field in (schema.properties ?? {})).toBe(true);
      expect(schema.required ?? []).toContain(field);
    }
  });
});

describe('knowledge wiki honesty — unlink is a real reversal (unlink sub-defect)', () => {
  test('unlinking a never-linked target creates no phantom node or edge', async () => {
    const { store, artifactStore } = createStores();
    const service = new HomeGraphService(store, artifactStore);
    await service.syncSnapshot({ installationId: 'house', devices: [{ id: 'tv', name: 'TV' }] });
    const source = (await service.ingestNote({
      installationId: 'house', title: 'Note', body: 'A note body long enough to index.',
    })).source;
    const nodesBefore = store.listNodes(100_000).length;
    const edgesBefore = store.listEdges().length;

    const result = await service.unlinkKnowledge({
      installationId: 'house', sourceId: source.id, target: { kind: 'device', id: 'never-linked-device' },
    });
    expect(result.reversed).toBe(false);
    expect(store.listNodes(100_000).length).toBe(nodesBefore);
    expect(store.listEdges().length).toBe(edgesBefore);
  });
});

describe('knowledge wiki honesty — shared artifact reset does not orphan foreign blobs (Hazard H1)', () => {
  test('home-graph reset preserves a blob owned by another knowledge family', async () => {
    const { store, artifactStore } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    // A blob owned by the general wiki (default space), referenced by a home-graph source.
    const wikiBlob = await artifactStore.create({ text: 'shared bytes', filename: 'shared.txt', mimeType: 'text/plain', metadata: knowledgeSpaceMetadata('default') });
    // A blob owned by home-graph.
    const hgBlob = await artifactStore.create({ text: 'home graph bytes', filename: 'hg.txt', mimeType: 'text/plain', metadata: knowledgeSpaceMetadata(spaceId) });
    await store.upsertSource({
      connectorId: 'homeassistant', sourceType: 'document', title: 'HG source referencing shared blob',
      canonicalUri: 'ha://shared', status: 'indexed', artifactId: wikiBlob.id, metadata: knowledgeSpaceMetadata(spaceId),
    });
    await store.upsertSource({
      connectorId: 'homeassistant', sourceType: 'document', title: 'HG source with own blob',
      canonicalUri: 'ha://own', status: 'indexed', artifactId: hgBlob.id, metadata: knowledgeSpaceMetadata(spaceId),
    });

    await resetHomeGraphSpace(store, artifactStore, { installationId: 'house' });

    expect(artifactStore.get(wikiBlob.id)).not.toBeNull();
    expect(artifactStore.get(hgBlob.id)).toBeNull();
  });
});

describe('knowledge wiki honesty — forgotten nodes are not served over the wire (Defect 6)', () => {
  test('the GET /api/knowledge/nodes route excludes a forgotten (stale) node by default', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {});
    const kept = await store.upsertNode({ kind: 'topic', slug: 'served', title: 'Served', confidence: 90 });
    const forgotten = await store.upsertNode({ kind: 'topic', slug: 'forgotten', title: 'Forgotten', confidence: 90 });
    await store.upsertNode({ id: forgotten.id, kind: 'topic', slug: 'forgotten', title: 'Forgotten', status: 'stale', confidence: 90 });

    // The route handler serves whatever knowledgeService.queryNodes returns; only
    // queryNodes is exercised by this route, so the rest of the context is stubbed.
    const handlers = createDaemonKnowledgeRouteHandlers({
      knowledgeService: { queryNodes: (input: Parameters<KnowledgeService['queryNodes']>[0]) => service.queryNodes(input) },
    } as unknown as DaemonKnowledgeRouteContext);
    const response = await handlers.getKnowledgeNodes(new URL('http://localhost/api/knowledge/nodes'));
    const body = await response.json() as { nodes: KnowledgeNodeRecord[] };
    const ids = body.nodes.map((n) => n.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(forgotten.id);
  });
});

describe('knowledge wiki honesty — constructor family assert', () => {
  test('a mis-wired db file for a declared family fails loudly', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-wiki-honesty-'));
    tmpRoots.push(root);
    expect(() => new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite'), family: 'home-graph' })).toThrow(/family mismatch/i);
    expect(() => new KnowledgeStore({ dbPath: join(root, 'knowledge-home-graph.sqlite'), family: 'home-graph' })).not.toThrow();
  });
});
