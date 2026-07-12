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
  PREVIOUS_FILE_SUFFIX,
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
  const serviceActions: AutoUpdateServiceActions = {
    isSupervised: () => actions.supervised,
    adoptIntoService: () => { actions.adopted += 1; },
    restartService: () => { actions.restarted += 1; },
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
    exitProcess: (code) => void exits.push(code),
    now: () => new Date(2026, 6, 12, 14, 30).getTime(),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { updater, files, receipts, actions, exits, timers, requests, scratch };
}

describe('DaemonAutoUpdater', () => {
  test('hourly cadence: start schedules a check one interval out, and a current daemon does nothing', async () => {
    const h = makeHarness({ idle: () => true, latestTag: 'v1.0.0' });
    try {
      h.updater.start();
      expect(h.timers).toHaveLength(1);
      expect(h.timers[0]!.ms).toBe(60 * 60 * 1000);

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
      expect(receipts[0]!.text).toBe('updated from 1.0.0 to 2.0.0 at 14:30');
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
