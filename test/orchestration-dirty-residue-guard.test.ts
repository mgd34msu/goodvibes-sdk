/**
 * Dirty-residue guard: a scoped commit must never
 * sweep in uncommitted changes left behind by a previously killed run
 * sharing the same projectRoot. Covers both the pure partition logic
 * (dirty-guard.ts, against a real scratch git repo) and the actual
 * phase-runner wiring (runPhase -> commitPhaseWork).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  excludeUntouchedLaunchResidue,
  snapshotDirtyTree,
} from '../packages/sdk/src/platform/orchestration/dirty-guard.js';
import { runPhase } from '../packages/sdk/src/platform/orchestration/phase-runner.js';
import { createCancellationRegistry } from '../packages/sdk/src/platform/orchestration/cancellation.js';
import { emptyWorkItemUsage, type Phase, type WorkItem, type Workstream } from '../packages/sdk/src/platform/orchestration/types.js';
import { AgentWorktree } from '../packages/sdk/src/platform/agents/worktree.js';
import {
  createOrchestrationHarness,
  engineerReportOutput,
  makeFakeConfigManager,
} from './_helpers/orchestration-harness.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
  return Buffer.from(result.stdout).toString('utf8');
}

function commitCount(cwd: string): number {
  const result = Bun.spawnSync(['git', 'rev-list', '--count', 'HEAD'], { cwd });
  if (result.exitCode !== 0) return 0;
  return parseInt(Buffer.from(result.stdout).toString('utf8').trim() || '0', 10);
}

// ---------------------------------------------------------------------------
// dirty-guard.ts — pure partition logic
// ---------------------------------------------------------------------------

describe('dirty-guard — snapshotDirtyTree', () => {
  test('captures dirty tracked + untracked paths with content hashes, excluding .goodvibes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-snapshot-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'tracked.ts'), 'export const a = 1;\n');
    runGit(root, ['add', 'tracked.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    writeFileSync(join(root, 'tracked.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'untracked.ts'), 'export const b = 1;\n');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'state.json'), '{}\n');

    const snapshot = snapshotDirtyTree(root);

    expect(snapshot.has('tracked.ts')).toBe(true);
    expect(snapshot.has('untracked.ts')).toBe(true);
    expect([...snapshot.keys()].some((path) => path.startsWith('.goodvibes'))).toBe(false);
    expect(snapshot.get('tracked.ts')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('degrades to an empty snapshot (never throws) when cwd is not a git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-nogit-'));
    const snapshot = snapshotDirtyTree(root);
    expect(snapshot.size).toBe(0);
  });

  test('keys non-ASCII paths by their RAW name (via `-z`), not git\'s C-quoted form, so the hash reads real bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-unicode-'));
    runGit(root, ['init']);
    // Both names are C-quoted by git's default porcelain (core.quotePath=true):
    // café.txt -> "caf\303\251.txt". Under the old newline parser the snapshot
    // keyed on the quoted string, so residue with such a name silently bypassed
    // exclusion and its content-hash read (of the quoted name) returned null.
    writeFileSync(join(root, 'café.txt'), 'accented\n');
    writeFileSync(join(root, '普通话.txt'), 'cjk\n');

    const snapshot = snapshotDirtyTree(root);

    // Raw paths are the keys — never the quoted "caf\303\251.txt" form.
    expect(snapshot.has('café.txt')).toBe(true);
    expect(snapshot.has('普通话.txt')).toBe(true);
    expect([...snapshot.keys()].some((key) => key.includes('\\') || key.startsWith('"'))).toBe(false);
    // Real digests: the raw names resolve on disk, so hashWorkingTreeFile read
    // actual bytes rather than failing on a nonexistent quoted filename.
    expect(snapshot.get('café.txt')).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.get('普通话.txt')).toMatch(/^[0-9a-f]{64}$/);

    // End to end: untouched non-ASCII residue is excluded from a scoped commit
    // (the whole point of the guard) instead of leaking through on a key mismatch.
    const { included, excluded } = excludeUntouchedLaunchResidue(root, ['café.txt', '普通话.txt'], snapshot);
    expect(excluded.sort()).toEqual(['café.txt', '普通话.txt'].sort());
    expect(included).toEqual([]);
  });

  test('`-z` rename record: keeps the destination and consumes the non-ASCII origin field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-rename-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'café.txt'), 'x\n');
    runGit(root, ['add', 'café.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    // Staged rename → `git status --porcelain -z` emits `R  renamed.txt\0café.txt\0`.
    runGit(root, ['mv', 'café.txt', 'renamed.txt']);

    const snapshot = snapshotDirtyTree(root);

    // The destination is captured; the following NUL-separated origin field is
    // consumed, never mis-parsed as its own standalone dirty path.
    expect(snapshot.has('renamed.txt')).toBe(true);
    expect(snapshot.has('café.txt')).toBe(false);
    expect(snapshot.get('renamed.txt')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dirty-guard — excludeUntouchedLaunchResidue', () => {
  test('a path dirty at launch and never modified afterward is excluded; a genuinely new path is included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-exclude-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);
    expect(launchSnapshot.has('residue.ts')).toBe(true);

    // This run creates a brand-new file; residue.ts is left byte-for-byte untouched.
    writeFileSync(join(root, 'feature.ts'), 'export const feature = 1;\n');

    const { included, excluded } = excludeUntouchedLaunchResidue(root, ['residue.ts', 'feature.ts'], launchSnapshot);
    expect(excluded).toEqual(['residue.ts']);
    expect(included).toEqual(['feature.ts']);
  });

  test('a path dirty at launch that this run actually modifies is included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-modified-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);

    writeFileSync(join(root, 'residue.ts'), 'export const residue = 2;\n');

    const { included, excluded } = excludeUntouchedLaunchResidue(root, ['residue.ts'], launchSnapshot);
    expect(included).toEqual(['residue.ts']);
    expect(excluded).toEqual([]);
  });

  test('a path absent from the launch snapshot is always included, even if it later becomes dirty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-fresh-'));
    runGit(root, ['init']);
    const launchSnapshot = snapshotDirtyTree(root); // nothing dirty yet

    writeFileSync(join(root, 'new.ts'), 'export const isNew = true;\n');

    const { included, excluded } = excludeUntouchedLaunchResidue(root, ['new.ts'], launchSnapshot);
    expect(included).toEqual(['new.ts']);
    expect(excluded).toEqual([]);
  });

  test('every candidate untouched since launch partitions to an empty included set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dirty-guard-allexcluded-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue-a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'residue-b.ts'), 'export const b = 1;\n');
    const launchSnapshot = snapshotDirtyTree(root);

    const { included, excluded } = excludeUntouchedLaunchResidue(root, ['residue-a.ts', 'residue-b.ts'], launchSnapshot);
    expect(included).toEqual([]);
    expect(excluded.sort()).toEqual(['residue-a.ts', 'residue-b.ts']);
  });
});

// ---------------------------------------------------------------------------
// phase-runner.ts wiring — runPhase -> commitPhaseWork end to end
// ---------------------------------------------------------------------------

function makeWorkstream(): Workstream {
  return { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items: [], createdAt: Date.now() };
}

function makeScopedPhase(): Phase {
  return { id: 'phase-1', ordinal: 1, role: 'engineer', capacity: 1, gate: { scope: 'scoped', gates: [] }, kind: 'engineer' };
}

function makeItem(touchedPaths: string[]): WorkItem {
  return {
    id: 'item-1',
    title: 'item',
    task: 'do work',
    currentPhaseId: 'phase-1',
    state: 'in-phase',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths,
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: Date.now(),
  };
}

describe('phase-runner — dirty-residue guard wiring', () => {
  test('excludes untouched launch-dirty residue from a scoped commit; commits only the genuinely new path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-runner-dirty-exclude-'));
    runGit(root, ['init']);
    // Residue left behind by a "previously killed run", already dirty before this engine launches.
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    // item.touchedPaths already carries 'residue.ts' — simulating WorkItem.touchedPaths'
    // real accumulate-and-never-reset behavior across phases/retries (phase-runner.ts).
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // This run's engineer creates a genuinely new file; residue.ts stays untouched.
    writeFileSync(join(root, 'feature.ts'), 'export const feature = 1;\n');
    h.completeAgent(agentId, engineerReportOutput({ filesCreated: ['feature.ts'] }));
    const outcome = await outcomePromise;

    expect(outcome.agentStatus).toBe('completed');
    expect(outcome.result.gate.passed).toBe(true);
    expect(outcome.result.commitExclusion?.excludedPaths).toEqual(['residue.ts']);
    expect(outcome.result.commitExclusion?.skipped).toBe(false);

    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('feature.ts');
    expect(committedFiles).not.toContain('residue.ts');
    // residue.ts is still sitting dirty on disk — never swept into the commit.
    expect(runGit(root, ['status', '--porcelain'])).toContain('residue.ts');
  });

  test('includes a pre-dirty path that this run actually modifies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-runner-dirty-include-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // This run genuinely changes residue.ts's content.
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 2;\n');
    h.completeAgent(agentId, engineerReportOutput({ filesModified: ['residue.ts'] }));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion).toBeUndefined();
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('residue.ts');
  });

  test('skips the commit entirely with an honest recorded note when every candidate path is untouched residue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-runner-dirty-skip-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // Taken BEFORE any of this "run"'s own writes, matching real engine-launch
    // timing: snapshotDirtyTree is synchronous (see dirty-guard.ts), so this
    // deterministically reflects only what was dirty at launch.
    const launchDirtySnapshot = snapshotDirtyTree(root);

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
      launchDirtySnapshot,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    // Engineer reports no new work; residue.ts is exactly as it was at launch.
    h.completeAgent(agentId, engineerReportOutput({}));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion?.skipped).toBe(true);
    expect(outcome.result.commitExclusion?.excludedPaths).toEqual(['residue.ts']);
    expect(commitCount(root)).toBe(0);
  });

  test('without a launchDirtySnapshot dep, behavior is unchanged: every candidate path commits (graceful degrade)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-runner-dirty-degrade-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'residue.ts'), 'export const residue = 1;\n');
    // No launchDirtySnapshot passed at all.

    const h = createOrchestrationHarness();
    const worktree = new AgentWorktree(root);
    const item = makeItem(['residue.ts']);

    const outcomePromise = runPhase(makeWorkstream(), item, makeScopedPhase(), [], {
      agentManager: h.agentManager,
      configManager: makeFakeConfigManager(),
      runtimeBus: h.bus,
      projectRoot: root,
      sessionId: 'test',
      createWorktree: () => worktree,
      cancellation: createCancellationRegistry(),
      skipClaimVerification: true,
    });
    const agentId = h.spawnedRecords.at(-1)!.id;
    h.completeAgent(agentId, engineerReportOutput({}));
    const outcome = await outcomePromise;

    expect(outcome.result.commitExclusion).toBeUndefined();
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('residue.ts');
  });
});
