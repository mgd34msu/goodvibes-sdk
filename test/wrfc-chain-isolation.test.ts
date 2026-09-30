/**
 * Every WRFC chain in a git repository works in its own isolated worktree:
 * members spawn there, the planned-fix workstream is rooted there, and only a
 * passed chain's own changes come back, committed without the edits the user
 * had not committed before the chain started. A failed chain leaves the user's
 * files alone, keeps its work on its branch, and stops its fix tasks.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { createFailingFixRunnerForTest } from '../packages/sdk/src/platform/agents/wrfc-controller-test-support.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/index.js';
import type { FixWorkstreamRunner } from '../packages/sdk/src/platform/orchestration/fix-workstream-runner.js';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

const RETRY = [
  '// retry helper',
  'export function delayFor(i: number, base: number): number {',
  '  return base;',
  '}',
  '',
].join('\n');

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrfc-chain-iso-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture Owner']);
  git(root, ['config', 'user.email', 'owner@example.test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'retry.ts'), RETRY);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  // The user's uncommitted edit in a file the chain will touch, and an untracked file.
  writeFileSync(join(root, 'src', 'retry.ts'), RETRY.replace('// retry helper', '// retry helper (owner edit, uncommitted)'));
  writeFileSync(join(root, 'notes.txt'), 'owner notes\n');
  return root;
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: 'engineer', tools: [], status: 'running', startedAt: Date.now(), toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
    ...overrides,
  };
}

function engineerOutput(modified: string[], created: string[]): string {
  return ['```json', JSON.stringify({
    version: 1, archetype: 'engineer', summary: 'capped the delay', gatheredContext: [], plannedActions: [],
    appliedChanges: ['capped the delay'], filesCreated: created, filesModified: modified, filesDeleted: [],
    decisions: [], issues: [], uncertainties: [], constraints: [],
  }), '```'].join('\n');
}

function reviewerOutput(passed: boolean): string {
  return ['```json', JSON.stringify({
    version: 1, archetype: 'reviewer', summary: passed ? 'ok' : 'needs a fix', score: passed ? 10 : 4, passed,
    dimensions: [], issues: passed ? [] : [{ severity: 'major', description: 'Cap is missing a test.', pointValue: 1 }],
    constraintFindings: [], acceptanceChecklist: [{ item: 'meets the ask', verified: passed, evidence: 'fixture' }],
  }), '```'].join('\n');
}

function emit(bus: RuntimeEventBus, type: 'AGENT_COMPLETED' | 'AGENT_FAILED', agentId: string): void {
  bus.emit('agents', createEventEnvelope(type, type === 'AGENT_COMPLETED'
    ? { type, agentId, durationMs: 0 }
    : { type, agentId, error: 'boom', durationMs: 0 }, { sessionId: 't', traceId: 't', source: 't' }));
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function harness(root: string, options: { maxFixAttempts?: number; runner?: FixWorkstreamRunner } = {}) {
  const bus = new RuntimeEventBus();
  const store = new Map<string, AgentRecord>();
  const spawns: Array<{ record: AgentRecord; workingDirectory: string | undefined }> = [];
  const values: Record<string, unknown> = {
    'wrfc.scoreThreshold': 9, 'wrfc.maxFixAttempts': options.maxFixAttempts ?? 1, 'wrfc.autoCommit': true,
    'wrfc.commitScope': 'scoped', 'wrfc.transportRetryLimit': 0, 'wrfc.transportRetryDelayMs': 0,
    // No derived install for the fixture (no lockfile), and no carry-over.
    'worktree.setup.commands': ['true'], 'worktree.setup.carryOverGlobs': ['*.never'],
  };
  const configManager: Pick<ConfigManager, 'get' | 'getCategory'> = {
    get: ((key: string) => values[key]) as ConfigManager['get'],
    getCategory: ((category: string) => (category === 'wrfc' ? { gates: [] } : undefined)) as ConfigManager['getCategory'],
  };
  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const record = makeRecord({ id: `agent-${spawns.length + 1}`, task: String((input as { task?: string }).task), template: String((input as { template?: string }).template ?? 'engineer') });
      store.set(record.id, record);
      spawns.push({ record, workingDirectory: (input as { workingDirectory?: string }).workingDirectory });
      return record;
    },
    getStatus: (id: string) => store.get(id) ?? null,
    list: () => [...store.values()],
    cancel: () => false,
    listByCohort: () => [],
    clear: () => store.clear(),
  };
  const controller = disposables.add(new WrfcController(bus, { registerAgent: () => {} }, {
    agentManager, configManager, projectRoot: root,
    fixWorkstreamRunner: options.runner ?? createFailingFixRunnerForTest(),
  }));
  const owner = makeRecord({ id: 'owner-1', task: 'Cap the retry delay in src/retry.ts' });
  store.set(owner.id, owner);
  const complete = (record: AgentRecord, output: string): void => {
    record.fullOutput = output;
    emit(bus, 'AGENT_COMPLETED', record.id);
  };
  return { bus, controller, owner, spawns, complete };
}

describe('WRFC chain isolation', () => {
  test('the chain works in its own worktree and its commit carries only its own change; the earlier uncommitted edit survives outside the commit', async () => {
    const root = makeRepo();
    const h = harness(root);
    const chain = h.controller.createChain(h.owner);
    await until(() => h.spawns.length === 1, 'engineer spawn');

    const worktree = join(root, '.goodvibes', '.worktrees', 'wrfc', chain.id.replace(/^wrfc-/, ''));
    expect(h.spawns[0]!.workingDirectory).toBe(worktree);
    expect(chain.workspace?.branch).toBe(`wrfc/${chain.id.replace(/^wrfc-/, '')}`);
    expect(chain.ownerDecisions.find((d) => d.action === 'spawn_engineer')?.reason).toContain(`in isolated worktree ${worktree}`);

    // The engineer edits inside its worktree; the user's directory does not change while the chain runs.
    writeFileSync(join(worktree, 'src', 'retry.ts'), readFileSync(join(worktree, 'src', 'retry.ts'), 'utf8').replace('  return base;', '  return Math.min(base * 2 ** i, 30_000);'));
    mkdirSync(join(worktree, 'test'), { recursive: true });
    writeFileSync(join(worktree, 'test', 'retry.test.ts'), 'export const covered = true;\n');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).not.toContain('Math.min');
    h.complete(h.spawns[0]!.record, engineerOutput(['src/retry.ts'], ['test/retry.test.ts']));

    await until(() => h.spawns.length === 2, 'reviewer spawn');
    expect(h.spawns[1]!.workingDirectory).toBe(worktree);
    h.complete(h.spawns[1]!.record, reviewerOutput(true));
    await until(() => chain.state === 'passed', 'chain pass');

    const committed = git(root, ['show', 'HEAD:src/retry.ts']);
    expect(committed).toContain('Math.min(base * 2 ** i, 30_000)');
    expect(committed).not.toContain('owner edit, uncommitted');
    expect(git(root, ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n').slice(2)).toEqual(['src/retry.ts', 'test/retry.test.ts']);
    expect(git(root, ['ls-files', 'notes.txt']).trim()).toBe('');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toContain('owner edit, uncommitted');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toContain('Math.min(base * 2 ** i, 30_000)');
    expect(git(root, ['status', '--porcelain', '--', 'src', 'notes.txt']).split('\n').filter(Boolean).sort()).toEqual([' M src/retry.ts', '?? notes.txt']);
    expect(JSON.stringify(h.owner)).toContain('your uncommitted edits in src/retry.ts, notes.txt were kept in place and are not part of that commit');
    expect(existsSync(worktree)).toBe(false);
  });

  test('a passed chain whose commit a repository hook refuses reports the hook\'s words on its passed event and status; nothing lands and the work stays on its branch', async () => {
    const root = makeRepo();
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: name the 30_000 cap first" >&2\nexit 1\n');
    chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const retryBefore = readFileSync(join(root, 'src', 'retry.ts'), 'utf8');
    const h = harness(root);
    const notes: string[] = [];
    h.bus.on('WORKFLOW_CHAIN_PASSED', ({ payload }) => { notes.push(String((payload as { note?: string }).note ?? '')); });
    const chain = h.controller.createChain(h.owner);
    await until(() => h.spawns.length === 1, 'engineer spawn');
    const worktree = join(root, '.goodvibes', '.worktrees', 'wrfc', chain.id.replace(/^wrfc-/, ''));
    writeFileSync(join(worktree, 'src', 'retry.ts'), readFileSync(join(worktree, 'src', 'retry.ts'), 'utf8').replace('  return base;', '  return Math.min(base * 2 ** i, 30_000);'));
    h.complete(h.spawns[0]!.record, engineerOutput(['src/retry.ts'], []));
    await until(() => h.spawns.length === 2, 'reviewer spawn');
    h.complete(h.spawns[1]!.record, reviewerOutput(true));
    await until(() => chain.state === 'passed', 'chain pass');
    await until(() => notes.length === 1, 'passed event');

    expect(notes[0]).toContain("your repository's commit hooks refused the chain's commit");
    expect(notes[0]).toContain('git commit said: lint: name the 30_000 cap first');
    expect(JSON.stringify(h.owner)).toContain('lint: name the 30_000 cap first');
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toBe(retryBefore);
    expect(git(root, ['show', `${chain.workspace!.branch}:src/retry.ts`])).toContain('Math.min(base * 2 ** i, 30_000)');
  });

  test('the planned-fix workstream is rooted in the chain worktree and branches from the engineer\'s checkpointed work', async () => {
    const root = makeRepo();
    const seen: Array<{ rootDir: string | undefined; tipHasWork: boolean }> = [];
    const runner: FixWorkstreamRunner = {
      run: async (input) => {
        const rootDir = input.rootDir;
        seen.push({ rootDir, tipHasWork: rootDir ? git(rootDir, ['show', 'HEAD:src/retry.ts']).includes('Math.min') : false });
        return { status: 'failed', reason: 'fixture stops here', structured: 'tasks-failed' };
      },
    };
    const h = harness(root, { maxFixAttempts: 2, runner });
    const chain = h.controller.createChain(h.owner);
    await until(() => h.spawns.length === 1, 'engineer spawn');
    const worktree = chain.workspace!.cwd;
    writeFileSync(join(worktree, 'src', 'retry.ts'), RETRY.replace('  return base;', '  return Math.min(base, 1);'));
    h.complete(h.spawns[0]!.record, engineerOutput(['src/retry.ts'], []));
    await until(() => h.spawns.length === 2, 'reviewer spawn');
    h.complete(h.spawns[1]!.record, reviewerOutput(false));
    await until(() => chain.state === 'failed', 'chain failure after the fix cycle');

    expect(seen).toEqual([{ rootDir: worktree, tipHasWork: true }]);
    // A failed chain never touches the user's files and keeps its work on the branch.
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).not.toContain('Math.min');
    expect(chain.error).toContain(`the chain's work so far is kept on branch ${chain.workspace!.branch}`);
    expect(git(root, ['show', `${chain.workspace!.branch}:src/retry.ts`])).toContain('Math.min(base, 1)');
    expect(existsSync(worktree)).toBe(false);
  });

  test('a chain cancelled while its fix cycle runs stops the remaining fix tasks', async () => {
    const root = makeRepo();
    const stops: Array<{ chainId: string; reason: string }> = [];
    const runner: FixWorkstreamRunner = {
      run: () => new Promise(() => {}), // a fix cycle still running
      stop: (chainId, reason) => { stops.push({ chainId, reason }); return 2; },
    };
    const h = harness(root, { maxFixAttempts: 2, runner });
    const chain = h.controller.createChain(h.owner);
    await until(() => h.spawns.length === 1, 'engineer spawn');
    h.complete(h.spawns[0]!.record, engineerOutput([], []));
    await until(() => h.spawns.length === 2, 'reviewer spawn');
    h.complete(h.spawns[1]!.record, reviewerOutput(false));
    await until(() => chain.state === 'fixing', 'fix cycle');
    h.bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId: h.owner.id, reason: 'operator stop' }, { sessionId: 't', traceId: 't', source: 't' }));
    await until(() => chain.state === 'failed', 'chain cancel');
    expect(chain.state).toBe('failed');
    expect(stops).toEqual([{ chainId: chain.id, reason: 'stopped because the chain was cancelled' }]);
    expect(chain.failureKind).toBe('cancelled');
  });
});
