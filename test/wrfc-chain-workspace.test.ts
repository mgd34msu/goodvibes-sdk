/**
 * A WRFC chain works in its own git worktree and, once it passes, commits only
 * its own changes: edits the user had not committed before the chain started
 * are never swept into the chain's commit, and they survive in the user's
 * working copy (defect: chain commit aa3fa19 committed whole files including
 * the fixture's uncommitted backoff edit and a previously untracked test).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  landChainWorkspace,
  openChainWorkspace,
  releaseChainWorkspace,
  type WrfcChainWorkspace,
} from '../packages/sdk/src/platform/agents/wrfc-chain-workspace.js';

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

const RETRY_V1 = [
  '// retry helper',
  'export interface RetryOptions {',
  '  attempts: number;',
  '  baseDelayMs: number;',
  '}',
  '',
  'export function delayFor(i: number, opts: RetryOptions): number {',
  '  return opts.baseDelayMs;',
  '}',
  '',
].join('\n');

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrfc-chain-ws-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture Owner']);
  git(root, ['config', 'user.email', 'owner@example.test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'retry.ts'), RETRY_V1);
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

function open(root: string, chainId = 'wrfc-abc12345'): WrfcChainWorkspace {
  const opened = openChainWorkspace(root, chainId);
  if (opened.kind !== 'isolated') throw new Error(`expected isolation, got ${JSON.stringify(opened)}`);
  return opened.workspace;
}

describe('WRFC chain workspace', () => {
  test('a non-git directory reports not-a-repository (no isolation possible)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'wrfc-chain-plain-'));
    expect(openChainWorkspace(plain, 'wrfc-x').kind).toBe('not-a-repository');
  });

  test('the chain works in its own worktree that starts from the user\'s current files, uncommitted edits included, without touching the user\'s index', () => {
    const root = makeRepo();
    // Uncommitted edit at the top of the file the chain will change, and an untracked file.
    writeFileSync(join(root, 'src', 'retry.ts'), RETRY_V1.replace('// retry helper', '// retry helper (owner note, uncommitted)'));
    writeFileSync(join(root, 'notes.txt'), 'untracked owner notes\n');
    const statusBefore = git(root, ['status', '--porcelain']);

    const ws = open(root);
    expect(ws.path).toBe(join(root, '.goodvibes', '.worktrees', 'wrfc', 'abc12345'));
    expect(ws.branch).toBe('wrfc/abc12345');
    expect(git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wrfc/abc12345');
    expect(readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8')).toContain('owner note, uncommitted');
    expect(readFileSync(join(ws.path, 'notes.txt'), 'utf8')).toBe('untracked owner notes\n');
    expect([...ws.startedWithUncommitted].sort()).toEqual(['notes.txt', 'src/retry.ts']);
    // The user's index and working tree are exactly as they were.
    expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '')).toBe(statusBefore);
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    releaseChainWorkspace(ws);
  });

  test('on pass the commit carries only the chain\'s changes; earlier uncommitted edits survive in the working copy and stay out of the commit', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'src', 'retry.ts'), RETRY_V1.replace('// retry helper', '// retry helper (owner note, uncommitted)'));
    writeFileSync(join(root, 'notes.txt'), 'untracked owner notes\n');
    const ws = open(root);

    // The chain edits the bottom of retry.ts (away from the owner's edit) and adds a test file.
    const chainRetry = readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);');
    writeFileSync(join(ws.path, 'src', 'retry.ts'), chainRetry);
    mkdirSync(join(ws.path, 'test'), { recursive: true });
    writeFileSync(join(ws.path, 'test', 'retry.test.ts'), 'export const covered = true;\n');
    // The user's directory is untouched while the chain runs.
    expect(existsSync(join(root, 'test', 'retry.test.ts'))).toBe(false);

    const result = landChainWorkspace(ws, { commit: true, message: 'WRFC: cap the retry delay' });
    expect(result.status).toBe('committed');
    expect([...result.files].sort()).toEqual(['src/retry.ts', 'test/retry.test.ts']);
    expect(result.keptUncommitted).toEqual(['src/retry.ts']);
    expect(result.note).toContain('your uncommitted edits in src/retry.ts were kept in place and are not part of that commit');

    // The commit: only the chain's lines, author is the repository identity.
    const committed = git(root, ['show', 'HEAD:src/retry.ts']);
    expect(committed).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(committed).not.toContain('owner note, uncommitted');
    expect(git(root, ['show', '--name-only', '--format=%an', 'HEAD']).trim().split('\n')).toEqual(['Fixture Owner', '', 'src/retry.ts', 'test/retry.test.ts']);
    expect(git(root, ['ls-files', 'notes.txt']).trim()).toBe('');

    // The working copy: both the owner's edit and the chain's change; the owner's edit is still an uncommitted change.
    const working = readFileSync(join(root, 'src', 'retry.ts'), 'utf8');
    expect(working).toContain('owner note, uncommitted');
    expect(working).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(git(root, ['diff', '--name-only']).trim()).toBe('src/retry.ts');
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('untracked owner notes\n');
    expect(readFileSync(join(root, 'test', 'retry.test.ts'), 'utf8')).toBe('export const covered = true;\n');

    // Fully landed: worktree directory and chain branch are gone.
    expect(result.branchKept).toBe(false);
    expect(existsSync(ws.path)).toBe(false);
    expect(git(root, ['branch', '--list', 'wrfc/*']).trim()).toBe('');
  });

  test('a chain change that builds on uncommitted edits is never committed with them: nothing is committed, the work is applied and kept on the branch, and the note says so', () => {
    const root = makeRepo();
    // The owner's uncommitted edit changes the very line the chain will build on.
    writeFileSync(join(root, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs * 2 ** i;'));
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs * 2 ** i;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));

    const result = landChainWorkspace(ws, { commit: true, message: 'WRFC: cap' });
    expect(result.status).toBe('applied');
    expect(result.heldFiles).toEqual(['src/retry.ts']);
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(result.note).toContain('nothing was committed');
    expect(result.note).toContain('branch wrfc/abc12345');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(result.branchKept).toBe(true);
    expect(git(root, ['branch', '--list', 'wrfc/abc12345']).trim()).toContain('wrfc/abc12345');
  });

  test('uncommitted edits made after the chain started that overlap its change are left exactly as they are, and named', () => {
    const root = makeRepo();
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs + 1;'));
    // The owner edits the same line while the chain runs.
    const ownerVersion = RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs * 3;');
    writeFileSync(join(root, 'src', 'retry.ts'), ownerVersion);

    const result = landChainWorkspace(ws, { commit: true, message: 'WRFC: plus one' });
    expect(result.status).toBe('committed');
    expect(git(root, ['show', 'HEAD:src/retry.ts'])).toContain('baseDelayMs + 1');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toBe(ownerVersion);
    expect(result.leftAsIs).toEqual(['src/retry.ts']);
    expect(result.note).toContain('src/retry.ts was left exactly as you had it');
    expect(result.branchKept).toBe(true);
  });

  test('with auto-commit off the chain\'s changes are applied to the working copy without a commit', () => {
    const root = makeRepo();
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const ws = open(root);
    writeFileSync(join(ws.path, 'README.md'), '# demo\n\nMore.\n');
    const result = landChainWorkspace(ws, { commit: false, message: 'unused', noCommitReason: 'auto-commit is off' });
    expect(result.status).toBe('applied');
    expect(result.note).toContain('auto-commit is off, so the chain\'s changes to 1 file (README.md) were applied to your working copy without a commit');
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo\n\nMore.\n');
  });

  test('a chain that stops keeps its work on the branch and never touches the user\'s files', () => {
    const root = makeRepo();
    const ws = open(root);
    writeFileSync(join(ws.path, 'README.md'), '# partial\n');
    const released = releaseChainWorkspace(ws);
    expect(released.branchKept).toBe(true);
    expect(released.note).toContain('kept on branch wrfc/abc12345');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(existsSync(ws.path)).toBe(false);
    expect(git(root, ['show', 'wrfc/abc12345:README.md'])).toBe('# partial\n');
  });
});
