/**
 * The daemon's hourly self-update loop: check cadence, the no-active-work
 * swap gate (a mid-turn daemon never swaps), service-manager restart,
 * adoption of an unsupervised daemon, and the update receipt. Time,
 * network, filesystem, activity, service actions, and exit all mocked.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DaemonAutoUpdater,
  defaultDownloadBaseUrl,
  type AutoUpdateServiceActions,
} from '../packages/sdk/src/platform/daemon/auto-updater.js';
import { DaemonReceiptStore } from '../packages/sdk/src/platform/daemon/receipts.js';
import {
  BOOT_SETTLE_CHECK_DELAY_MS,
  PREVIOUS_FILE_SUFFIX,
  PeriodicUpdateLoop,
  sha256,
  type UpdateFetchLike,
  type UpdateFileIo,
} from '../packages/sdk/src/platform/runtime/self-update.js';

const LATEST_URL = 'https://example.test/releases/latest';
const NEW_TAG = 'v2.0.0';
const DAEMON_ASSET = 'goodvibes-daemon-linux-x64';
const NEW_DAEMON = Buffer.from('daemon-v2');

function memoryIo(initial: Record<string, Buffer>) {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const io: UpdateFileIo = {
    writeFile: (path, data) => void files.set(path, data),
    rename: (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    chmod: () => {},
    exists: (path) => files.has(path),
    mkdir: () => {},
  };
  return { files, io };
}

function releaseFetch(overrides: { latestTag?: string } = {}): { fetchImpl: UpdateFetchLike; requests: string[] } {
  const tag = overrides.latestTag ?? NEW_TAG;
  const base = defaultDownloadBaseUrl(LATEST_URL, tag);
  const manifest = `${sha256(NEW_DAEMON)}  ${DAEMON_ASSET}\n`;
  const requests: string[] = [];
  const fetchImpl: UpdateFetchLike = async (url) => {
    requests.push(url);
    if (url === LATEST_URL) {
      return {
        ok: false, status: 302, url,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? `https://example.test/releases/tag/${tag}` : null) },
        text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const body = url === `${base}/SHA256SUMS.txt`
      ? Buffer.from(manifest)
      : url === `${base}/${DAEMON_ASSET}`
        ? NEW_DAEMON
        : null;
    if (!body) {
      return { ok: false, status: 404, url, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true, status: 200, url, headers: { get: () => null },
      text: async () => body.toString('utf-8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetchImpl, requests };
}

interface Harness {
  updater: DaemonAutoUpdater;
  files: Map<string, Buffer>;
  receipts: DaemonReceiptStore;
  actions: { supervised: boolean; adopted: number; restarted: number };
  exits: number[];
  timers: Array<{ fn: () => void; ms: number }>;
  requests: string[];
  /** Handover steps in the order they happened, so "stop first" is provable. */
  sequence: string[];
  scratch: string;
}

function makeHarness(options: {
  idle: () => boolean;
  supervised?: boolean;
  latestTag?: string;
  currentVersion?: string;
} ): Harness {
  const scratch = mkdtempSync(join(tmpdir(), 'auto-updater-'));
  const { files, io } = memoryIo({ '/opt/gv/goodvibes-daemon': Buffer.from('daemon-v1') });
  const { fetchImpl, requests } = releaseFetch({ ...(options.latestTag ? { latestTag: options.latestTag } : {}) });
  const receipts = new DaemonReceiptStore(join(scratch, 'receipts.json'), { now: () => new Date(2026, 6, 12, 14, 30).getTime() });
  const actions = { supervised: options.supervised ?? true, adopted: 0, restarted: 0 };
  const sequence: string[] = [];
  const serviceActions: AutoUpdateServiceActions = {
    isSupervised: () => actions.supervised,
    adoptIntoService: () => { actions.adopted += 1; sequence.push('adopt'); },
    restartService: () => { actions.restarted += 1; sequence.push('restart'); },
  };
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const updater = new DaemonAutoUpdater({
    currentVersion: options.currentVersion ?? '1.0.0',
    execPath: '/opt/gv/goodvibes-daemon',
    platform: 'linux',
    arch: 'x64',
    releasesLatestUrl: LATEST_URL,
    checkIntervalMs: 60 * 60 * 1000,
    busyRetryMs: 60 * 1000,
    isIdle: options.idle,
    serviceActions,
    receipts,
    fetchImpl,
    io,
    exitProcess: (code) => { exits.push(code); sequence.push('exit'); },
    stopGracefully: () => { sequence.push('stop'); },
    now: () => new Date(2026, 6, 12, 14, 30).getTime(),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { updater, files, receipts, actions, exits, timers, requests, sequence, scratch };
}

describe('DaemonAutoUpdater', () => {
  test('boot-settle first check, then the hourly cadence; a current daemon does nothing', async () => {
    const h = makeHarness({ idle: () => true, latestTag: 'v1.0.0' });
    try {
      h.updater.start();
      expect(h.timers).toHaveLength(1);
      // The first check runs shortly after start — a daemon that was down
      // while releases shipped must not stay stale for another whole hour.
      expect(h.timers[0]!.ms).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
      expect(h.updater.firstCheckDelayMs).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
      expect(h.updater.checkIntervalMs).toBe(60 * 60 * 1000);

      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(0);
      expect(h.receipts.list()).toHaveLength(0);
      // The follow-up is another full interval, not the busy-retry cadence.
      expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an idle daemon updates: verified swap with kept previous, restart via the service manager, and a receipt', async () => {
    const h = makeHarness({ idle: () => true });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.files.get(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)?.toString()).toBe('daemon-v1');
      expect(h.actions.restarted).toBe(1);
      expect(h.actions.adopted).toBe(0);
      expect(h.exits).toEqual([]);
      const receipts = h.receipts.list();
      expect(receipts).toHaveLength(1);
      // One update, one receipt — and it names the client restart, because a
      // swap replaces the daemon binary only: every client already attached
      // keeps its old build until it is restarted.
      expect(receipts[0]!.text).toStartWith('updated from 1.0.0 to 2.0.0 at 14:30');
      expect(receipts[0]!.text).toContain('keep their old build until restarted');
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('a mid-turn daemon NEVER swaps: the verified update waits for an idle moment on the retry cadence', async () => {
    let busy = true;
    const h = makeHarness({ idle: () => !busy });
    try {
      await h.updater.tick();
      // Busy: nothing swapped, nothing restarted, and the next check is the
      // short busy-retry, not the hourly interval.
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1');
      expect(h.files.has(`/opt/gv/goodvibes-daemon${PREVIOUS_FILE_SUFFIX}`)).toBe(false);
      expect(h.actions.restarted).toBe(0);
      expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 1000);

      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v1'); // still busy, still no swap

      busy = false;
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.restarted).toBe(1);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('an unsupervised daemon is adopted into the service and steps aside', async () => {
    const h = makeHarness({ idle: () => true, supervised: false });
    try {
      await h.updater.tick();
      expect(h.files.get('/opt/gv/goodvibes-daemon')?.toString()).toBe('daemon-v2');
      expect(h.actions.adopted).toBe(1);
      expect(h.actions.restarted).toBe(0);
      expect(h.exits).toEqual([0]);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });

  test('the restart runs the daemon\'s orderly stop FIRST, so shutdown hooks fire on an update', async () => {
    const supervised = makeHarness({ idle: () => true });
    try {
      await supervised.updater.tick();
      expect(supervised.sequence).toEqual(['stop', 'restart']);
    } finally {
      rmSync(supervised.scratch, { recursive: true, force: true });
    }
    const unsupervised = makeHarness({ idle: () => true, supervised: false });
    try {
      await unsupervised.updater.tick();
      expect(unsupervised.sequence).toEqual(['stop', 'adopt', 'exit']);
    } finally {
      rmSync(unsupervised.scratch, { recursive: true, force: true });
    }
  });

  test('stop() halts the loop', async () => {
    const h = makeHarness({ idle: () => true });
    try {
      h.updater.start();
      h.updater.stop();
      const timersBefore = h.timers.length;
      await h.updater.tick(); // stopped: no work, no rescheduling
      expect(h.requests).toEqual([]);
      expect(h.timers.length).toBe(timersBefore);
    } finally {
      rmSync(h.scratch, { recursive: true, force: true });
    }
  });
});

describe('PeriodicUpdateLoop cadence', () => {
  function loopHarness(options: {
    outcome: () => 'settled' | 'deferred';
    firstCheckDelayMs?: number;
    checkIntervalMs?: number;
    busyRetryMs?: number;
    throws?: boolean;
  }) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const errors: unknown[] = [];
    const loop = new PeriodicUpdateLoop({
      ...(options.firstCheckDelayMs !== undefined ? { firstCheckDelayMs: options.firstCheckDelayMs } : {}),
      ...(options.checkIntervalMs !== undefined ? { checkIntervalMs: options.checkIntervalMs } : {}),
      ...(options.busyRetryMs !== undefined ? { busyRetryMs: options.busyRetryMs } : {}),
      runCheck: async () => {
        if (options.throws) throw new Error('check failed');
        return options.outcome();
      },
      onError: (error) => void errors.push(error),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    return { loop, timers, errors };
  }

  test('first check is the boot-settle delay; every check after it is the cadence', async () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 60 * 60 * 1000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(BOOT_SETTLE_CHECK_DELAY_MS);
    await h.loop.tick();
    expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
  });

  test('the boot-settle delay never exceeds one cadence', () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 10_000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(10_000);
  });

  test('an explicit first-check delay is honored', () => {
    const h = loopHarness({ outcome: () => 'settled', firstCheckDelayMs: 2_000, checkIntervalMs: 60_000 });
    h.loop.start();
    expect(h.timers[0]!.ms).toBe(2_000);
  });

  test('a deferred check comes back on the short retry cadence', async () => {
    const h = loopHarness({ outcome: () => 'deferred', checkIntervalMs: 60 * 60 * 1000, busyRetryMs: 45_000 });
    await h.loop.tick();
    expect(h.timers[h.timers.length - 1]!.ms).toBe(45_000);
  });

  test('a check that throws is reported and keeps the steady cadence', async () => {
    const h = loopHarness({ outcome: () => 'settled', throws: true, checkIntervalMs: 60 * 60 * 1000 });
    await h.loop.tick();
    expect(h.errors).toHaveLength(1);
    expect(h.timers[h.timers.length - 1]!.ms).toBe(60 * 60 * 1000);
  });

  test('delays are floored so a misconfigured cadence never spins', () => {
    const h = loopHarness({ outcome: () => 'settled', checkIntervalMs: 0, busyRetryMs: -5 });
    expect(h.loop.checkIntervalMs).toBe(1_000);
    expect(h.loop.busyRetryMs).toBe(1_000);
  });
});
