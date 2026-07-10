/**
 * worktree-setup.test.ts
 *
 * Worktree cold-start setup: the runner's honest states (skipped/succeeded/
 * failed), command sequencing (stop on first failure), untracked-file
 * carry-over, config resolution, and the worktrees.setup.run rerun verb over a
 * real GatewayMethodCatalog.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWorktreeSetup,
  resolveWorktreeSetupConfig,
  type WorktreeCommandRunner,
} from '../packages/sdk/src/platform/runtime/worktree/setup.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  registerWorktreeSetupGatewayMethods,
} from '../packages/sdk/src/platform/control-plane/routes/worktree-setup.ts';
import type { WorktreeSetupResult } from '../packages/sdk/src/platform/runtime/worktree/setup.ts';

const ctx = { context: { admin: true } } as const;
const okRunner: WorktreeCommandRunner = async () => ({ exitCode: 0, output: 'ok' });

describe('runWorktreeSetup', () => {
  test('skipped when nothing is configured', async () => {
    const result = await runWorktreeSetup('/wt', '/src', { commands: [], carryOverGlobs: [] }, { runCommand: okRunner });
    expect(result.state).toBe('skipped');
    expect(result.steps).toEqual([]);
  });

  test('succeeded runs every command in order', async () => {
    const ran: string[] = [];
    const runner: WorktreeCommandRunner = async (cmd) => { ran.push(cmd); return { exitCode: 0, output: `${cmd} done` }; };
    const result = await runWorktreeSetup('/wt', '/src', { commands: ['bun install', 'bun run codegen'], carryOverGlobs: [] }, { runCommand: runner });
    expect(result.state).toBe('succeeded');
    expect(ran).toEqual(['bun install', 'bun run codegen']);
    expect(result.steps.map((s) => s.ok)).toEqual([true, true]);
  });

  test('failed on the first non-zero command, and later commands do not run', async () => {
    const ran: string[] = [];
    const runner: WorktreeCommandRunner = async (cmd) => {
      ran.push(cmd);
      return cmd === 'bun install' ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: 'ok' };
    };
    const result = await runWorktreeSetup('/wt', '/src', { commands: ['bun install', 'bun run codegen'], carryOverGlobs: [] }, { runCommand: runner });
    expect(result.state).toBe('failed');
    expect(ran).toEqual(['bun install']);
    expect(result.error).toContain('exited 1');
    expect(result.steps[0]!.output).toBe('boom');
  });

  test('carries over untracked files matching the globs and ignores non-matching ones', async () => {
    const src = mkdtempSync(join(tmpdir(), 'wt-src-'));
    const wt = mkdtempSync(join(tmpdir(), 'wt-dst-'));
    writeFileSync(join(src, '.env'), 'SECRET=1\n');
    mkdirSync(join(src, 'config'), { recursive: true });
    writeFileSync(join(src, 'config', 'local.json'), '{"x":1}\n');
    writeFileSync(join(src, 'notes.txt'), 'ignore me\n');

    const result = await runWorktreeSetup(wt, src, { commands: [], carryOverGlobs: ['.env', 'config/**'] }, {
      runCommand: okRunner,
      listUntracked: async () => ['.env', 'config/local.json', 'notes.txt'],
    });

    expect(result.state).toBe('succeeded');
    expect(existsSync(join(wt, '.env'))).toBe(true);
    expect(readFileSync(join(wt, '.env'), 'utf-8')).toBe('SECRET=1\n');
    expect(existsSync(join(wt, 'config', 'local.json'))).toBe(true);
    expect(existsSync(join(wt, 'notes.txt'))).toBe(false);
    const carryStep = result.steps.find((s) => s.kind === 'carry-over');
    expect(carryStep?.output.split('\n').sort()).toEqual(['.env', 'config/local.json']);
  });
});

describe('resolveWorktreeSetupConfig', () => {
  test('reads string arrays and drops malformed values', () => {
    const config = resolveWorktreeSetupConfig((key) => {
      if (key === 'worktree.setup.commands') return ['bun install', 42, '', 'bun run codegen'];
      if (key === 'worktree.setup.carryOverGlobs') return '.env';
      return undefined;
    });
    expect(config.commands).toEqual(['bun install', 'bun run codegen']);
    expect(config.carryOverGlobs).toEqual([]);
  });
});

describe('worktrees.setup.run gateway verb', () => {
  test('descriptor + handler register together, and the result is recorded onto the registry', async () => {
    const recorded: { path: string; setup: WorktreeSetupResult }[] = [];
    const catalog = new GatewayMethodCatalog();
    registerWorktreeSetupGatewayMethods(catalog, {
      registry: { recordSetup: (path, setup) => recorded.push({ path, setup }) },
      sourceRoot: '/src',
      resolveConfig: () => ({ commands: [], carryOverGlobs: [] }),
    });

    expect(catalog.hasHandler('worktrees.setup.run')).toBe(true);
    const out = await catalog.invoke('worktrees.setup.run', { ...ctx, body: { path: '/wt/agent-1' } }) as { path: string; setup: WorktreeSetupResult };
    expect(out.path).toBe('/wt/agent-1');
    expect(out.setup.state).toBe('skipped');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.path).toBe('/wt/agent-1');
  });

  test('a missing path is an honest 400', async () => {
    const catalog = new GatewayMethodCatalog();
    registerWorktreeSetupGatewayMethods(catalog, {
      registry: { recordSetup: () => {} },
      sourceRoot: '/src',
      resolveConfig: () => ({ commands: [], carryOverGlobs: [] }),
    });
    await expect(catalog.invoke('worktrees.setup.run', { ...ctx, body: {} })).rejects.toThrow(/path/);
  });
});
