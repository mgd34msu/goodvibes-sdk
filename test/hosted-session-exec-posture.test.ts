/**
 * hosted-session-exec-posture.test.ts — the posture reaches the tool a hosted
 * turn actually calls.
 *
 * `decideExecContainment` being correct and `createHostedSessionRuntime`
 * consulting it are two different claims, and the incident was the second one:
 * every piece of the sandbox was wired, the fallback was simply silent, and a
 * conversational turn ran on the host. So this drives the REAL exec tool out of
 * the registry a real hosted session composed — no stubs between the posture
 * and the command — with the boundary switched off, which is exactly the state
 * the daemon was in.
 *
 * The default is the load-bearing half. A hosted session composed with no
 * posture stated at all must be contained: that is the shape every session
 * created over `sessions.hosted.*` has.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import {
  createClientRuntimeServices,
  type ClientRuntimeServices,
} from '../packages/sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../packages/sdk/src/platform/hosted-sessions/session-runtime.ts';
import type { HostedSessionExecPosture } from '../packages/sdk/src/platform/hosted-sessions/exec-posture.ts';
import type { PermissionPromptDecision } from '../packages/sdk/src/platform/permissions/prompt.ts';

let root: string;
let workspace: string;
let services: ClientRuntimeServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-posture-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: workspace,
    homeDir: root,
  });
  // The state the daemon was actually in: the boundary is not applied. Whether
  // that is because bubblewrap is missing, the host refuses user namespaces, or
  // the switch is off makes no difference to what a contained turn owes.
  configManager.set('sandbox.enabled', false);

  const approveEverything = async (): Promise<PermissionPromptDecision> => ({ approved: true });
  services = createClientRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: approveEverything,
    modelDiscovery: 'skip',
  });
});

afterEach(() => {
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param stated - How the posture is stated: not at all, on the FLOOR (the
 *   shape a product uses), or per session on the runtime options.
 */
function hostedSession(execPosture?: HostedSessionExecPosture, stated: 'floor' | 'session' = 'floor') {
  return createHostedSessionRuntime({
    sessionId: `hosted-posture-${execPosture ?? 'default'}`,
    workspaceRoot: workspace,
    floor: {
      services,
      ...(execPosture !== undefined && stated === 'floor' ? { execPosture: () => execPosture } : {}),
      dispose: (): void => {},
    },
    systemPrompt: 'hosted',
    ...(execPosture !== undefined && stated === 'session' ? { execPosture } : {}),
  });
}

async function runExec(
  session: ReturnType<typeof hostedSession>,
  cmd: string,
): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const result = await session.toolRegistry.execute('call-1', 'exec', { commands: [{ cmd }] });
  const payload = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
  return {
    success: result.success,
    stderr: String(payload['stderr'] ?? ''),
    stdout: String(payload['stdout'] ?? ''),
  };
}

test('a hosted session with NO posture stated is contained: an uncontained command refuses', async () => {
  const session = hostedSession();
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(false);
  expect(outcome.stderr).toContain('requires commands to run inside the exec boundary');
  expect(outcome.stderr).toContain('daemon-hosted conversational turn');
  expect(outcome.stdout).not.toContain('reached-the-host');
  session.dispose();
});

test('the explicit conversational posture is the same answer', async () => {
  const session = hostedSession('conversational');
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(false);
  expect(outcome.stdout).not.toContain('reached-the-host');
  session.dispose();
});

test('a workstream floor, granted the host explicitly, runs it', async () => {
  const session = hostedSession('workstream');
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(true);
  expect(outcome.stdout).toContain('reached-the-host');
  session.dispose();
});

test('a per-session grant works too, and a per-session grant does not leak to the floor', async () => {
  const granted = hostedSession('workstream', 'session');
  expect((await runExec(granted, 'echo reached-the-host')).success).toBe(true);
  granted.dispose();
  // The floor said nothing, so the NEXT session on it is contained again.
  const next = hostedSession();
  expect((await runExec(next, 'echo reached-the-host')).success).toBe(false);
  next.dispose();
});

test("the owner's terminal is denied in BOTH postures, boundary or not", async () => {
  for (const posture of ['conversational', 'workstream'] as const) {
    const session = hostedSession(posture);
    const outcome = await runExec(session, 'tmux send-keys -t main "goodvibes-agent" Enter');
    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain("owner's terminal is untouchable");
    session.dispose();
  }
});

test("reading tmux state is not touching it — a workstream may still look", async () => {
  const session = hostedSession('workstream');
  const outcome = await runExec(session, 'tmux list-sessions');
  expect(outcome.stderr).not.toContain("owner's terminal is untouchable");
  session.dispose();
});
