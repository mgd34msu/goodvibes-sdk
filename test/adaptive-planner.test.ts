import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { AdaptivePlanner, type PlannerInputs } from '../packages/sdk/src/platform/core/adaptive-planner.js';
import type { RawDecomposition } from '../packages/sdk/src/platform/core/plan-proposal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function inputs(overrides: Partial<PlannerInputs> = {}): PlannerInputs {
  return {
    riskScore: 0.2,
    latencyBudgetMs: Infinity,
    isMultiStep: false,
    remoteAvailable: false,
    backgroundEligible: false,
    taskDescription: 'Do the thing',
    ...overrides,
  };
}

describe('AdaptivePlanner.shouldDecompose', () => {
  test('high risk -> decompose=false, strategy single', () => {
    const planner = new AdaptivePlanner();
    const gate = planner.shouldDecompose(inputs({ riskScore: 0.9, isMultiStep: true }));
    expect(gate.decompose).toBe(false);
    expect(gate.strategy).toBe('single');
  });

  test('tight latency budget -> decompose=false, strategy single', () => {
    const planner = new AdaptivePlanner();
    const gate = planner.shouldDecompose(inputs({ riskScore: 0.1, latencyBudgetMs: 1_000, isMultiStep: false }));
    expect(gate.decompose).toBe(false);
    expect(gate.strategy).toBe('single');
  });

  test('multi-step + low risk -> decompose=true, strategy cohort', () => {
    const planner = new AdaptivePlanner();
    const gate = planner.shouldDecompose(inputs({ riskScore: 0.2, isMultiStep: true }));
    expect(gate.decompose).toBe(true);
    expect(gate.strategy).toBe('cohort');
  });

  test('reasonCode passthrough matches select() for identical inputs', () => {
    const planner = new AdaptivePlanner();
    const theInputs = inputs({ riskScore: 0.2, isMultiStep: true });
    const decision = planner.select(theInputs);
    const gate = planner.shouldDecompose(theInputs);
    expect(gate.reasonCode).toBe(decision.reasonCode);
    expect(gate.strategy).toBe(decision.selected);
  });
});

describe('AdaptivePlanner.proposeWorkstream', () => {
  test('no raw + gate.decompose=false -> single-item proposal', () => {
    const planner = new AdaptivePlanner();
    const result = planner.proposeWorkstream(inputs({ riskScore: 0.9, isMultiStep: true, taskDescription: 'Risky task' }));
    expect(result.gate.decompose).toBe(false);
    expect(result.proposal.source).toBe('single-item-fallback');
    expect(result.proposal.task).toBe('Risky task');
    expect(result.issues).toEqual([]);
  });

  test('gate.decompose=true but no raw yet -> honest single-item fallback (not a guess)', () => {
    const planner = new AdaptivePlanner();
    const result = planner.proposeWorkstream(inputs({ riskScore: 0.2, isMultiStep: true, taskDescription: 'Multi-step task' }));
    expect(result.gate.decompose).toBe(true);
    expect(result.proposal.source).toBe('single-item-fallback');
  });

  test('raw + gate.decompose=true -> multi-phase planner-agent proposal', () => {
    const planner = new AdaptivePlanner();
    const raw: RawDecomposition = {
      phases: [{ title: 'Plan' }, { title: 'Build' }],
      workItems: [
        { title: 'Design', brief: 'Design it', phase: 'Plan' },
        { title: 'Code', brief: 'Build it', phase: 'Build', dependsOn: ['Design'] },
      ],
    };
    const result = planner.proposeWorkstream(
      inputs({ riskScore: 0.2, isMultiStep: true, taskDescription: 'Multi-step task' }),
      raw,
    );
    expect(result.gate.decompose).toBe(true);
    expect(result.proposal.source).toBe('planner-agent');
    expect(result.proposal.phases).toHaveLength(2);
    expect(result.proposal.workItems).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  test('raw supplied even when gate.decompose=false -> still honest single-item fallback (raw ignored)', () => {
    const planner = new AdaptivePlanner();
    const raw: RawDecomposition = {
      phases: [{ title: 'Plan' }],
      workItems: [{ title: 'Design', brief: 'Design it', phase: 'Plan' }],
    };
    const result = planner.proposeWorkstream(inputs({ riskScore: 0.9, isMultiStep: true }), raw);
    expect(result.proposal.source).toBe('single-item-fallback');
  });

  test('history still appended for every proposeWorkstream call (free audit trail)', () => {
    const planner = new AdaptivePlanner();
    expect(planner.getLatest()).toBeNull();
    const result = planner.proposeWorkstream(inputs({ riskScore: 0.2, isMultiStep: true }));
    const latest = planner.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.selected).toBe(result.gate.strategy);
  });
});

describe('AdaptivePlanner purity (import-surface test)', () => {
  test('adaptive-planner.ts performs no async/await, no fs, no agent spawn', () => {
    const source = readFileSync(
      join(__dirname, '..', 'packages/sdk/src/platform/core/adaptive-planner.ts'),
      'utf-8',
    );
    // Targeted at actual async syntax (function modifier / await / Promise
    // return types), not incidental prose — a comment describing
    // BACKGROUND_DEFERRED legitimately contains the word "async".
    expect(source).not.toMatch(/\basync\s+(\(|function\b|[a-zA-Z_]+\s*\()/);
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/\bPromise\s*</);
    expect(source).not.toMatch(/readFileSync|writeFileSync|existsSync|mkdirSync/);
    expect(source).not.toMatch(/AgentManager|spawn\(|fetch\(|LLMProvider/);
  });
});
