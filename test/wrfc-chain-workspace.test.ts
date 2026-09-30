/**
 * A WRFC chain works in its own git worktree and, once it passes, commits only
 * its own changes: edits the user had not committed before the chain started
 * are never swept into the chain's commit, and they survive in the user's
 * working copy (defect: chain commit aa3fa19 committed whole files including
 * the fixture's uncommitted backoff edit and a previously untracked test).
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeChainIsolation,
  landChainWorkspace,
  openChainWorkspace,
  releaseChainWorkspace,
  type WrfcChainWorkspace,
} from '../packages/sdk/src/platform/agents/wrfc-chain-workspace.js';
import { FileUndoManager } from '../packages/sdk/src/platform/state/file-undo.js';
import { clearToolEditRecords } from '../packages/sdk/src/platform/state/tool-edit-record.js';
import { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.js';
import { createEditTool } from '../packages/sdk/src/platform/tools/edit/index.js';

/** An edit made the way GoodVibes' write/edit tools make one: write the file, then the undo snapshot every tool call ends in. */
function toolEdit(path: string, content: string): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  writeFileSync(path, content);
  new FileUndoManager().snapshot({ path, beforeContent: before, afterContent: content, tool: 'edit' });
}

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

  test('on pass the commit carries only the chain\'s changes; earlier uncommitted edits survive in the working copy and stay out of the commit', async () => {
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

    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap the retry delay' });
    expect(result.status).toBe('committed');
    expect([...result.files].sort()).toEqual(['src/retry.ts', 'test/retry.test.ts']);
    expect(result.keptUncommitted).toEqual(['src/retry.ts', 'notes.txt']);
    expect(result.note).toContain('your uncommitted edits in src/retry.ts, notes.txt were kept in place and are not part of that commit');

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

  test('a chain change that builds on uncommitted edits is never committed with them: nothing is committed, the work is applied and kept on the branch, and the note says so', async () => {
    const root = makeRepo();
    // The owner's uncommitted edit changes the very line the chain will build on.
    writeFileSync(join(root, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs * 2 ** i;'));
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs * 2 ** i;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));

    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap' });
    expect(result.status).toBe('applied');
    expect(result.heldFiles).toEqual(['src/retry.ts']);
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(result.note).toContain('nothing was committed');
    expect(result.note).toContain('branch wrfc/abc12345');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(result.branchKept).toBe(true);
    expect(git(root, ['branch', '--list', 'wrfc/abc12345']).trim()).toContain('wrfc/abc12345');
  });

  test('uncommitted edits made after the chain started that overlap its change are left exactly as they are, and named', async () => {
    const root = makeRepo();
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs + 1;'));
    // The owner edits the same line while the chain runs.
    const ownerVersion = RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs * 3;');
    writeFileSync(join(root, 'src', 'retry.ts'), ownerVersion);

    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: plus one' });
    expect(result.status).toBe('committed');
    expect(git(root, ['show', 'HEAD:src/retry.ts'])).toContain('baseDelayMs + 1');
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toBe(ownerVersion);
    expect(result.leftAsIs).toEqual(['src/retry.ts']);
    expect(result.note).toContain('src/retry.ts was left exactly as you had it');
    expect(result.branchKept).toBe(true);
  });

  test('with auto-commit off the chain\'s changes are applied to the working copy without a commit', async () => {
    const root = makeRepo();
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const ws = open(root);
    writeFileSync(join(ws.path, 'README.md'), '# demo\n\nMore.\n');
    const result = await landChainWorkspace(ws, { commit: false, message: 'unused', noCommitReason: 'auto-commit is off' });
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

  function installHook(root: string, name: string, body: string): void {
    const hooksDir = join(root, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(hooksDir, name), 0o755);
  }

  test('the chain\'s commit runs the repository\'s pre-commit and commit-msg hooks, which see only the chain\'s changes; the user\'s uncommitted edit stays uncommitted', async () => {
    const root = makeRepo();
    const markers = mkdtempSync(join(tmpdir(), 'wrfc-hook-marker-'));
    const marker = join(markers, 'pre-commit.txt');
    // The hook records that it ran, what is staged, and what the file it would lint holds.
    installHook(root, 'pre-commit', [
      `echo "pre-commit ran" > "${marker}"`,
      `git diff --cached --name-only >> "${marker}"`,
      `cat src/retry.ts >> "${marker}"`,
    ].join('\n'));
    installHook(root, 'commit-msg', 'echo "Hook-Checked: yes" >> "$1"');
    const ownerEdit = RETRY_V1.replace('// retry helper', '// retry helper (owner note, uncommitted)');
    writeFileSync(join(root, 'src', 'retry.ts'), ownerEdit);
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));

    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap the retry delay' });
    expect(result.status).toBe('committed');

    // The hook ran, saw only the chain's file staged, and never saw the owner's uncommitted edit.
    expect(existsSync(marker)).toBe(true);
    const seen = readFileSync(marker, 'utf8');
    expect(seen).toContain('pre-commit ran\nsrc/retry.ts\n');
    expect(seen).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(seen).not.toContain('owner note, uncommitted');
    // The commit landed on the user's branch, with the commit-msg hook's line.
    expect(git(root, ['rev-parse', 'HEAD~1']).trim()).toBe(headBefore);
    expect(git(root, ['log', '-1', '--format=%B']).trim()).toBe('WRFC: cap the retry delay\nHook-Checked: yes');
    expect(git(root, ['show', 'HEAD:src/retry.ts'])).not.toContain('owner note, uncommitted');
    // The owner's edit is still in the working copy and still uncommitted.
    const working = readFileSync(join(root, 'src', 'retry.ts'), 'utf8');
    expect(working).toContain('owner note, uncommitted');
    expect(working).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(git(root, ['diff', '--name-only']).trim()).toBe('src/retry.ts');
    expect(git(root, ['diff'])).toContain('+// retry helper (owner note, uncommitted)');
    expect(git(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(git(root, ['branch', '--list', 'wrfc/*']).trim()).toBe('');
  });

  test('a file a pre-commit hook changes is committed as the hook left it and reaches the working copy', async () => {
    const root = makeRepo();
    installHook(root, 'pre-commit', 'printf "generated\\n" > GENERATED.txt && git add GENERATED.txt');
    const ws = open(root);
    writeFileSync(join(ws.path, 'README.md'), '# demo\n\nMore.\n');
    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: readme' });
    expect(result.status).toBe('committed');
    expect([...result.files].sort()).toEqual(['GENERATED.txt', 'README.md']);
    expect(git(root, ['show', 'HEAD:GENERATED.txt'])).toBe('generated\n');
    expect(readFileSync(join(root, 'GENERATED.txt'), 'utf8')).toBe('generated\n');
    expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '').trim()).toBe('');
  });

  test('a hook that refuses the commit is reported in its own words; nothing lands, the user\'s files are untouched, and the work stays on the chain branch', async () => {
    const root = makeRepo();
    installHook(root, 'pre-commit', 'echo "lint: retry.ts uses a magic number" >&2\nexit 1');
    const ownerEdit = RETRY_V1.replace('// retry helper', '// retry helper (owner note, uncommitted)');
    writeFileSync(join(root, 'src', 'retry.ts'), ownerEdit);
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    const statusBefore = git(root, ['status', '--porcelain']);
    const ws = open(root);
    writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));

    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap the retry delay' });
    expect(result.status).toBe('refused');
    expect(result.refusal).toBe('lint: retry.ts uses a magic number');
    expect(result.note).toContain("your repository's commit hooks refused the chain's commit, so nothing was committed and your files were not changed");
    expect(result.note).toContain('kept on branch wrfc/abc12345');
    expect(result.note).toContain('lint: retry.ts uses a magic number');
    expect(result.branchKept).toBe(true);
    // Nothing landed and the user's files are exactly as they were.
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toBe(ownerEdit);
    expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '')).toBe(statusBefore);
    // The chain's work is on its branch.
    expect(git(root, ['show', 'wrfc/abc12345:src/retry.ts'])).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
    expect(existsSync(ws.path)).toBe(false);
  });

  test('in a repository with no commits yet the chain\'s first commit runs the hooks and becomes the branch\'s first commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wrfc-chain-empty-'));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Fixture Owner']);
    git(root, ['config', 'user.email', 'owner@example.test']);
    const marker = join(mkdtempSync(join(tmpdir(), 'wrfc-hook-marker-')), 'ran');
    installHook(root, 'pre-commit', `git diff --cached --name-only > "${marker}"`);
    const ws = open(root);
    writeFileSync(join(ws.path, 'hello.ts'), 'export const hello = 1;\n');
    const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: first file' });
    expect(result.status).toBe('committed');
    expect(readFileSync(marker, 'utf8')).toBe('hello.ts\n');
    expect(git(root, ['log', '--format=%s']).trim()).toBe('WRFC: first file');
    expect(readFileSync(join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
    expect(git(root, ['branch', '--list']).trim()).toBe('* main');
  });

  test('a chain stopped while its commit hooks run leaves the worktree to the landing, which still commits', async () => {
    const root = makeRepo();
    installHook(root, 'pre-commit', 'sleep 1');
    const ws = open(root);
    writeFileSync(join(ws.path, 'README.md'), '# demo\n\nMore.\n');
    const landing = landChainWorkspace(ws, { commit: true, message: 'WRFC: readme' });
    await Bun.sleep(200);
    const released = releaseChainWorkspace(ws);
    expect(released.note).toBe("the chain's passed work was already being committed");
    const result = await landing;
    expect(result.status).toBe('committed');
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe('WRFC: readme');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo\n\nMore.\n');
  });

  describe('uncommitted edits GoodVibes made itself are committed with the chain; the user\'s stay out', () => {
    test('a tool edit made before the chain is part of the chain commit, a hand edit is not, and the pre-commit hook runs and sees only GoodVibes\' work', async () => {
      clearToolEditRecords();
      const root = makeRepo();
      const marker = join(mkdtempSync(join(tmpdir(), 'wrfc-hook-marker-')), 'staged.txt');
      installHook(root, 'pre-commit', `git diff --cached --name-only > "${marker}"\ncat src/retry.ts >> "${marker}"`);
      // GoodVibes' main session edited README.md and created src/util.ts through its tools; nobody committed them.
      toolEdit(join(root, 'README.md'), '# demo\n\nEdited by the GoodVibes edit tool.\n');
      toolEdit(join(root, 'src', 'util.ts'), 'export const clamp = (n: number, max: number) => Math.min(n, max);\n');
      // The user edited the top of retry.ts by hand.
      const handEdit = RETRY_V1.replace('// retry helper', '// retry helper (hand edit, uncommitted)');
      writeFileSync(join(root, 'src', 'retry.ts'), handEdit);
      const ws = open(root);
      expect(describeChainIsolation(ws)).toContain("GoodVibes' own edits in README.md, src/util.ts, which it commits with its work");
      writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));

      const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap the retry delay' });
      expect(result.status).toBe('committed');
      expect([...(result.committedToolEdits ?? [])].sort()).toEqual(['README.md', 'src/util.ts']);
      expect(result.keptUncommitted).toEqual(['src/retry.ts']);
      expect(result.note).toContain("GoodVibes' own uncommitted edits in");
      expect(result.note).toContain('your uncommitted edits in src/retry.ts were kept in place and are not part of that commit');
      // The commit: the chain's change and GoodVibes' edits, never the hand edit.
      expect(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(['README.md', 'src/retry.ts', 'src/util.ts']);
      expect(git(root, ['show', 'HEAD:README.md'])).toContain('Edited by the GoodVibes edit tool.');
      expect(git(root, ['show', 'HEAD:src/retry.ts'])).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
      expect(git(root, ['show', 'HEAD:src/retry.ts'])).not.toContain('hand edit');
      // The hook ran on exactly that commit.
      const seen = readFileSync(marker, 'utf8');
      expect(seen.startsWith('README.md\nsrc/retry.ts\nsrc/util.ts\n')).toBe(true);
      expect(seen).not.toContain('hand edit');
      // The hand edit is untouched and still uncommitted; GoodVibes' files are clean.
      expect(readFileSync(join(root, 'src', 'retry.ts'), 'utf8')).toContain('(hand edit, uncommitted)');
      expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '').trim()).toBe('M src/retry.ts');
    });

    test('a file GoodVibes edited and the user then changed by hand is the user\'s: kept out and untouched', async () => {
      clearToolEditRecords();
      const root = makeRepo();
      toolEdit(join(root, 'README.md'), '# demo\n\nTool line.\n');
      writeFileSync(join(root, 'README.md'), '# demo\n\nTool line.\nHand line.\n');
      const ws = open(root);
      writeFileSync(join(ws.path, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs + 1;'));
      const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: plus one' });
      expect(result.status).toBe('committed');
      expect(result.committedToolEdits).toBeUndefined();
      expect(result.keptUncommitted).toEqual(['README.md']);
      expect(git(root, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('src/retry.ts');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo\n\nTool line.\nHand line.\n');
    });

    test('a chain change that builds on GoodVibes\' own uncommitted edit is committed with it instead of being held', async () => {
      clearToolEditRecords();
      const root = makeRepo();
      toolEdit(join(root, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs * 2 ** i;'));
      const ws = open(root);
      writeFileSync(join(ws.path, 'src', 'retry.ts'), readFileSync(join(ws.path, 'src', 'retry.ts'), 'utf8').replace('  return opts.baseDelayMs * 2 ** i;', '  return Math.min(opts.baseDelayMs * 2 ** i, 30_000);'));
      const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: cap' });
      expect(result.status).toBe('committed');
      expect(result.heldFiles).toEqual([]);
      expect(git(root, ['show', 'HEAD:src/retry.ts'])).toContain('Math.min(opts.baseDelayMs * 2 ** i, 30_000)');
      expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '').trim()).toBe('');
    });

    test('an edit made through the real edit tool before the chain is committed with the chain\'s changes', async () => {
      clearToolEditRecords();
      const root = makeRepo();
      const editTool = createEditTool(new FileStateCache(), { cwd: root, fileUndoManager: new FileUndoManager() });
      const edited = await editTool.execute({ edits: [{ path: 'README.md', find: '# demo', replace: '# demo (edited by the edit tool)' }] });
      expect(edited.success).toBe(true);
      const ws = open(root);
      writeFileSync(join(ws.path, 'src', 'retry.ts'), RETRY_V1.replace('  return opts.baseDelayMs;', '  return opts.baseDelayMs + 1;'));
      const result = await landChainWorkspace(ws, { commit: true, message: 'WRFC: plus one' });
      expect(result.status).toBe('committed');
      expect(result.committedToolEdits).toEqual(['README.md']);
      expect(git(root, ['show', 'HEAD:README.md'])).toBe('# demo (edited by the edit tool)\n');
      expect(git(root, ['status', '--porcelain']).replace(/^\?\? \.goodvibes\/\n/m, '').trim()).toBe('');
    });
  });
});
