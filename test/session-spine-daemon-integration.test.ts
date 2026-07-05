/**
 * session-spine-daemon-integration.test.ts
 *
 * W3-S4 consumability proof: drives the extracted SDK SessionSpineClient against a
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

async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 2_000, intervalMs = 20): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: timed out');
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
    const record = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-create-1') ?? null);
    expect(record.kind).toBe('tui');
    expect(record.project).toBe(harness.workingDir);
    expect(record.status).toBe('active');
    client.dispose();
  });

  test('keepalive advances the participant lastSeenAt on its own cadence with no activity', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', heartbeatMinIntervalMs: 20, log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-keepalive-1', project: harness.workingDir, title: 'T' });
    const initial = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-keepalive-1') ?? null);
    const initialLastSeen = initial.participants[0]?.lastSeenAt ?? 0;

    // No further calls into the client — the 20ms keepalive timer drives heartbeats.
    const advanced = await waitFor(async () => {
      const rec = (await harness!.listSessions()).find((s) => s.id === 'tui-keepalive-1');
      const lastSeen = rec?.participants[0]?.lastSeenAt ?? 0;
      return lastSeen > initialLastSeen ? rec : null;
    });
    expect((advanced.participants[0]?.lastSeenAt ?? 0)).toBeGreaterThan(initialLastSeen);
    client.dispose();
  });

  test('offline queue + reconnect flush: an op buffered during an outage lands once the wire recovers', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);

    client.register({ sessionId: 'tui-online-1', project: harness.workingDir, title: 'Online' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-online-1') ?? null);
    // The reachability flip lands one microtask after the record is persisted; poll for it.
    await waitFor(async () => (client.status() === 'online' ? true : null));

    // Transient outage: the register buffers into the bounded ring, never lands yet.
    harness.setBlocked(true);
    client.register({ sessionId: 'tui-queued-1', project: harness.workingDir, title: 'Queued' });
    await new Promise((r) => setTimeout(r, 30));
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBe(1);
    const stillMissing = (await harness.listSessions()).find((s) => s.id === 'tui-queued-1') ?? null;
    expect(stillMissing).toBeNull();

    // Recover: the next op triggers a flush that replays the buffered register.
    harness.setBlocked(false);
    client.heartbeat('tui-online-1');
    const flushed = await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-queued-1') ?? null);
    expect(flushed.status).toBe('active');
    expect(client.status()).toBe('online');
    expect(client.pendingOps).toBe(0);
    client.dispose();
  });

  test('a real daemon outage (stop) maps to offline + queued, never a throw into the caller', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-pre-stop', project: harness.workingDir, title: 'T' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-pre-stop') ?? null);

    await harness.daemon.stop(); // genuine outage — the socket now refuses
    expect(() => client.register({ sessionId: 'tui-after-stop', project: harness!.workingDir, title: 'T' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.status()).toBe('offline');
    expect(client.pendingOps).toBeGreaterThan(0);
    client.dispose();
  });

  test('close is honest: the daemon record flips to status closed', async () => {
    harness = await startHarness();
    const client = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui', log: { debug: () => {}, info: () => {} } });
    client.activate(harness.spineTransport);
    client.register({ sessionId: 'tui-close-1', project: harness.workingDir, title: 'T' });
    await waitFor(async () => (await harness!.listSessions()).find((s) => s.id === 'tui-close-1') ?? null);

    client.close('tui-close-1');
    const closed = await waitFor(async () => {
      const s = await harness!.getSession('tui-close-1');
      return s?.status === 'closed' ? s : null;
    });
    expect(closed.status).toBe('closed');
    client.dispose();
  });
});
