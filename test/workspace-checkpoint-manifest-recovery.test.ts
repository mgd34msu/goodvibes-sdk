/**
 * workspace-checkpoint-manifest-recovery.test.ts
 *
 * WorkspaceCheckpointManager.init() used to cache its own rejection: every
 * public method starts with `await this.init()`, so one failed init disabled
 * create/list/diff/restore/gc for the rest of the process's life. The worst
 * trigger was an index.json left unparseable by an unclean shutdown, which
 * JsonFileStore reports by throwing, so the checkpoint safety net stayed dead
 * across restarts too, with no recovery short of deleting the file by hand.
 *
 * These pin both halves: a failed init is retryable, and an unreadable manifest
 * is quarantined and rebuilt instead of wedging the manager.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../packages/sdk/src/platform/workspace/checkpoint/manager.js';
import { JsonFileStore } from '../packages/sdk/src/platform/state/json-file-store.js';

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function checkpointsDir(root: string): string {
  return join(root, '.goodvibes', 'checkpoints');
}

describe('checkpoint manifest recovery', () => {
  test('a failed init does not stick: the next call retries instead of replaying the rejection', async () => {
    const root = tempWorkspace('wcp-init-retry-');
    try {
      // A regular file where the side repo's GIT_DIR belongs makes `git init` fail.
      mkdirSync(checkpointsDir(root), { recursive: true });
      writeFileSync(join(checkpointsDir(root), 'git'), 'not a directory\n');

      const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
      await expect(manager.init()).rejects.toThrow();

      // Clear the obstruction the way an operator would, then retry. Before the
      // fix this rethrew the cached rejection forever and every checkpoint API
      // stayed dead for the life of the process.
      rmSync(join(checkpointsDir(root), 'git'), { force: true });
      await manager.init();

      writeFileSync(join(root, 'a.txt'), 'a'.repeat(200));
      const checkpoint = await manager.create({ kind: 'manual', label: 'after-retry' });
      expect(checkpoint).not.toBeNull();
      expect(await manager.list()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreadable manifest is quarantined and the manager keeps working', async () => {
    const root = tempWorkspace('wcp-torn-manifest-');
    try {
      const first = new WorkspaceCheckpointManager({ workspaceRoot: root });
      writeFileSync(join(root, 'a.txt'), 'a'.repeat(200));
      expect(await first.create({ kind: 'manual', label: 'cp1' })).not.toBeNull();

      // What an unclean shutdown can leave behind: the renamed file is there,
      // but its contents were never flushed, so it does not parse.
      const manifestPath = join(checkpointsDir(root), 'index.json');
      expect(existsSync(manifestPath)).toBe(true);
      writeFileSync(manifestPath, '{"checkpoints": [{"id": "wcp_tor');

      const second = new WorkspaceCheckpointManager({ workspaceRoot: root });
      // Before the fix this threw `JsonFileStore failed to load ...` and kept
      // throwing for every later call on this manager.
      await second.init();
      expect(await second.list()).toEqual([]);

      const quarantined = readdirSync(checkpointsDir(root)).filter((name) => name.startsWith('index.json.corrupt-'));
      expect(quarantined.filter((name) => !name.endsWith('.why'))).toHaveLength(1);

      writeFileSync(join(root, 'b.txt'), 'b'.repeat(200));
      const rebuilt = await second.create({ kind: 'manual', label: 'cp2' });
      expect(rebuilt).not.toBeNull();
      const reloaded = JSON.parse(readFileSync(manifestPath, 'utf8')) as { checkpoints: unknown[] };
      expect(reloaded.checkpoints).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('JsonFileStore.save leaves no temp file behind and round-trips', async () => {
    const dir = tempWorkspace('json-file-store-');
    try {
      const store = new JsonFileStore<{ n: number }>(join(dir, 'nested', 'state.json'));
      await store.save({ n: 1 });
      await store.save({ n: 2 });

      expect(await store.load()).toEqual({ n: 2 });
      const leftovers = readdirSync(join(dir, 'nested')).filter((name) => name.includes('.tmp.'));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
