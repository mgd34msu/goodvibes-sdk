import { describe, expect, test } from 'bun:test';
import {
  MIN_PROMPT_MEMORY_CONFIDENCE,
  describeMemoryPromptEligibility,
  isPromptActiveMemory,
  describeMemoryIndexUnavailable,
  describeMemoryIndexCaveat,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
} from '../packages/sdk/src/platform/state/index.js';
import type { MemoryRecord, MemoryVectorStats } from '../packages/sdk/src/platform/state/index.js';

/**
 * W6-C2 (E6) — the cross-surface recall-honesty contract.
 *
 * Promotes the agent's Wave-4 W4-A1 discipline to the SDK so every surface shares
 * ONE honesty contract. Asserts: floor is 60 (not a starving 70), the eligibility
 * receipt is honest, flagged records are excluded regardless of confidence, and an
 * unavailable index degrades with a STATED reason (not a silent empty).
 */

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: 'mem_test',
    scope: 'project',
    cls: 'fact',
    summary: 'a stored fact',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stats(overrides: Partial<MemoryVectorStats> = {}): MemoryVectorStats {
  return {
    backend: 'sqlite-vec',
    enabled: true,
    available: true,
    path: '/tmp/x.vec.sqlite',
    dimensions: 64,
    indexedRecords: 5,
    embeddingProviderId: 'configured-model',
    embeddingProviderLabel: 'Configured Model',
    ...overrides,
  };
}

describe('injection floor is the store baseline (60)', () => {
  test('floor is 60, not a starving 70', () => {
    expect(MIN_PROMPT_MEMORY_CONFIDENCE).toBe(60);
  });

  test('a freshly-stored fact at baseline confidence 60 clears the floor', () => {
    const decision = describeMemoryPromptEligibility(record({ confidence: 60 }));
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toContain('clears the 60% recall floor');
    expect(isPromptActiveMemory(record({ confidence: 60 }))).toBe(true);
  });

  test('a record explicitly stored below baseline does not clear the floor', () => {
    const decision = describeMemoryPromptEligibility(record({ confidence: 59 }));
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain('below the 60% recall floor');
  });
});

describe('flagged records are never injected regardless of confidence', () => {
  test('a stale record at confidence 100 is still excluded', () => {
    const decision = describeMemoryPromptEligibility(record({ reviewState: 'stale', confidence: 100 }));
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain('reviewState is stale');
    expect(decision.reason).toContain('never injected');
  });

  test('a contradicted record at confidence 100 is still excluded', () => {
    const decision = describeMemoryPromptEligibility(record({ reviewState: 'contradicted', confidence: 100 }));
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain('reviewState is contradicted');
  });
});

describe('degraded states are honest, not silent', () => {
  test('a disabled index states the reason', () => {
    expect(describeMemoryIndexUnavailable(stats({ enabled: false }))).toContain('disabled');
  });

  test('an unavailable index states the reason and includes the error', () => {
    const reason = describeMemoryIndexUnavailable(stats({ available: false, error: 'sqlite-vec extension missing' }));
    expect(reason).toContain('unavailable');
    expect(reason).toContain('sqlite-vec extension missing');
  });

  test('an empty index states that nothing is indexed yet (distinct from no-match)', () => {
    expect(describeMemoryIndexUnavailable(stats({ indexedRecords: 0 }))).toContain('no indexed records yet');
  });

  test('an available, populated index reports no unavailability (null)', () => {
    expect(describeMemoryIndexUnavailable(stats())).toBeNull();
  });

  test('the hashed fallback provider is disclosed as a soft caveat', () => {
    const caveat = describeMemoryIndexCaveat(stats({ embeddingProviderId: HASHED_MEMORY_EMBEDDING_PROVIDER.id }));
    expect(caveat).toContain('hashed-only fallback');
    expect(describeMemoryIndexCaveat(stats())).toBeNull();
  });
});
