/**
 * session-spine-daemon-integration.test.ts
 *
 * Consumability proof: drives the extracted SDK SessionSpineClient against a
 * REAL bootDaemon (isolated home, ephemeral port) over a real HttpTransport — no
 * mocked wire — using the transport adapter EXACTLY as the TUI's bootstrap builds
 * it (register/close over httpTransport.operator.sessions, resolve->ok / throw->
 * offline). Exercises the full TUI journey: adopt (activate), register, keepalive,
 * offline queue, reconnect flush, and close.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { createHttpTransport } from '../packages/sdk/src/platform/runtime/transport.ts';
import {
  SessionSpineClient,
  TUI_SPINE_PARTICIPANT,
  type SpineTransport,
} from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

const TOKEN = 'spine-integration-token';

/**
 * Ceiling for a single poll, and per-test budget for the whole file.
 *
 * Both are ceilings, not targets. Every test here boots a REAL daemon on a real
 * socket and talks to it over real HTTP; a fast host finishes in tens of
 * milliseconds and pays nothing for the headroom, because every wait below
 * returns the instant its condition holds. The previous numbers were an idle
 * machine's numbers: a 2 s poll ceiling and bun's implicit 5 s per-test default,
 * against work that legitimately includes process boot and socket setup. On a
 * loaded host these failed with "this test timed out after 5000ms" while the
 * daemon was still coming up perfectly normally — the whole file takes ~37 s
 * there, so a 5 s budget for one of its tests was never realistic.
 */
const WAIT_CEILING_MS = 30_000;
const TEST_BUDGET_MS = 120_000;

async function waitFor<T>(
  fn: () => Promise<T | undefined | null>,
  what = 'unlabelled condition',
  timeoutMs = WAIT_CEILING_MS,
  intervalMs = 20,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      throw new Error(`waitFor: ${what} never became true — waited ${elapsedMs}ms (ceiling ${timeoutMs}ms)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface SessionRow {
  readonly id: string;
  readonly kind: string;
  readonly project: string;
  readonly status: string;
  readonly participants: readonly { readonly lastSeenAt: number }[];
}

interface Harness {
  readonly daemon: BootedDaemon;
  readonly homeDirectory: string;
  readonly workingDir: string;
  /** The TUI-exact adapter over the real typed HTTP sessions client. */
  readonly spineTransport: SpineTransport;
  /** A connectivity gate simulating a transient outage without a port change. */
  setBlocked: (blocked: boolean) => void;
  readonly listSessions: () => Promise<readonly SessionRow[]>;
  readonly getSession: (id: string) => Promise<{ readonly id: string; readonly status: string } | null>;
}

async function startHarness(): Promise<Harness> {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-spine-home-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'goodvibes-sdk-spine-project-'));
  const daemon = await bootDaemon({ homeDirectory, workingDir, port: 0, token: TOKEN });
  const transport = createHttpTransport({ baseUrl: daemon.url, authToken: TOKEN });
  const gate = { blocked: false };
  // This is byte-for-byte the shape bootstrap.ts wires: a SpineTransport that wraps
  // the typed operator.sessions client, mapping resolve->ok and any throw->offline.
  const spineTransport: SpineTransport = {
    register: async (input) => {
      if (gate.blocked) return { outcome: 'offline', error: 'blocked' };
      try { await transport.operator.sessions.register(input); return { outcome: 'ok' }; }
      catch (e) { return { outcome: 'offline', error: String(e) }; }
    },
    close: async (id) => {
      if (gate.blocked) return { outcome: 'offline', error: 'blocked' };
      try { await transport.operator.sessions.close(id); return { outcome: 'ok' }; }
      catch (e) { return { outcome: 'offline', error: String(e) }; }
    },
  };
  return {
    daemon,
    homeDirectory,
    workingDir,
    spineTransport,
    setBlocked: (blocked) => { gate.blocked = blocked; },
    listSessions: () => transport.operator.sessions.list(200) as unknown as Promise<readonly SessionRow[]>,
    getSession: (id) => transport.operator.sessions.get(id) as unknown as Promise<{ readonly id: string; readonly status: string } | null>,
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.daemon.stop();
  rmSync(harness.homeDirectory, { recursive: true, force: true });
  rmSync(harness.workingDir, { recursive: true, force: true });
}

describe('SDK SessionSpineClient against a real bootDaemon (TUI-exact adapter)', () => {
  let harness: Harness | null = null;
  afterEach(async () => { if (harness) await stopHarness(harness); harness = null; });

  test('adopt + register-on-create is visible in sessions.list with kind tui and the right project', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport); // adopt-or-start told us a compatible daemon exists

    client.register({ sessionId: 'tui-create-1', project: harness.workingDir, title: 'Terminal UI session' });
    const record = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-create-1') ?? null,
      'session tui-create-1 appears in sessions.list');
    expect(record.kind).toBe('tui');
    expect(record.project).toBe(harness.workingDir);
    expect(record.status).toBe('active');
    client.dispose();
  }, TEST_BUDGET_MS);

  test('keepalive advances the participant lastSeenAt on its own cadence with no activity', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', heartbeatMinIntervalMs: 20, log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-keepalive-1', project: harness.workingDir, title: 'T' });
    const initial = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-keepalive-1') ?? null,
      'session tui-keepalive-1 appears in sessions.list');
    const initialLastSeen = initial.participants[0]?.lastSeenAt ?? 0;

    // No further calls into the client — the 20ms keepalive timer drives heartbeats.
    const advanced = await waitFor(async () => {
      const rec = (await harness!.listSessions()).find((s) => s.id === 'tui-keepalive-1');
      const lastSeen = rec?.participants[0]?.lastSeenAt ?? 0;
      return lastSeen > initialLastSeen ? rec : null;
    }, 'the keepalive timer advances the participant lastSeenAt with no other activity');
    expect((advanced.participants[0]?.lastSeenAt ?? 0)).toBeGreaterThan(initialLastSeen);
    client.dispose();
  }, TEST_BUDGET_MS);

  test('offline queue + reconnect flush: an op buffered during an outage lands once the wire recovers', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);

    client.register({ sessionId: 'tui-online-1', project: harness.workingDir, title: 'Online' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-online-1') ?? null,
      'session tui-online-1 appears in sessions.list');
    // The reachability flip lands one microtask after the record is persisted; poll for it.
    await waitFor(async () => (client.status() === 'online' ? true : null), 'the client reports status online');

    // Transient outage: the register buffers into the bounded ring, never lands yet.
    harness.setBlocked(true);
    client.register({ sessionId: 'tui-queued-1', project: harness.workingDir, title: 'Queued' });
    // Poll instead of sleeping a fixed 30 ms: the register has to reach the
    // blocked wire, fail, and be buffered before the status flips, and how long
    // that takes is a property of the machine, not of the behaviour under test.
    // The wait ends the moment the client reports what it should, so a fast host
    // pays nothing — and the assertions below still hold it to the exact state.
    await waitFor(async () => (client.status() === 'offline' && client.pendingOps === 1 ? true : null),
      'the blocked register buffers and the client reports status offline');
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBe(1);
    const stillMissing = (await harness.listSessions()).find((s) => s.id === 'tui-queued-1') ?? null;
    expect(stillMissing).toBeNull();

    // Recover: the next op triggers a flush that replays the buffered register.
    harness.setBlocked(false);
    client.heartbeat('tui-online-1');
    const flushed = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-queued-1') ?? null,
      'the buffered register replays and tui-queued-1 lands');
    expect(flushed.status).toBe('active');
    expect(client.status()).toBe('online');
    expect(client.pendingOps).toBe(0);
    client.dispose();
  }, TEST_BUDGET_MS);

  test('a real daemon outage (stop) maps to offline + queued, never a throw into the caller', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-pre-stop', project: harness.workingDir, title: 'T' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-pre-stop') ?? null,
      'session tui-pre-stop appears in sessions.list');

    await harness.daemon.stop(); // genuine outage — the socket now refuses
    expect(() => client.register({ sessionId: 'tui-after-stop', project: harness!.workingDir, title: 'T' })).not.toThrow();
    // Same reasoning as above: poll for the state the outage must produce
    // rather than guessing how long a refused socket takes to be observed.
    await waitFor(async () => (client.status() === 'offline' && client.pendingOps > 0 ? true : null),
      'the daemon outage flips the client offline with the op queued');
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBeGreaterThan(0);
    client.dispose();
  }, TEST_BUDGET_MS);

  test('close is honest: the daemon record flips to status closed', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-close-1', project: harness.workingDir, title: 'T' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-close-1') ?? null,
      'session tui-close-1 appears in sessions.list');

    client.close('tui-close-1');
    const closed = await waitFor(async () => {
      const s = await harness!.getSession('tui-close-1');
      return s?.status === 'closed' ? s : null;
    }, 'session tui-close-1 reaches status closed');
    expect(closed.status).toBe('closed');
    client.dispose();
  }, TEST_BUDGET_MS);
});
