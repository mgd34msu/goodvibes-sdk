/**
 * knowledge-jobruns-retention.test.ts
 *
 * The job-run history is bounded in memory AND on disk: settled runs beyond the
 * cap are pruned oldest-first (active runs never pruned), the cap holds across
 * a store reload (restart), and the MemoryGovernor trim hook actually reclaims.
 * Companion gate: every background self-improvement trigger routes through the
 * governed scheduler — no caller bypasses it with a direct scheduleBackground
 * self-improve.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

describe('job-run history retention (bounded memory + disk)', () => {
  test('settled runs beyond the cap are pruned; active runs survive; reload stays bounded', async () => {
    const { store } = createStores();
    await store.init();
    // 520 settled runs + 3 active ones.
    for (let i = 0; i < 520; i++) {
      await store.upsertJobRun({ jobId: `job-${i % 5}`, status: 'completed', mode: 'incremental', result: {}, metadata: {} });
    }
    const active: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await store.upsertJobRun({ jobId: 'job-live', status: 'running', mode: 'incremental', result: {}, metadata: {} });
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
      await store.upsertJobRun({ jobId: 'job-a', status: 'completed', mode: 'incremental', result: {}, metadata: {} });
    }
    const dbPath = (store as unknown as { sqlite: { dbPath: string } }).sqlite.dbPath;
    const reloaded = new KnowledgeStore({ dbPath });
    await reloaded.init();
    expect(reloaded.listJobRuns(10_000).length).toBeLessThanOrEqual(500);
  });
});

describe('no self-improve scheduler bypasses (gate)', () => {
  test('every .selfImprove( caller in the SDK source is on the governed allowlist', () => {
    const root = '/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src';
    // Files allowed to call selfImprove directly:
    //  - semantic/service.ts: the scheduler itself + the answer path (deferRepair task-queue pass)
    //  - home-graph/sync-self-improvement.ts: the delayed, single-flight sync pump —
    //    governed via a between-rounds isBackgroundWorkPaused() gate plus
    //    { stopWhenPaused: true } threaded into the runner's per-gap yield
    //    points (real for space-scoped rounds), and the in-run admission gate
    //  - knowledge/service.ts: the manual reindex/selfImprove verb surface (operator-invoked,
    //    admission-gated inside runSelfImproveUnlocked)
    const allowed = new Set([
      'platform/knowledge/semantic/service.ts',
      'platform/knowledge/home-graph/sync-self-improvement.ts',
      'platform/knowledge/service.ts',
      // The scheduled-job executor (the deliberate hourly cadence); its verb
      // entry (KnowledgeService.runJob) is admission-gated, and the run itself
      // passes through runSelfImproveUnlocked's in-run admission check.
      'platform/knowledge/service-jobs.ts',
      // The operator-invoked Home Graph refinement verb (foreground, targeted
      // gapIds) — admission-gated in-run like every non-deferRepair run.
      'platform/knowledge/home-graph/refinement.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf-8');
        if (/\.selfImprove\(/.test(text)) {
          const rel = full.slice(root.length + 1);
          if (!allowed.has(rel)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(
      offenders,
      `New .selfImprove( caller(s) outside the governed allowlist: ${offenders.join(', ')}. ` +
      'Background self-improvement triggers must route through KnowledgeSemanticService.queueBackgroundSelfImprove ' +
      '(floor + coalescing + zero-gap backoff + governor pause) — never a direct scheduleBackground self-improve.',
    ).toEqual([]);
  });

  test('the sync pump is genuinely pause-governed: stopWhenPaused on BOTH selfImprove calls plus a between-rounds gate', () => {
    const text = readFileSync('/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src/platform/knowledge/home-graph/sync-self-improvement.ts', 'utf-8');
    // The whole-space reindex call carries stopWhenPaused.
    expect(text).toMatch(/selfImprove\([^)]*\{ knowledgeSpaceId: spaceId, reason: 'reindex' \}, \{ stopWhenPaused: true \}\)/);
    // The PUMP's per-round call carries stopWhenPaused too (this was the
    // regression: only the reindex shape was pinned, so the pump call could
    // silently drop it).
    expect(text).toMatch(/reason: 'homegraph-sync'[\s\S]{0,400}\}, \{ stopWhenPaused: true \}\)/);
    // And the pump loop itself gates between rounds on the pause probe —
    // stopWhenPaused alone only stops a round already in flight.
    expect(text).toMatch(/isBackgroundWorkPaused\(\)/);
    // The per-ingest path routes through the governed scheduler.
    expect(text).toMatch(/queueBackgroundSelfImprove\(/);
  });

  test('the space-scoped runner path threads the pause stop into per-gap yield points (stopWhenPaused is not inert)', () => {
    const service = readFileSync('/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src/platform/knowledge/semantic/service.ts', 'utf-8');
    // BOTH runKnowledgeSemanticSelfImprovement call sites pass shouldStop
    // (the whole-store per-space call AND the space-scoped call every pump
    // round takes).
    const shouldStopCount = (service.match(/shouldStop: \(\) => this\.backgroundStopRequested\(runOptions\)/g) ?? []).length;
    expect(shouldStopCount).toBe(2);
    // The runner consults it at its per-gap loop boundary, same as abort.
    const runner = readFileSync('/home/buzzkill/Projects/goodvibes-sdk/packages/sdk/src/platform/knowledge/semantic/self-improvement.ts', 'utf-8');
    expect(runner).toMatch(/input\.signal\?\.aborted \|\| context\.shouldStop\?\.\(\)/);
  });
});
