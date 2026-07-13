/**
 * The ci fix-session starter returns the REAL spawned session's id — the id a
 * session lookup actually resolves — never the automation job's scheduling
 * handle ('auto-…'). Job-id-vs-session-id confusion is pinned here so it
 * cannot recur; a start that cannot run yields an honest error outcome.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationManager } from '../packages/sdk/src/platform/automation/index.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import { startCiFixSession } from '../packages/sdk/src/platform/control-plane/routes/register-gateway-verb-groups.ts';
import type { FixSessionBrief } from '../packages/sdk/src/platform/ci-watch/types.ts';

const flags = (enabledIds: readonly string[]) => ({
  isEnabled: (id: string): boolean => enabledIds.includes(id),
});

const routeBindingsStub = {
  start: async () => {},
  patchBinding: async () => null,
  getBinding: () => null,
  resolve: () => null,
  ensureBinding: async () => null,
} as unknown as RouteBindingManager;

const brief: FixSessionBrief = {
  repo: 'o/r',
  ref: 'main',
  failingJobs: ['build'],
  logs: 'ERROR: build exploded',
};

function harness(dir: string, enabled: boolean) {
  const sessionBroker = new SharedSessionBroker({
    storePath: join(dir, 'sessions.json'),
    routeBindings: routeBindingsStub,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
  const spawned: string[] = [];
  const automation = new AutomationManager({
    configManager: new ConfigManager({ configDir: join(dir, 'config') }),
    routeBindings: routeBindingsStub,
    sessionBroker,
    featureFlags: flags(enabled ? ['automation-domain'] : []),
    spawnTask: () => {
      const id = `agent-${spawned.length + 1}`;
      spawned.push(id);
      return id;
    },
  } as unknown as ConstructorParameters<typeof AutomationManager>[0]);
  return { sessionBroker, automation, spawned };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fix-real-id-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('ci fix-session starter returns a REAL session id', () => {
  test('the returned id resolves through a real session lookup and is never the job id', async () => withTempDir(async (dir) => {
    const { sessionBroker, automation, spawned } = harness(dir, true);
    const outcome = await startCiFixSession(automation, brief);
    if (!('sessionId' in outcome)) throw new Error(`expected a session, got error: ${outcome.error}`);

    // Job-vs-session pinning: automation job ids are 'auto-…' scheduling
    // handles no attach can resolve — the starter must never surface one.
    expect(outcome.sessionId.startsWith('auto-')).toBe(false);
    for (const job of automation.listJobs()) {
      expect(outcome.sessionId).not.toBe(job.id);
    }

    // The REAL lookup: the id resolves to a live shared session with the
    // spawned agent bound to it.
    const session = sessionBroker.getSession(outcome.sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(spawned).toHaveLength(1);
    expect(session!.activeAgentId ?? session!.lastAgentId).toBe(spawned[0]!);

    // The run record agrees: its sessionId is what the starter returned.
    const run = automation.listRuns()[0]!;
    expect(run.sessionId).toBe(outcome.sessionId);
    expect(run.agentId).toBe(spawned[0]!);
  }));

  test('each fix starts in a FRESH pinned session — never an existing preferred session', async () => withTempDir(async (dir) => {
    const { automation } = harness(dir, true);
    const first = await startCiFixSession(automation, brief);
    const second = await startCiFixSession(automation, brief);
    if (!('sessionId' in first) || !('sessionId' in second)) throw new Error('expected sessions');
    expect(first.sessionId).not.toBe(second.sessionId);
  }));

  test('a start that cannot run is an honest error outcome, never a dead id', async () => withTempDir(async (dir) => {
    const { automation } = harness(dir, false);
    const outcome = await startCiFixSession(automation, brief);
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expect(outcome.error.length).toBeGreaterThan(0);
  }));
});
