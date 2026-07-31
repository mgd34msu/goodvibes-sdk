/**
 * hosted-session-manager.test.ts
 *
 * The engine's lifecycle and the owner-ruled detach toggle, against REAL client
 * floors (`createClientRuntimeServices`) so a session composes the same tool
 * registry, permission manager and orchestrator a terminal would. Model
 * discovery is skipped — these compositions do not outlive it and no test here
 * runs a provider turn.
 *
 * The toggle is checked in BOTH positions, at both levels it can be set:
 *  - the setting says kill (the shipped default) ⇒ the last detach ends it;
 *  - the setting says survive ⇒ the last detach leaves it reattachable;
 *  - a per-session override beats the setting either way.
 *
 * And the restart is checked for what it is: a reconciliation, not a resume.
 * A survive-policy session comes back idle with its transcript and a line
 * saying its turn did not finish; anything else comes back terminated with a
 * named reason. Nothing comes back pretending it never stopped.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';
import { SessionLiveTurnControlsHolder } from '../packages/sdk/src/platform/control-plane/routes/session-runtime.ts';
import { HostedSessionManager } from '../packages/sdk/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../packages/sdk/src/platform/hosted-sessions/store.ts';
import type { HostedWorkspaceFloor } from '../packages/sdk/src/platform/hosted-sessions/workspace-floor.ts';
import type { HostedDetachPolicy, HostedSessionUpdatePayload } from '../packages/sdk/src/platform/hosted-sessions/types.ts';
import type { PermissionPromptDecision } from '../packages/sdk/src/platform/permissions/prompt.ts';

let root: string;
let workspace: string;
let stateDir: string;
let published: HostedSessionUpdatePayload[];
let liveTurns: SessionLiveTurnControlsHolder;
let disposals: (() => void)[];

/** Every ask a hosted run raised. Nothing here approves anything. */
const asks: string[] = [];

async function declineEverything(input: { readonly request: { readonly tool: string } }): Promise<PermissionPromptDecision> {
  asks.push(input.request.tool);
  return { approved: false };
}

function buildManager(options?: {
  readonly detachPolicy?: HostedDetachPolicy | undefined;
  readonly maxSessions?: number | undefined;
  readonly attachmentTtlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly listClients?: (() => readonly { readonly id: string }[]) | undefined;
}): HostedSessionManager {
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: root,
    homeDir: root,
  });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const services = createClientRuntimeServices({
        configManager,
        runtimeBus,
        runtimeStore: createRuntimeStore(),
        surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot,
        homeDirectory: root,
        requestApproval: declineEverything,
        // These compositions do not outlive discovery's unawaited write.
        modelDiscovery: 'skip',
      });
      disposals.push(() => services.dispose());
      return { services, dispose: (): void => services.dispose() };
    },
    store: new HostedSessionStore(stateDir, {
      maxSessions: 20,
      maxMessagesPerSession: 100,
      terminatedRetentionMs: 60_000,
    }),
    settings: {
      detachPolicy: () => options?.detachPolicy ?? 'kill',
      maxSessions: () => options?.maxSessions ?? 8,
      attachmentTtlMs: () => options?.attachmentTtlMs ?? 10 * 60_000,
    },
    runtimeBus,
    systemPrompt: ({ workspaceRoot }) => `hosted in ${workspaceRoot}`,
    liveTurns,
    isWorkspaceUsable: () => true,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  manager.setEventPublisher({
    publishEvent: (_event, payload) => { published.push(payload as HostedSessionUpdatePayload); },
    ...(options?.listClients === undefined ? {} : { listClients: options.listClients }),
  });
  return manager;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-manager-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  stateDir = join(root, 'hosted-sessions');
  published = [];
  liveTurns = new SessionLiveTurnControlsHolder();
  disposals = [];
  asks.length = 0;
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    try { dispose(); } catch { /* a floor already disposed by the manager */ }
  }
  rmSync(root, { recursive: true, force: true });
});

test('a created session composes a real loop and is listed', async () => {
  const manager = buildManager();
  await manager.init();
  const session = await manager.create({ workspaceRoot: workspace, clientId: 'terminal-1' });

  expect(session.status).toBe('idle');
  expect(session.workspaceRoot).toBe(workspace);
  expect(session.attachedClients).toEqual(['terminal-1']);
  expect(session.detachPolicy).toBeNull();
  expect(session.effectiveDetachPolicy).toBe('kill');
  expect(manager.list().map((s) => s.id)).toEqual([session.id]);
  expect(manager.hosts(session.id)).toBe(true);

  // The loop is real: its live-turn controls are bound under this session's id,
  // which is what makes sessions.toolCalls.cancel reach a hosted turn.
  expect(liveTurns.hasSession(session.id)).toBe(true);
  expect(liveTurns.getSession(session.id)).not.toBeNull();

  // And it registered a created notice with the whole record on it.
  expect(published.map((p) => p.event)).toEqual(['hosted-session-created']);
  await manager.dispose();
});

test('the shipped default ends a session when its last client detaches', async () => {
  const manager = buildManager({ detachPolicy: 'kill' });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });

  const after = await manager.detach(created.id, 'a');

  expect(after.status).toBe('terminated');
  expect(after.terminatedReason).toBe('detached');
  expect(manager.list()).toHaveLength(0);
  expect(manager.list({ includeTerminated: true })).toHaveLength(1);
  // The loop was taken apart with it.
  expect(liveTurns.hasSession(created.id)).toBe(false);
  await manager.dispose();
});

test('survive leaves the session idle and reattachable after the last detach', async () => {
  const manager = buildManager({ detachPolicy: 'survive' });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });
  expect(created.effectiveDetachPolicy).toBe('survive');

  const afterDetach = await manager.detach(created.id, 'a');
  expect(afterDetach.status).toBe('idle');
  expect(afterDetach.attachedClients).toEqual([]);
  expect(manager.list().map((s) => s.id)).toEqual([created.id]);

  const reattached = await manager.attach(created.id, 'b');
  expect(reattached.session.status).toBe('idle');
  expect(reattached.session.attachedClients).toEqual(['b']);
  await manager.dispose();
});

test('a per-session override beats the setting in both directions', async () => {
  const killDefault = buildManager({ detachPolicy: 'kill' });
  await killDefault.init();
  const survivor = await killDefault.create({ workspaceRoot: workspace, clientId: 'a', detachPolicy: 'survive' });
  expect(survivor.detachPolicy).toBe('survive');
  expect((await killDefault.detach(survivor.id, 'a')).status).toBe('idle');
  await killDefault.dispose();

  const surviveDefault = buildManager({ detachPolicy: 'survive' });
  await surviveDefault.init();
  const doomed = await surviveDefault.create({ workspaceRoot: workspace, clientId: 'a', detachPolicy: 'kill' });
  expect(doomed.detachPolicy).toBe('kill');
  expect((await surviveDefault.detach(doomed.id, 'a')).status).toBe('terminated');
  await surviveDefault.dispose();
});

test('the policy applies only when the LAST client leaves', async () => {
  const manager = buildManager({ detachPolicy: 'kill' });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });
  await manager.attach(created.id, 'b');

  const afterFirst = await manager.detach(created.id, 'a');
  expect(afterFirst.status).toBe('idle');
  expect(afterFirst.attachedClients).toEqual(['b']);

  const afterSecond = await manager.detach(created.id, 'b');
  expect(afterSecond.status).toBe('terminated');
  await manager.dispose();
});

test('a live session reports the policy that WOULD apply next, read from the setting live', async () => {
  let policy: HostedDetachPolicy = 'kill';
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root,
  });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const services = createClientRuntimeServices({
        configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot, homeDirectory: root, requestApproval: declineEverything, modelDiscovery: 'skip',
      });
      disposals.push(() => services.dispose());
      return { services, dispose: (): void => services.dispose() };
    },
    store: new HostedSessionStore(stateDir, { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 }),
    settings: { detachPolicy: () => policy, maxSessions: () => 8 },
    runtimeBus,
    systemPrompt: () => 'hosted',
    liveTurns,
    isWorkspaceUsable: () => true,
  });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });
  expect(created.effectiveDetachPolicy).toBe('kill');

  policy = 'survive';
  // A policy change applies to the NEXT detach, not to whatever the value was
  // when the session was created — so the record has to re-read it.
  expect(manager.get(created.id)?.effectiveDetachPolicy).toBe('survive');
  expect((await manager.detach(created.id, 'a')).status).toBe('idle');
  await manager.dispose();
});

test('killing ends the session with a reason, and killing again is not an error', async () => {
  const manager = buildManager();
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });

  const killed = await manager.kill(created.id);
  expect(killed.status).toBe('terminated');
  expect(killed.terminatedReason).toBe('killed');

  const again = await manager.kill(created.id);
  expect(again.terminatedReason).toBe('killed');
  await manager.dispose();
});

test('the session cap is enforced and the refusal names the setting', async () => {
  const manager = buildManager({ maxSessions: 1 });
  await manager.init();
  await manager.create({ workspaceRoot: workspace });
  await expect(manager.create({ workspaceRoot: workspace })).rejects.toThrow(/hostedSessions.maxSessions/);
  await manager.dispose();
});

test('a relative workspace root is refused rather than resolved against the daemon', async () => {
  const manager = buildManager();
  await manager.init();
  await expect(manager.create({ workspaceRoot: 'some/relative/path' })).rejects.toThrow(/absolute/);
  await manager.dispose();
});

test('an unknown session id refuses, and a terminated one refuses with the reason', async () => {
  const manager = buildManager();
  await manager.init();
  await expect(manager.attach('hosted-nope', 'a')).rejects.toThrow(/hosts no session/);

  const created = await manager.create({ workspaceRoot: workspace });
  await manager.kill(created.id);
  await expect(manager.attach(created.id, 'a')).rejects.toThrow(/terminated \(killed\)/);
  await manager.dispose();
});

test('a restart brings a survive-policy session back idle, with its transcript and an honest line', async () => {
  const first = buildManager({ detachPolicy: 'survive' });
  await first.init();
  const created = await first.create({ workspaceRoot: workspace, clientId: 'a' });
  // Attached the whole time, and the daemon stops anyway — the shape an update
  // or a reboot actually produces.
  await first.dispose();

  const second = buildManager({ detachPolicy: 'survive' });
  const report = await second.init();
  expect(report.rejected).toEqual([]);

  const restored = second.get(created.id);
  expect(restored?.status).toBe('idle');
  expect(restored?.restoredFromDisk).toBe(true);

  const reattached = await second.attach(created.id, 'b');
  expect(reattached.session.restoredFromDisk).toBe(false);
  const systemLines = reattached.history.filter((m) => m.role === 'system').map((m) => m.content);
  expect(systemLines.some((line) => line.includes('interrupted by a daemon restart'))).toBe(true);
  await second.dispose();
});

test('a restart terminates a kill-policy session with a named reason rather than dropping it', async () => {
  const first = buildManager({ detachPolicy: 'kill' });
  await first.init();
  const created = await first.create({ workspaceRoot: workspace, clientId: 'a' });
  // Shut the engine down with the session still attached: this is the crash
  // shape, and what the next start finds on disk.
  await first.dispose();

  const second = buildManager({ detachPolicy: 'kill' });
  await second.init();
  const restored = second.get(created.id);
  expect(restored?.status).toBe('terminated');
  // `daemon-shutdown` is what actually happened, and it is on the record.
  expect(restored?.terminatedReason).toBe('daemon-shutdown');
  expect(second.list()).toHaveLength(0);
  expect(second.list({ includeTerminated: true })).toHaveLength(1);
  await second.dispose();
});

test('shutdown ends kill-policy sessions and parks survive-policy ones', async () => {
  const doomed = buildManager({ detachPolicy: 'kill' });
  await doomed.init();
  const killed = await doomed.create({ workspaceRoot: workspace, clientId: 'x' });
  await doomed.dispose();
  expect(doomed.get(killed.id)?.status).toBe('terminated');
  expect(doomed.get(killed.id)?.terminatedReason).toBe('daemon-shutdown');

  const surviving = buildManager({ detachPolicy: 'survive' });
  await surviving.init();
  const parked = await surviving.create({ workspaceRoot: workspace, clientId: 'x' });
  await surviving.dispose();
  // Outliving a restart is the half of `survive` that makes it worth having:
  // an update swapping the binary must not end the work it was told to keep.
  expect(surviving.get(parked.id)?.status).toBe('idle');
  expect(surviving.get(parked.id)?.terminatedReason).toBeUndefined();
});

test('lifecycle notices name the transition, the client and the reason', async () => {
  const manager = buildManager({ detachPolicy: 'kill' });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });
  await manager.attach(created.id, 'b');
  await manager.detach(created.id, 'b');
  await manager.detach(created.id, 'a');

  expect(published.map((p) => p.event)).toEqual([
    'hosted-session-created',
    'hosted-session-attached',
    'hosted-session-detached',
    'hosted-session-detached',
    'hosted-session-terminated',
  ]);
  expect(published[1]!.clientId).toBe('b');
  expect(published.at(-1)!.detail).toContain('policy is kill');
  expect(published.at(-1)!.session.terminatedReason).toBe('detached');
  await manager.dispose();
});

test('sessions in one workspace share a floor; a second workspace gets its own', async () => {
  const manager = buildManager({ detachPolicy: 'survive' });
  await manager.init();
  const otherWorkspace = join(root, 'other');
  mkdirSync(otherWorkspace, { recursive: true });

  await manager.create({ workspaceRoot: workspace });
  await manager.create({ workspaceRoot: workspace });
  await manager.create({ workspaceRoot: otherWorkspace });

  // Three sessions, two floors: the count is the observable form of the
  // per-workspace sharing decision.
  expect(disposals).toHaveLength(2);
  await manager.dispose();
});

test('a steer queued on the spine reaches the hosted loop, and the participant stays fresh', async () => {
  // The broker routes a steer to a live SURFACE participant when it has one and
  // spawns a background agent when it does not, so both halves matter: the
  // engine has to collect what was queued for it AND keep its heartbeat fresh,
  // or a hosted session quietly stops receiving its own steers.
  const registrations: { sessionId: string; lastSeenAt: number }[] = [];
  const queued = new Map<string, { id: string; body: string }[]>();
  const delivered: string[] = [];
  const consumed: string[] = [];

  const spine = {
    register: async (input: { sessionId: string; participant: { lastSeenAt: number } }) => {
      registrations.push({ sessionId: input.sessionId, lastSeenAt: input.participant.lastSeenAt });
      return {};
    },
    closeSession: async () => ({}),
    getInputsSince: (sessionId: string) => queued.get(sessionId) ?? [],
    markInputDelivered: async (sessionId: string, inputId: string, options?: { consumed?: boolean }) => {
      (options?.consumed === true ? consumed : delivered).push(`${sessionId}:${inputId}`);
      if (options?.consumed === true) queued.set(sessionId, (queued.get(sessionId) ?? []).filter((i) => i.id !== inputId));
      return {};
    },
  };

  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root,
  });
  const submitted: string[] = [];
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const services = createClientRuntimeServices({
        configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot, homeDirectory: root, requestApproval: declineEverything, modelDiscovery: 'skip',
      });
      disposals.push(() => services.dispose());
      return { services, dispose: (): void => services.dispose() };
    },
    store: new HostedSessionStore(stateDir, { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 }),
    settings: { detachPolicy: () => 'survive', maxSessions: () => 8 },
    runtimeBus,
    systemPrompt: () => 'hosted',
    liveTurns,
    spine,
    isWorkspaceUsable: () => true,
    intakeIntervalMs: 10,
  });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });

  // Replace the loop's submit with a recorder: this test is about the intake
  // path reaching it, not about what a provider would answer.
  const runtime = manager as unknown as { sessions: Map<string, { runtime: { submit: (text: string) => Promise<void> } | null }> };
  const live = runtime.sessions.get(created.id)!;
  live.runtime!.submit = async (text: string): Promise<void> => { submitted.push(text); };

  queued.set(created.id, [{ id: 'input-1', body: 'steer this hosted session' }]);
  for (let attempt = 0; attempt < 50 && submitted.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  expect(submitted).toEqual(['steer this hosted session']);
  expect(delivered).toContain(`${created.id}:input-1`);
  expect(consumed).toContain(`${created.id}:input-1`);
  // Registered at create, and re-registered on every tick since.
  expect(registrations.filter((entry) => entry.sessionId === created.id).length).toBeGreaterThan(1);
  await manager.dispose();
});

// ---------------------------------------------------------------------------
// Attachment leases
// ---------------------------------------------------------------------------
//
// An attachment is a claim about a live process, and detach was the only thing
// that ever ended one. A client that crashed or closed its tab never calls it,
// so a kill-policy session — the default — waited for a departure that was
// never coming, holding a workspace floor and a model connection for nobody.

test('an attachment nobody renews lapses, and a kill-policy session ends with it', async () => {
  let clock = 1_000;
  const manager = buildManager({ detachPolicy: 'kill', attachmentTtlMs: 60_000, now: () => clock });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'crashed-tui' });
  expect(created.attachedClients).toEqual(['crashed-tui']);

  // Still inside the lease: nothing happens.
  clock += 30_000;
  await manager.reapAttachments();
  expect(manager.get(created.id)?.status).toBe('idle');

  clock += 40_000;
  await manager.reapAttachments();

  const after = manager.get(created.id);
  expect(after?.status).toBe('terminated');
  expect(after?.terminatedReason).toBe('detached');
  expect(after?.attachedClients).toEqual([]);
  expect(liveTurns.hasSession(created.id)).toBe(false);
  await manager.dispose();
});

test('a survive-policy session outlives a lapsed attachment, idle and reattachable', async () => {
  let clock = 1_000;
  const manager = buildManager({ detachPolicy: 'survive', attachmentTtlMs: 60_000, now: () => clock });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'closed-tab' });

  clock += 61_000;
  await manager.reapAttachments();

  const after = manager.get(created.id);
  expect(after?.status).toBe('idle');
  expect(after?.attachedClients).toEqual([]);
  await manager.dispose();
});

test('attaching again renews the lease, so a client that keeps showing up is never reaped', async () => {
  let clock = 1_000;
  const manager = buildManager({ detachPolicy: 'kill', attachmentTtlMs: 60_000, now: () => clock });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });

  for (let round = 0; round < 4; round += 1) {
    clock += 50_000;
    await manager.attach(created.id, 'a');
    await manager.reapAttachments();
  }

  expect(manager.get(created.id)?.status).toBe('idle');
  expect(manager.get(created.id)?.attachedClients).toEqual(['a']);
  await manager.dispose();
});

test('a client the control plane can still see renews without any call of its own', async () => {
  let clock = 1_000;
  const connected = new Set(['web-1']);
  const manager = buildManager({
    detachPolicy: 'kill',
    attachmentTtlMs: 60_000,
    now: () => clock,
    listClients: () => [...connected].map((id) => ({ id })),
  });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'web-1' });

  // Watching a long turn in silence: no attach call, no detach, still there.
  clock += 200_000;
  await manager.reapAttachments();
  expect(manager.get(created.id)?.status).toBe('idle');

  // The stream drops. Now the same silence means the client is gone.
  connected.clear();
  clock += 61_000;
  await manager.reapAttachments();
  expect(manager.get(created.id)?.status).toBe('terminated');
  expect(manager.get(created.id)?.terminatedReason).toBe('detached');
  await manager.dispose();
});

test('a per-attachment leaseMs is honored, and clamped to the floor', async () => {
  let clock = 1_000;
  const manager = buildManager({ detachPolicy: 'survive', attachmentTtlMs: 10 * 60_000, now: () => clock });
  await manager.init();
  const created = await manager.create({ workspaceRoot: workspace, clientId: 'a' });
  // One second is below the 30s floor and is raised to it, not honored literally.
  await manager.attach(created.id, 'short', { leaseMs: 1_000 });

  clock += 20_000;
  await manager.reapAttachments();
  expect(manager.get(created.id)?.attachedClients).toContain('short');

  clock += 15_000;
  await manager.reapAttachments();
  expect(manager.get(created.id)?.attachedClients).not.toContain('short');
  // The default-lease attachment is untouched by the short one lapsing.
  expect(manager.get(created.id)?.attachedClients).toContain('a');
  await manager.dispose();
});
