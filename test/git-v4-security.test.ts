import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimpleGit } from '../packages/sdk/src/platform/git/optional-simple-git.js';
import { detectGitToplevel, SideGitRunner } from '../packages/sdk/src/platform/workspace/checkpoint/side-git.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8').trim();
}

async function withEnv(values: Record<string, string>, action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('simple-git v4 security and checkpoint compatibility', () => {
  test('side repository snapshots and restores despite inherited repo, index, config, and VISUAL overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-v4-side-'));
    const decoy = mkdtempSync(join(tmpdir(), 'git-v4-decoy-'));
    try {
      runGit(decoy, ['init', '--quiet']);
      writeFileSync(join(decoy, 'untouched.txt'), 'outside workspace\n');
      runGit(decoy, ['add', 'untouched.txt']);
      const decoyIndex = readFileSync(join(decoy, '.git', 'index'));
      const decoyConfig = readFileSync(join(decoy, '.git', 'config'));
      writeFileSync(join(root, 'snapshot.txt'), 'before\n');

      await withEnv({
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoy, '.git', 'index'),
        GIT_OBJECT_DIRECTORY: join(decoy, '.git', 'objects'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.editor',
        GIT_CONFIG_VALUE_0: 'sdk-test-editor-must-not-run',
        GIT_CONFIG_PARAMETERS: "'core.editor=sdk-test-editor-must-not-run'",
        VISUAL: 'sdk-test-editor-must-not-run',
        ViSuAl: 'sdk-test-editor-must-not-run',
      }, async () => {
        const side = new SideGitRunner({ workspaceRoot: root, gitDir: join(root, '.goodvibes', 'checkpoints', 'git') });
        await side.init();
        expect(realpathSync((await side.raw(['rev-parse', '--absolute-git-dir'])).trim())).toBe(realpathSync(side.gitDir));
        await side.stageAll();
        const commit = await side.commitTree(await side.writeTree(), 'security regression snapshot');
        expect(commit).toMatch(/^[0-9a-f]{40}$/);
        writeFileSync(join(root, 'snapshot.txt'), 'after\n');
        await side.readTreeReset(commit);
        await side.checkoutIndexAll();
        expect(readFileSync(join(root, 'snapshot.txt'), 'utf8')).toBe('before\n');
        await expect(side.raw(['-c', 'trailer.security.cmd=sdk-test-command-must-not-run', 'status']))
          .rejects.toThrow('not permitted');
      });

      expect(existsSync(join(root, '.git'))).toBe(false);
      expect(readFileSync(join(decoy, '.git', 'index'))).toEqual(decoyIndex);
      expect(readFileSync(join(decoy, '.git', 'config'))).toEqual(decoyConfig);
      expect(readFileSync(join(decoy, 'untouched.txt'), 'utf8')).toBe('outside workspace\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test('real-repository discovery ignores inherited overrides and still honors its ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-v4-discovery-'));
    try {
      runGit(root, ['init', '--quiet']);
      const ceiling = join(root, 'ceiling');
      const child = join(ceiling, 'child');
      mkdirSync(child, { recursive: true });
      await withEnv({
        GIT_DIR: join(root, 'nonexistent.git'),
        GIT_WORK_TREE: join(root, 'nonexistent-worktree'),
        VISUAL: 'sdk-test-editor-must-not-run',
      }, async () => {
        expect(realpathSync((await detectGitToplevel(child))!)).toBe(realpathSync(root));
        await withEnv({ GIT_CEILING_DIRECTORIES: realpathSync(ceiling) }, async () => {
          expect(await detectGitToplevel(child)).toBeNull();
          // The common optional loader must also preserve this boundary for
          // GitService/worktree clients, including its string options form.
          const git = await createSimpleGit(child);
          await expect(Promise.resolve(git.raw(['rev-parse', '--show-toplevel']))).rejects.toThrow('not a git repository');
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explicit unsafe editor and unexpected repository overrides remain blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-v4-env-guard-'));
    try {
      for (const env of [
        { VISUAL: 'sdk-test-editor-must-not-run' },
        { GIT_DIR: join(root, 'unapproved.git') },
      ]) {
        const git = await createSimpleGit({ baseDir: root });
        await expect(Promise.resolve(git.env(env).raw(['status']))).rejects.toThrow(/not permitted|environment guard/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('trailer commands and unconditional/conditional config includes remain blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-v4-config-guard-'));
    try {
      runGit(root, ['init', '--quiet']);
      for (const config of [
        'trailer.security.cmd=sdk-test-command-must-not-run',
        `include.path=${join(root, 'untrusted.config')}`,
        `includeIf.gitdir:${root}/.path=${join(root, 'untrusted.config')}`,
      ]) {
        const git = await createSimpleGit({ baseDir: root });
        await expect(Promise.resolve(git.raw(['-c', config, 'status']))).rejects.toThrow('not permitted');
      }
      const git = await createSimpleGit({ baseDir: root });
      await expect(Promise.resolve(git.raw(['push', '--receive-p=sdk-test-command-must-not-run'])))
        .rejects.toThrow(/abbreviat|unknown option/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
