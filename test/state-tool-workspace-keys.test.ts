import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createStateTool } from '../packages/sdk/src/_internal/platform/tools/state/index.ts';
import { KVState } from '../packages/sdk/src/_internal/platform/state/kv-state.ts';
import { ProjectIndex } from '../packages/sdk/src/_internal/platform/state/project-index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const d = join(tmpdir(), `gv-state-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeStateTool(
  workingDir: string,
  daemonHomeDir: string,
  swapManager?: { requestSwap(newDir: string): Promise<{ ok: boolean; reason?: string; code?: string }> },
) {
  const memDir = join(tempDir(), 'memory');
  mkdirSync(memDir, { recursive: true });
  const stateDir = join(tempDir(), 'state');
  mkdirSync(stateDir, { recursive: true });
  const kvState = new KVState({ stateDir });
  const projectIndex = new ProjectIndex(workingDir);
  return createStateTool(kvState, projectIndex, {
    memoryDir: memDir,
    workingDir,
    daemonHomeDir,
    swapManager,
  });
}

// ---------------------------------------------------------------------------
// B7 — Well-known keys: get behavior
// ---------------------------------------------------------------------------

describe('state tool — well-known key reads', () => {
  test('get runtime.workingDir returns the workingDir value', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'get', keys: ['runtime.workingDir'] });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.values['runtime.workingDir']).toBe('/abc');
  });

  test('get daemon.homeDir returns the daemonHomeDir value', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'get', keys: ['daemon.homeDir'] });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.values['daemon.homeDir']).toBe('/def');
  });
});

// ---------------------------------------------------------------------------
// B7 — Well-known keys: set behavior
// ---------------------------------------------------------------------------

describe('state tool — runtime.workingDir set', () => {
  test('set runtime.workingDir triggers swap manager', async () => {
    const calls: string[] = [];
    const mockSwap = {
      requestSwap: async (newDir: string) => {
        calls.push(newDir);
        return { ok: true };
      },
    };
    const tool = makeStateTool('/abc', '/def', mockSwap);
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(true);
    expect(calls).toEqual(['/xyz']);
  });

  test('set runtime.workingDir without swap manager returns error', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no swap manager/);
  });

  test('set daemon.homeDir returns error with READONLY_KEY or equivalent', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'set', values: { 'daemon.homeDir': '/xyz' } });
    expect(result.success).toBe(false);
    // Must indicate the key is read-only and NOT mutate
    expect(result.error).toMatch(/read-only|immutable/i);
  });

  test('set daemon.homeDir does NOT mutate even with swap manager present', async () => {
    const calls: string[] = [];
    const mockSwap = {
      requestSwap: async (newDir: string) => {
        calls.push(newDir);
        return { ok: true };
      },
    };
    const tool = makeStateTool('/abc', '/def', mockSwap);
    const result = await tool.execute({ mode: 'set', values: { 'daemon.homeDir': '/xyz' } });
    expect(result.success).toBe(false);
    // swap manager must not have been called for daemon.homeDir
    expect(calls).toEqual([]);
  });
});
