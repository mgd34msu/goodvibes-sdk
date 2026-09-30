/**
 * knowledge-jobruns-retention.test.ts
 *
 * The job-run history is bounded in memory AND on disk: settled runs beyond the
 * cap are pruned oldest-first (active runs never pruned), the cap holds across
 * a store reload (restart), and the MemoryGovernor trim hook actually reclaims.
 * Companion gate: every background self-improvement trigger routes through the
 * governed scheduler, no caller bypasses it with a direct scheduleBackground
 * self-improve.
 */
import { describe, expect, test } from 'bun:test';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

describe('job-run history retention (bounded memory + disk)', () => {
  test('settled runs beyond the cap are pruned; active runs survive; reload stays bounded', async () => {
    const { store } = createStores();
    await store.init();
    // 520 settled runs + 3 active ones.
    for (let i = 0; i < 520; i++) {
      await store.upsertJobRun({ jobId: `job-${i % 5}`, status: 'completed', mode: 'background', result: {}, metadata: {} });
    }
    const active: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await store.upsertJobRun({ jobId: 'job-live', status: 'running', mode: 'background', result: {}, metadata: {} });
      active.push(run.id);
    }
    const retained = store.listJobRuns(10_000);
    expect(retained.length).toBeLessThanOrEqual(503); // cap (500) + the 3 active
    for (const id of active) {
      expect(retained.some((r) => r.id === id)).toBe(true); // active never pruned
    }
    // The MemoryGovernor trim reclaims down to its floor, keeping active runs.
    store.pruneJobRuns(10);
    const afterTrim = store.listJobRuns(10_000);
    expect(afterTrim.length).toBeLessThanOrEqual(13);
    for (const id of active) expect(afterTrim.some((r) => r.id === id)).toBe(true);
  });

  test('the cap holds across a reload (no accretion across restarts)', async () => {
    const { store } = createStores();
    await store.init();
    for (let i = 0; i < 600; i++) {
      await store.upsertJobRun({ jobId: 'job-a', status: 'completed', mode: 'background', result: {}, metadata: {} });
    }
    const dbPath = (store as unknown as { sqlite: { dbPath: string } }).sqlite.dbPath;
    const reloaded = new KnowledgeStore({ dbPath });
    await reloaded.init();
    expect(reloaded.listJobRuns(10_000).length).toBeLessThanOrEqual(500);
  });
});
