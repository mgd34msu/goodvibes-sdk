/**
 * acp-host.test.ts
 *
 * Hosting third-party coding agents over ACP, proven against a REAL scripted
 * ACP agent binary (test/fixtures/fake-acp-agent.ts — a subprocess speaking
 * the actual protocol over stdio via @agentclientprotocol/sdk):
 *
 *  - read-only discovery (PATH + known dirs; quiet absence);
 *  - discovery → spawn → prompt → attention → steer → stop round-trip;
 *  - handshake-failure honesty (a binary that exits, and one that hangs) —
 *    structured error naming binary + stage, never a hung row;
 *  - the fleet snapshot carries the row (kind 'acp-agent') with working
 *    steer/kill dispatch and the awaiting-approval attention classification;
 *  - the acp.* verbs over a real catalog.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  AcpHostService,
  discoverAcpAgents,
  type DiscoveredAcpAgent,
} from '../packages/sdk/src/platform/acp/host.ts';
import { adaptHostedAcpAgent } from '../packages/sdk/src/platform/runtime/fleet/adapters/acp-host.ts';
import { createProcessRegistry, type ProcessRegistryDeps } from '../packages/sdk/src/platform/runtime/fleet/index.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerAcpGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/acp.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-acp-agent.ts');

function fakeAgent(mode: string): DiscoveredAcpAgent {
  return { id: 'fake', title: 'Fake Agent', binaryPath: process.execPath, args: ['run', FIXTURE, mode] };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('discoverAcpAgents — read-only, quiet absence', () => {
  test('finds known binaries on PATH and in known install dirs; absence is an empty list', () => {
    const io = {
      fileExists: (path: string) => path === '/fake-bin/claude-code-acp' || path === '/home/u/.local/bin/codex',
      envPath: () => '/fake-bin:/other',
      home: () => '/home/u',
    };
    const found = discoverAcpAgents(io);
    expect(found).toEqual([
      { id: 'claude-code', title: 'Claude Code', binaryPath: '/fake-bin/claude-code-acp', args: [] },
      { id: 'codex', title: 'Codex CLI', binaryPath: '/home/u/.local/bin/codex', args: ['acp'] },
    ]);

    const none = discoverAcpAgents({ fileExists: () => false, envPath: () => '/nowhere', home: () => '/home/u' });
    expect(none).toEqual([]);
  });
});

describe('AcpHostService — full round-trip against the real protocol', () => {
  test('spawn → prompt (streams) → steer (second prompt) → stop', async () => {
    const registered: Array<{ id: string; title: string }> = [];
    const host = new AcpHostService({
      registerSession: (input) => registered.push({ id: input.id, title: input.title }),
    });

    const hosted = await host.spawnAgent({ agent: fakeAgent('happy'), cwd: import.meta.dir, prompt: 'first task' });
    // Handshake + session complete; the initial prompt is already in flight.
    expect(hosted.state).toBe('prompting');
    expect(hosted.sessionId).toBeDefined();
    // The hosted agent was mapped onto a daemon session.
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(hosted.sessionId);

    // The initial prompt streams and the turn ends.
    await waitUntil(() => (host.get(hosted.id)?.progress ?? '').includes('working on it'));
    await waitUntil(() => host.get(hosted.id)?.state === 'idle');
    expect(host.get(hosted.id)?.promptCount).toBe(1);

    // Steer = the next prompt over the same live connection.
    const steer = host.prompt(hosted.id, 'follow-up');
    expect(steer.queued).toBe(true);
    await waitUntil(() => host.get(hosted.id)?.promptCount === 2 && host.get(hosted.id)?.state === 'idle');

    // Stop: ACP cancel + kill; the record terminalizes.
    expect(await host.stop(hosted.id)).toBe(true);
    expect(host.get(hosted.id)?.state).toBe('stopped');
    // A stopped row honestly refuses further steers.
    expect(host.prompt(hosted.id, 'nope').queued).toBe(false);
  }, 30_000);

  test('a pending permission ask classifies as awaiting-approval and resolves through the handler', async () => {
    let resolvePermission: ((approved: boolean) => void) | null = null;
    const asked: string[] = [];
    const host = new AcpHostService({
      requestPermission: async (request) => {
        asked.push(request.tool);
        const approved = await new Promise<boolean>((resolveAsk) => { resolvePermission = resolveAsk; });
        return { approved, remember: false };
      },
    });

    const hosted = await host.spawnAgent({ agent: fakeAgent('permission'), cwd: import.meta.dir });
    expect(hosted.state).toBe('idle');
    host.prompt(hosted.id, 'do the thing');

    // The ask arrives → the row is waiting on a human, with the tool as detail.
    await waitUntil(() => host.get(hosted.id)?.state === 'awaiting-approval');
    expect(host.get(hosted.id)?.pendingPermission).toBe('write a file');
    expect(asked).toEqual(['write a file']);

    // Approve → the turn completes and the attention clears.
    resolvePermission!(true);
    await waitUntil(() => host.get(hosted.id)?.state === 'idle');
    expect(host.get(hosted.id)?.pendingPermission).toBeUndefined();
    await waitUntil(() => (host.get(hosted.id)?.progress ?? '').includes('permission granted'));

    await host.stop(hosted.id);
  }, 30_000);

  test('stop lands cleanly on a mid-turn (slow) agent — cancelled, not failed', async () => {
    const host = new AcpHostService({});
    const hosted = await host.spawnAgent({ agent: fakeAgent('slow-turn'), cwd: import.meta.dir });
    host.prompt(hosted.id, 'long task');
    await waitUntil(() => (host.get(hosted.id)?.progress ?? '').includes('working on it'));

    expect(await host.stop(hosted.id)).toBe(true);
    expect(host.get(hosted.id)?.state).toBe('stopped');
    expect(host.get(hosted.id)?.error).toBeUndefined();
  }, 30_000);
});

describe('AcpHostService — handshake-failure honesty', () => {
  test('a binary that does not speak ACP yields a structured error, never a hung row', async () => {
    const host = new AcpHostService({ handshakeTimeoutMs: 3_000 });
    const hosted = await host.spawnAgent({ agent: fakeAgent('bad-handshake'), cwd: import.meta.dir });
    expect(hosted.state).toBe('failed');
    expect(hosted.error?.binary).toBe(process.execPath);
    expect(hosted.error?.stage).toBe('initialize');
    expect(hosted.error?.message.length).toBeGreaterThan(0);
  }, 15_000);

  test('a binary that hangs is bounded by the handshake timeout with the stage named', async () => {
    const host = new AcpHostService({ handshakeTimeoutMs: 1_500 });
    const started = Date.now();
    const hosted = await host.spawnAgent({ agent: fakeAgent('hang'), cwd: import.meta.dir });
    expect(hosted.state).toBe('failed');
    expect(hosted.error?.stage).toBe('initialize');
    expect(hosted.error?.message).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe('fleet integration — the hosted row is a first-class fleet row', () => {
  function makeDeps(host: AcpHostService): ProcessRegistryDeps {
    return {
      agentManager: { list: () => [], cancel: () => false },
      wrfcController: { listChains: () => [] },
      processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      },
      acpHost: host,
    };
  }

  test('snapshot carries the row with kind acp-agent; steer prompts; kill stops; attention classifies', async () => {
    const host = new AcpHostService({});
    const registry = createProcessRegistry(makeDeps(host));
    try {
      const hosted = await host.spawnAgent({ agent: fakeAgent('happy'), cwd: import.meta.dir });

      const nodes = registry.query().nodes;
      expect(nodes).toHaveLength(1);
      const node = nodes[0]!;
      expect(node.kind).toBe('acp-agent');
      expect(node.id).toBe(`acp:${hosted.id}`);
      expect(node.state).toBe('idle');
      expect(node.capabilities.steerable).toBe(true);
      expect(node.capabilities.killable).toBe(true);
      expect(node.sessionRef?.sessionId).toBe(hosted.sessionId);

      // Steer through the REGISTRY — the panel affordance.
      const steer = registry.steer(node.id, 'do something');
      expect(steer.queued).toBe(true);
      await waitUntil(() => host.get(hosted.id)?.promptCount === 1 && host.get(hosted.id)?.state === 'idle');

      // Kill through the registry — the row terminalizes as 'killed'.
      const killed = registry.kill(node.id);
      expect(killed).toEqual([node.id]);
      await waitUntil(() => host.get(hosted.id)?.state === 'stopped');
      expect(registry.query().nodes[0]?.state).toBe('killed');
    } finally {
      registry.dispose();
      await Promise.allSettled(host.list().map((h) => host.stop(h.id)));
    }
  }, 30_000);

  test('awaiting-approval carries needsAttention (the waiting-on-human classification)', () => {
    const node = adaptHostedAcpAgent({
      id: 'h1', agentId: 'claude-code', title: 'Claude Code: /repo', binaryPath: '/bin/claude-code-acp',
      cwd: '/repo', state: 'awaiting-approval', startedAt: 1, pendingPermission: 'run a command', promptCount: 1,
    }, 2);
    expect(node.state).toBe('awaiting-approval');
    expect(node.needsAttention).toEqual({ reason: 'approval', detail: 'run a command' });

    const failed = adaptHostedAcpAgent({
      id: 'h2', agentId: 'codex', title: 'Codex', binaryPath: '/bin/codex', cwd: '/repo',
      state: 'failed', startedAt: 1, completedAt: 2, promptCount: 0,
      error: { binary: '/bin/codex', stage: 'initialize', message: 'timed out' },
    }, 3);
    expect(failed.state).toBe('failed');
    expect(failed.currentActivity?.text).toBe('initialize failed: timed out');
    expect(failed.capabilities.killable).toBe(false);
  });
});

describe('acp.* verbs over the catalog', () => {
  const ctx = { context: { principalId: 'op', admin: true } } as const;

  test('agents.list serves discovery; sessions.create spawns in one act; failure is a structured outcome', async () => {
    const host = new AcpHostService({ handshakeTimeoutMs: 3_000 });
    const catalog = new GatewayMethodCatalog();
    registerAcpGatewayMethods(catalog, {
      host,
      discover: () => [
        { ...fakeAgent('happy'), id: 'fake-good', title: 'Good Agent' },
        { ...fakeAgent('bad-handshake'), id: 'fake-bad', title: 'Bad Agent' },
      ],
    });

    const listed = await catalog.invoke('acp.agents.list', { ...ctx, body: {} }) as { agents: Array<{ id: string }> };
    expect(listed.agents.map((a) => a.id)).toEqual(['fake-good', 'fake-bad']);

    // One-act spawn — a live steerable/stoppable hosted session.
    const created = await catalog.invoke('acp.sessions.create', { ...ctx, body: { agentId: 'fake-good', cwd: import.meta.dir } }) as {
      hosted: { id: string; state: string; sessionId?: string }; started: boolean;
    };
    expect(created.started).toBe(true);
    expect(created.hosted.state).toBe('idle');
    await host.stop(created.hosted.id);

    // Handshake failure: an HONEST structured outcome, not a throw or a hang.
    const failed = await catalog.invoke('acp.sessions.create', { ...ctx, body: { agentId: 'fake-bad', cwd: import.meta.dir } }) as {
      hosted: { state: string; error?: { binary: string; stage: string; message: string } }; started: boolean;
    };
    expect(failed.started).toBe(false);
    expect(failed.hosted.state).toBe('failed');
    expect(failed.hosted.error?.stage).toBe('initialize');

    // Unknown agent id and bad cwd are honest 4xx.
    await expect(catalog.invoke('acp.sessions.create', { ...ctx, body: { agentId: 'nope', cwd: import.meta.dir } })).rejects.toThrow(/No installed agent/);
    await expect(catalog.invoke('acp.sessions.create', { ...ctx, body: { agentId: 'fake-good', cwd: '/no/such/dir' } })).rejects.toThrow(/not an existing directory/);
  }, 30_000);
});
