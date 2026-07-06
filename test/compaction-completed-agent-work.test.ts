/**
 * Compaction accounts for subagent work.
 *
 * Covers:
 *  - buildCompletedAgentWork(): the new "## Completed Agent Work" section that
 *    surfaces standalone (non-WRFC) completed/failed agents, which were
 *    previously invisible to compaction because both call sites that build
 *    CompactionContext.agents applied a premature isActiveAgent filter.
 *  - buildAgentActivityTable(): extended with a Files column sourced from
 *    WrfcChain.touchedPaths.
 *  - resolveLineageOriginalTask(): the "Original task" mislabel fix — the
 *    lastUserMsg fallback must only fire on the very first compaction
 *    (compactionCount === 0), not on every subsequent manual compaction.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCompletedAgentWork,
  buildAgentActivityTable,
} from '../packages/sdk/src/platform/core/compaction-sections.ts';
import { resolveLineageOriginalTask } from '../packages/sdk/src/platform/core/context-compaction.ts';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.ts';
import type { WrfcChain } from '../packages/sdk/src/platform/agents/wrfc-types.ts';

/** Build a minimal AgentRecord (mirrors test/wrfc-controller.test.ts's makeRecord helper). */
function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id,
    task: overrides.task,
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'completed',
    startedAt: Date.now(),
    toolCallCount: 3,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

/** Build a minimal WrfcChain (mirrors test/wrfc-phantom-fixes.test.ts's inline literals). */
function makeChain(overrides: Partial<WrfcChain> & { id: string }): WrfcChain {
  return {
    id: overrides.id,
    state: 'passed',
    task: 'chain task',
    ownerAgentId: `${overrides.id}-owner`,
    allAgentIds: [],
    fixAttempts: 0,
    reviewCycles: 0,
    reviewScores: [],
    createdAt: Date.now(),
    ownerTerminalEmitted: true,
    constraints: [],
    constraintsEnumerated: false,
    ownerDecisions: [],
    ...overrides,
  };
}

function engineerReportOutput(files: { created?: string[]; modified?: string[]; deleted?: string[] }): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary: 'did the work',
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [],
      filesCreated: files.created ?? [],
      filesModified: files.modified ?? [],
      filesDeleted: files.deleted ?? [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }),
    '```',
  ].join('\n');
}

describe('buildCompletedAgentWork', () => {
  test('returns null when agents is empty', () => {
    expect(buildCompletedAgentWork([], [])).toBeNull();
  });

  test('returns null when all agents are still running/pending', () => {
    const agents = [
      makeRecord({ id: 'a1', task: 'still going', status: 'running' }),
      makeRecord({ id: 'a2', task: 'queued', status: 'pending' }),
    ];
    expect(buildCompletedAgentWork(agents, [])).toBeNull();
  });

  test('lists a plain completed agent with task, tool count, and DONE marker', () => {
    const agents = [
      makeRecord({ id: 'a1', task: 'refactor the widget', status: 'completed', toolCallCount: 5 }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section).not.toBeNull();
    expect(section!.header).toBe('## Completed Agent Work');
    expect(section!.content).toContain('[DONE]');
    expect(section!.content).toContain('a1');
    expect(section!.content).toContain('refactor the widget');
    expect(section!.content).toContain('5 tool calls');
  });

  test('lists a plain failed agent with FAILED marker', () => {
    const agents = [
      makeRecord({ id: 'a2', task: 'broken task', status: 'failed', toolCallCount: 1 }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('[FAILED]');
    expect(section!.content).toContain('1 tool call'); // singular, not "1 tool calls"
  });

  test('excludes an agent whose id appears in chain.allAgentIds even without wrfcId set', () => {
    const agents = [
      makeRecord({ id: 'eng-1', task: 'chain work', status: 'completed', wrfcId: undefined }),
    ];
    const chains = [makeChain({ id: 'chain-1', allAgentIds: ['eng-1'] })];
    expect(buildCompletedAgentWork(agents, chains)).toBeNull();
  });

  test('excludes an agent with wrfcId set directly', () => {
    const agents = [
      makeRecord({ id: 'eng-2', task: 'chain work', status: 'completed', wrfcId: 'chain-2' }),
    ];
    expect(buildCompletedAgentWork(agents, [])).toBeNull();
  });

  test('shows files from a parseable engineer completion report', () => {
    const agents = [
      makeRecord({
        id: 'a3',
        task: 'add feature',
        status: 'completed',
        fullOutput: engineerReportOutput({ created: ['src/foo.ts'], modified: ['src/bar.ts'] }),
      }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('files: src/foo.ts, src/bar.ts');
  });

  test('shows no files clause when fullOutput is absent (no crash)', () => {
    const agents = [makeRecord({ id: 'a4', task: 'no output agent', status: 'completed' })];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).not.toContain('files:');
  });

  test('shows no files clause when fullOutput is unparseable (no crash)', () => {
    const agents = [
      makeRecord({ id: 'a5', task: 'garbled output', status: 'completed', fullOutput: 'not json at all' }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).not.toContain('files:');
  });

  test('truncates the files list with a "(+N more)" suffix beyond 5 paths', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const agents = [
      makeRecord({
        id: 'a6',
        task: 'big change',
        status: 'completed',
        fullOutput: engineerReportOutput({ created: files }),
      }),
    ];
    const section = buildCompletedAgentWork(agents, []);
    expect(section!.content).toContain('(+2 more)');
    expect(section!.content).toContain('a.ts, b.ts, c.ts, d.ts, e.ts');
    expect(section!.content).not.toContain('f.ts');
  });
});

describe('buildAgentActivityTable — Files column', () => {
  test('includes a file count sourced from chain.touchedPaths', () => {
    const chains = [
      makeChain({ id: 'chain-a', task: 'did something', touchedPaths: ['x.ts', 'y.ts', 'z.ts'] }),
    ];
    const { section } = buildAgentActivityTable(chains, 6500);
    expect(section).not.toBeNull();
    expect(section!.content).toContain('| Files |');
    expect(section!.content).toContain('3 files');
  });

  test('degrades gracefully to "—" when touchedPaths is undefined (legacy chain)', () => {
    const chains = [makeChain({ id: 'chain-b', task: 'legacy chain' })];
    const { section } = buildAgentActivityTable(chains, 6500);
    expect(section).not.toBeNull();
    expect(section!.content).toContain('—');
  });
});

describe('resolveLineageOriginalTask — "Original task" mislabel fix', () => {
  test('compactionCount === 0, originalTask undefined: falls back to lastUserMsg (legitimate first-compaction case)', () => {
    expect(resolveLineageOriginalTask(undefined, 'do the thing', 0)).toBe('do the thing');
  });

  test('compactionCount > 0, originalTask undefined: does NOT fall back to lastUserMsg (the bug)', () => {
    expect(resolveLineageOriginalTask(undefined, 'a much later task', 3)).toBeUndefined();
  });

  test('compactionCount > 0, originalTask set: returns the real original task', () => {
    expect(resolveLineageOriginalTask('the real original task', 'a later task', 2)).toBe(
      'the real original task',
    );
  });

  test('compactionCount === 0, originalTask set: returns the real original task (originalTask always wins)', () => {
    expect(resolveLineageOriginalTask('the real original task', 'a later task', 0)).toBe(
      'the real original task',
    );
  });
});
