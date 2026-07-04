/**
 * Wave-5 (wo801, W5.1) — knowledge-injection.ts regression: extracting
 * `selectKnowledgeForTaskScored` out of `selectKnowledgeForTask` must not change
 * `selectKnowledgeForTask`'s observable output for any existing caller (spawn-time
 * injection in orchestrator-prompts.ts). This suite pins that contract and exercises
 * the new sibling's extra surface (unsliced, score-annotated) that turn-knowledge-
 * injection.ts depends on.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildKnowledgeInjectionPrompt,
  selectKnowledgeForTask,
  selectKnowledgeForTaskScored,
} from '../packages/sdk/src/platform/state/knowledge-injection.js';
import type { MemoryRecord } from '../packages/sdk/src/platform/state/memory-store.js';

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project',
    cls: 'fact',
    summary: 'a record',
    detail: undefined,
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRegistry(records: MemoryRecord[]) {
  return { getAll: () => records };
}

describe('knowledge-injection.ts — selectKnowledgeForTaskScored sibling (W5.1)', () => {
  test('selectKnowledgeForTask output is unchanged: same ids, order, and limit as before extraction', () => {
    const records = [
      makeRecord({ id: 'mem_a', summary: 'auth module uses JWT tokens', tags: ['auth'], reviewState: 'reviewed', confidence: 70 }),
      makeRecord({ id: 'mem_b', summary: 'unrelated deployment note', tags: ['deploy'], reviewState: 'fresh', confidence: 60 }),
      makeRecord({ id: 'mem_c', summary: 'auth module rate limiting', tags: ['auth'], reviewState: 'fresh', confidence: 65 }),
      makeRecord({ id: 'mem_d', summary: 'low confidence auth note', tags: ['auth'], confidence: 40 }), // filtered: confidence<55
      makeRecord({ id: 'mem_e', summary: 'contradicted auth note', tags: ['auth'], reviewState: 'contradicted', confidence: 90 }), // filtered: contradicted => score=-Infinity
    ];
    const registry = makeRegistry(records);

    // limit=2: mem_a (70 confidence +40 reviewed +20 "auth" +20 "module" = 150) beats
    // mem_c (65 +20 fresh +20 +20 = 125) beats mem_b (60 +20 fresh, no task-token match
    // = 80 — still score>0, since confidence+reviewState alone clears that gate, but it
    // is what the LIMIT slice excludes here, not the score>0 filter).
    const result = selectKnowledgeForTask(registry, 'fix the auth module', [], 2);

    expect(result.map((entry) => entry.id)).toEqual(['mem_a', 'mem_c']);
    expect(result).toHaveLength(2);
    expect(result[0]!.trustTier).toBe('reviewed');
    expect(result[0]!.useAs).toBe('reference-material');
    expect(result[0]!.retention).toBe('task-only');
  });

  test('selectKnowledgeForTaskScored returns the exact same records with scores attached, unsliced', () => {
    const records = [
      makeRecord({ id: 'mem_a', summary: 'auth module uses JWT tokens', tags: ['auth'], reviewState: 'reviewed', confidence: 70 }),
      makeRecord({ id: 'mem_c', summary: 'auth module rate limiting', tags: ['auth'], reviewState: 'fresh', confidence: 65 }),
      makeRecord({ id: 'mem_f', summary: 'auth module caching layer', tags: ['auth'], reviewState: 'fresh', confidence: 58 }),
      makeRecord({ id: 'mem_g', summary: 'auth module retry policy', tags: ['auth'], reviewState: 'fresh', confidence: 56 }),
    ];
    const registry = makeRegistry(records);

    // limit=2 only widens semantic-search candidate breadth; the scored sibling must
    // still return every candidate with score>0, not just the top 2.
    const scored = selectKnowledgeForTaskScored(registry, 'fix the auth module', [], 2);
    expect(scored.length).toBe(4);
    expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_a', 'mem_c', 'mem_f', 'mem_g']);
    // sorted best-first
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score);
    }

    // selectKnowledgeForTask must be exactly this list, mapped to injections, sliced to limit.
    const sliced = selectKnowledgeForTask(registry, 'fix the auth module', [], 2);
    expect(sliced).toEqual(scored.slice(0, 2).map((entry) => entry.injection));
  });

  test('empty registry / no matches produces an empty array from both functions', () => {
    const registry = makeRegistry([]);
    expect(selectKnowledgeForTask(registry, 'anything', [], 3)).toEqual([]);
    expect(selectKnowledgeForTaskScored(registry, 'anything', [], 3)).toEqual([]);
    expect(buildKnowledgeInjectionPrompt([])).toBeNull();
  });

  test('write scope tokens contribute to scoring for both functions identically', () => {
    const records = [
      makeRecord({ id: 'mem_scope', summary: 'notes about src/auth/login.ts', tags: [], reviewState: 'fresh', confidence: 60 }),
    ];
    const registry = makeRegistry(records);
    const scored = selectKnowledgeForTaskScored(registry, 'unrelated task text', ['src/auth/login.ts'], 3);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.injection.reason).toContain('write scope');

    const sliced = selectKnowledgeForTask(registry, 'unrelated task text', ['src/auth/login.ts'], 3);
    expect(sliced).toEqual(scored.map((entry) => entry.injection));
  });
});
