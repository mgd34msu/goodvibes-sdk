/**
 * knowledge-admission-coverage.test.ts (fix-round 2)
 *
 * The critical-tier admission gate covers EVERY knowledge-shaped HTTP surface,
 * not just the primary knowledgeService: the agent-alias KnowledgeService and
 * HomeGraphService refuse runJob/ingest with the honest reason when the
 * governor refuses; the home-graph 0ms ingest-enrichment tail defers on pause
 * and refusal instead of running an unconditional LLM call; and the sync pump
 * passes stopWhenPaused (making the caller-allowlist justification true).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KnowledgeService } from '../packages/sdk/src/platform/knowledge/service.js';
import { HomeGraphService } from '../packages/sdk/src/platform/knowledge/home-graph/service.js';
import { enrichAndImproveHomeGraphSource } from '../packages/sdk/src/platform/knowledge/home-graph/sync-self-improvement.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

const refuse = (label: string) => ({ allowed: false, reason: `${label} refused: critical memory pressure` });
const memoryRegistryStub = { add: () => {}, getAll: () => [], getStore: () => null } as never;

describe('agent-alias KnowledgeService admission (the /api/goodvibes-agent/knowledge surface)', () => {
  test('runJob / ingestUrl / ingestArtifact refuse with the honest reason when the governor refuses', async () => {
    const { store, artifactStore } = createStores();
    const service = new KnowledgeService(store, artifactStore, undefined, {
      memoryRegistry: memoryRegistryStub,
      admitExpensiveWork: refuse,
    });
    await expect(service.runJob('any-job')).rejects.toThrow(/critical memory pressure/);
    await expect(service.ingestUrl({ url: 'https://x.test/a' })).rejects.toThrow(/critical memory pressure/);
    await expect(service.ingestArtifact({ artifactId: 'a1' })).rejects.toThrow(/critical memory pressure/);
  });
});

describe('HomeGraphService admission (the home-graph ingest HTTP surface)', () => {
  test('ingestUrl / ingestNote / ingestArtifact refuse with the honest reason when the governor refuses', async () => {
    const { store, artifactStore } = createStores();
    const service = new HomeGraphService(store, artifactStore, { admitExpensiveWork: refuse });
    await expect(service.ingestUrl({} as never)).rejects.toThrow(/critical memory pressure/);
    await expect(service.ingestNote({} as never)).rejects.toThrow(/critical memory pressure/);
    await expect(service.ingestArtifact({} as never)).rejects.toThrow(/critical memory pressure/);
  });
});

describe('home-graph 0ms ingest-enrichment tail honors pause + admission', () => {
  function runtimeWith(opts: { paused?: boolean; admitted?: boolean }) {
    let enrichCalls = 0;
    const { store, artifactStore } = createStores(); // real (empty) store
    const runtime = {
      store,
      artifactStore,
      semanticService: {
        isBackgroundWorkPaused: () => opts.paused === true,
        admitBackgroundWork: (label: string) => (opts.admitted === false ? { allowed: false, reason: `${label} refused` } : { allowed: true }),
        enrichSource: async () => { enrichCalls += 1; return null; },
        queueBackgroundSelfImprove: () => {},
      },
    } as never;
    return { runtime, enrichCalls: () => enrichCalls };
  }

  test('paused -> the LLM-backed enrichment defers (no enrichSource call)', async () => {
    const h = runtimeWith({ paused: true });
    await enrichAndImproveHomeGraphSource(h.runtime, 'src-1', 'space-1');
    expect(h.enrichCalls()).toBe(0);
  });

  test('refused at critical -> the enrichment defers honestly', async () => {
    const h = runtimeWith({ admitted: false });
    await enrichAndImproveHomeGraphSource(h.runtime, 'src-1', 'space-1');
    expect(h.enrichCalls()).toBe(0);
  });

  test('unpaused + admitted -> the enrichment runs', async () => {
    const h = runtimeWith({});
    await enrichAndImproveHomeGraphSource(h.runtime, 'src-1', 'space-1');
    expect(h.enrichCalls()).toBe(1);
  });
});

describe('composition + pump shape pins', () => {
  test('services.ts threads admitExpensiveWork into the agent and home-graph constructions', () => {
    const src = readFileSync('packages/sdk/src/platform/runtime/services.ts', 'utf-8');
    const agentBlock = src.slice(src.indexOf('const agentKnowledgeService = new KnowledgeService('), src.indexOf('agentKnowledgeService.attachRuntimeBus'));
    expect(agentBlock).toContain('admitExpensiveWork');
    const hgBlock = src.slice(src.indexOf('const homeGraphService = new HomeGraphService('), src.indexOf('const projectPlanningService'));
    expect(hgBlock).toContain('admitExpensiveWork');
  });

  test('the sync pump selfImprove loop passes stopWhenPaused (the allowlist justification is true)', () => {
    const src = readFileSync('packages/sdk/src/platform/knowledge/home-graph/sync-self-improvement.ts', 'utf-8');
    // The pump's per-round call carries the runOptions, not just the reindex helper's.
    const pumpCall = src.slice(src.indexOf("reason: 'homegraph-sync'"), src.indexOf("reason: 'homegraph-sync'") + 500);
    expect(pumpCall).toContain('{ stopWhenPaused: true }');
  });
});
