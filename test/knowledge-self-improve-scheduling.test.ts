/**
 * knowledge-self-improve-scheduling.test.ts
 *
 * Item 2 guard: background knowledge self-improvement must (a) honor a real
 * minimum floor even when a caller asks for delayMs=0, (b) coalesce a burst of
 * triggers into a single queued run, and (c) stop self-perpetuating once a run
 * finds zero candidate gaps (backing off to the hourly schedule). Together these
 * defuse the enrichment hot loop that fanned control-plane events until OOM.
 */
import { describe, expect, test } from 'bun:test';
import { KnowledgeSemanticService } from '../packages/sdk/src/platform/knowledge/index.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from '../packages/sdk/src/platform/knowledge/semantic/types.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

const gapRepairer = {} as unknown as KnowledgeSemanticGapRepairer;

/** Access the private scheduler + stub selfImprove to a counted, controllable run. */
function harness(opts: {
  minDelayMs: number;
  zeroGapBackoffMs: number;
  candidateGaps: number;
}): {
  schedule: (input: KnowledgeSemanticSelfImproveInput, delayMs?: number) => void;
  runs: () => number;
  setCandidateGaps: (n: number) => void;
} {
  const { store } = createStores();
  const svc = new KnowledgeSemanticService(store, {
    gapRepairer,
    backgroundSelfImproveMinDelayMs: opts.minDelayMs,
    backgroundSelfImproveZeroGapBackoffMs: opts.zeroGapBackoffMs,
  });
  let count = 0;
  let candidateGaps = opts.candidateGaps;
  const internal = svc as unknown as {
    runSelfImprovementInBackground(input: KnowledgeSemanticSelfImproveInput, delayMs?: number): void;
    selfImprove(input: KnowledgeSemanticSelfImproveInput): Promise<KnowledgeSemanticSelfImproveResult>;
  };
  internal.selfImprove = async () => {
    count += 1;
    return { candidateGaps } as unknown as KnowledgeSemanticSelfImproveResult;
  };
  return {
    schedule: (input, delayMs) => internal.runSelfImprovementInBackground(input, delayMs),
    runs: () => count,
    setCandidateGaps: (n) => { candidateGaps = n; },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('background self-improvement scheduling', () => {
  test('enforces the minimum floor even when asked for delayMs=0', async () => {
    const h = harness({ minDelayMs: 80, zeroGapBackoffMs: 10_000, candidateGaps: 1 });
    h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-floor' }, 0);
    expect(h.runs()).toBe(0);       // never synchronous
    await sleep(30);
    expect(h.runs()).toBe(0);       // still parked — floor not yet elapsed
    await sleep(120);
    expect(h.runs()).toBe(1);       // ran only after the floor
  });

  test('coalesces a burst of triggers into a single queued run', async () => {
    const h = harness({ minDelayMs: 40, zeroGapBackoffMs: 10_000, candidateGaps: 1 });
    for (let i = 0; i < 8; i++) h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-burst' }, 0);
    await sleep(140);
    expect(h.runs()).toBe(1);       // 8 triggers → exactly one run
  });

  test('zero-gap results do not self-perpetuate', async () => {
    const h = harness({ minDelayMs: 20, zeroGapBackoffMs: 10_000, candidateGaps: 0 });
    h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-zero' }, 0);
    await sleep(80);
    expect(h.runs()).toBe(1);       // first run happens
    h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-zero' }, 0);
    await sleep(80);
    expect(h.runs()).toBe(1);       // suppressed — zero gaps backed off to the hourly schedule
  });

  test('runs that find gaps keep rescheduling normally', async () => {
    const h = harness({ minDelayMs: 20, zeroGapBackoffMs: 10_000, candidateGaps: 3 });
    h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-gaps' }, 0);
    await sleep(80);
    expect(h.runs()).toBe(1);
    h.schedule({ reason: 'reindex', knowledgeSpaceId: 'space-gaps' }, 0);
    await sleep(80);
    expect(h.runs()).toBe(2);       // non-zero gaps ⇒ no backoff, next trigger runs
  });
});
