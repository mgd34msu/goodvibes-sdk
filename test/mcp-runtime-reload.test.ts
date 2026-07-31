/**
 * mcp-runtime-reload.test.ts — startMcpConfigAutoReload.
 *
 * The watcher polls the stat signature (existence, mtime, size) of every
 * candidate MCP config path and reloads the registry when one changes. Three
 * behaviours are load-bearing and all three are easy to regress:
 *
 *  - a poll tick that sees no change must NOT reload (otherwise the registry
 *    is torn down and rebuilt every couple of seconds forever);
 *  - a reload already in flight must not be re-entered by the next tick;
 *  - stop() must be final — a reload must not land after the handle is closed.
 *
 * The poll interval floors at 500ms, so each test waits just past one tick
 * rather than trying to force the timer — the floor itself is one of the
 * behaviours under test, and a mocked clock would step straight over it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpConfigRoots, McpRegistry, McpReloadResult } from '@pellux/goodvibes-sdk/platform/mcp';
import { startMcpConfigAutoReload } from '@pellux/goodvibes-terminal-shell';

const EMPTY_RELOAD: McpReloadResult = {
  added: 0,
  changed: 0,
  removed: 0,
  unchanged: 0,
  servers: [],
};

let home: string;
let cwd: string;
let roots: McpConfigRoots;

/** The project-scoped config path the roots below resolve to. */
function projectConfigPath(): string {
  return join(cwd, '.mcp', 'mcp.json');
}

function writeProjectConfig(body: string): void {
  mkdirSync(join(cwd, '.mcp'), { recursive: true });
  writeFileSync(projectConfigPath(), body, 'utf-8');
}

type ServerSecurityRow = ReturnType<McpRegistry['listServerSecurity']>[number];

/** A security row carries far more than the watcher reads; only `connected` matters here. */
function securityRow(name: string, connected: boolean): ServerSecurityRow {
  return {
    name,
    connected,
    role: 'general',
    trustMode: 'ask',
    allowedPaths: [],
    allowedHosts: [],
    schemaFreshness: 'fresh',
  } as unknown as ServerSecurityRow;
}

interface FakeRegistry {
  reload(roots: McpConfigRoots): Promise<McpReloadResult>;
  listServerSecurity(): ServerSecurityRow[];
  reloadCalls: number;
}

function fakeRegistry(servers: ServerSecurityRow[] = []): FakeRegistry {
  const registry: FakeRegistry = {
    reloadCalls: 0,
    async reload() {
      registry.reloadCalls++;
      return EMPTY_RELOAD;
    },
    listServerSecurity() {
      return servers;
    },
  };
  return registry;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gv-mcp-reload-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'gv-mcp-reload-cwd-'));
  roots = { workingDirectory: cwd, homeDirectory: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('startMcpConfigAutoReload', () => {
  test('returns a handle whose stop() is safe to call more than once', () => {
    const registry = fakeRegistry();
    const handle = startMcpConfigAutoReload({ roots, registry, intervalMs: 500 });
    expect(typeof handle.stop).toBe('function');
    handle.stop();
    handle.stop();
    expect(registry.reloadCalls).toBe(0);
  });

  test('does not reload on start — only on an observed change', async () => {
    writeProjectConfig('{"mcpServers":{}}');
    const registry = fakeRegistry();
    const handle = startMcpConfigAutoReload({ roots, registry, intervalMs: 500 });
    await Bun.sleep(1200);
    expect(registry.reloadCalls).toBe(0);
    handle.stop();
  });

  test('reloads and reports a connection summary when a config file appears', async () => {
    const registry = fakeRegistry([securityRow('alpha', true), securityRow('bravo', false)]);
    let summary: { connected: number; total: number } | undefined;
    const handle = startMcpConfigAutoReload({
      roots,
      registry,
      intervalMs: 500,
      onReload: (next) => { summary = next; },
    });

    writeProjectConfig('{"mcpServers":{"a":{}}}');
    await Bun.sleep(700);

    expect(registry.reloadCalls).toBe(1);
    expect(summary).toEqual({ connected: 1, total: 2 });
    handle.stop();
  });

  test('routes a failing reload to onError and keeps polling afterwards', async () => {
    const errors: unknown[] = [];
    const registry = fakeRegistry();
    registry.reload = async (): Promise<McpReloadResult> => {
      registry.reloadCalls++;
      throw new Error('bad config');
    };
    const handle = startMcpConfigAutoReload({
      roots,
      registry,
      intervalMs: 500,
      onError: (error) => { errors.push(error); },
    });

    writeProjectConfig('{ not json');
    await Bun.sleep(700);
    expect(registry.reloadCalls).toBe(1);
    expect(errors).toHaveLength(1);

    // A later change still reaches the registry — one failure is not terminal.
    writeProjectConfig('{"mcpServers":{"a":{}}}\n\n');
    await Bun.sleep(700);
    expect(registry.reloadCalls).toBe(2);
    handle.stop();
  });

  test('a stopped handle performs no further reloads', async () => {
    const registry = fakeRegistry();
    const handle = startMcpConfigAutoReload({ roots, registry, intervalMs: 500 });
    handle.stop();

    writeProjectConfig('{"mcpServers":{"a":{}}}');
    await Bun.sleep(700);
    expect(registry.reloadCalls).toBe(0);
  });

  test('the poll interval floors at 500ms even when asked for less', async () => {
    const registry = fakeRegistry();
    const handle = startMcpConfigAutoReload({ roots, registry, intervalMs: 1 });
    writeProjectConfig('{"mcpServers":{"a":{}}}');
    // Well under the floor: nothing should have polled yet.
    await Bun.sleep(100);
    expect(registry.reloadCalls).toBe(0);
    await Bun.sleep(700);
    expect(registry.reloadCalls).toBe(1);
    handle.stop();
  });
});
