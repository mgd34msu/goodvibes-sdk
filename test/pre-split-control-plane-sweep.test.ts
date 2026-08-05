/**
 * pre-split-control-plane-sweep.test.ts
 *
 * The boot sweep that ends the two-control-plane-stores condition.
 *
 * The live shape it was written from: an owner machine with a session store at
 * `~/.goodvibes/tui/control-plane/sessions.json` that the broker serves, and a
 * second one at `~/.goodvibes/control-plane/sessions.json` — bigger, holding
 * sessions the live one did not, last written the second the daemon started,
 * and read by nothing. Beside it in the same directory sat two files that were
 * NOT stale: occasions-state.json (written the day before) and
 * workspace-registrations.json, each the only copy of live state.
 *
 * So the sweep has to do two opposite things in one pass, and the tests below
 * pin both: fold and quarantine what DUPLICATES the live store, leave alone and
 * disclose what only exists at the legacy path.
 *
 * Every test builds its own temp home. Nothing here touches a real one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRE_SPLIT_QUARANTINE_PREFIX,
  reapQuarantineDirectories,
  sweepPreSplitControlPlaneStore,
} from '../packages/sdk/src/platform/control-plane/pre-split-control-plane-sweep.ts';
import {
  importLegacyDaemonSessionStores,
  runDaemonSessionStoreBoot,
} from '../packages/sdk/src/platform/daemon/daemon-session-store-boot.ts';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.ts';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeBroker(storePath: string): SharedSessionBroker {
  return disposables.add(new SharedSessionBroker({
    storePath,
    routeBindings: { start: async () => {}, patchBinding: async () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => true },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]));
}

interface Home {
  readonly root: string;
  /** `<home>/.goodvibes/control-plane` — the unscoped, pre-split store. */
  readonly legacyDirectory: string;
  /** `<home>/.goodvibes/tui/control-plane` — where the daemon's own state belongs. */
  readonly scopedDirectory: string;
  readonly goodvibesRoot: string;
}

function makeHome(): Home {
  const root = mkdtempSync(join(tmpdir(), 'pre-split-sweep-'));
  roots.push(root);
  const goodvibesRoot = join(root, '.goodvibes');
  const legacyDirectory = join(goodvibesRoot, 'control-plane');
  const scopedDirectory = join(goodvibesRoot, 'tui', 'control-plane');
  mkdirSync(legacyDirectory, { recursive: true });
  mkdirSync(scopedDirectory, { recursive: true });
  return { root, legacyDirectory, scopedDirectory, goodvibesRoot };
}

function quarantineDirectories(goodvibesRoot: string): readonly string[] {
  return readdirSync(goodvibesRoot).filter((entry) => entry.startsWith(PRE_SPLIT_QUARANTINE_PREFIX));
}

describe('pre-split control-plane sweep', () => {
  test('folds the sessions the stale store held and the live store did not, then moves it aside with a receipt naming it', async () => {
    const home = makeHome();

    // The store the broker serves: two sessions.
    const live = makeBroker(join(home.scopedDirectory, 'sessions.json'));
    await live.createSession({ id: 'live-1', kind: 'agent', project: '/w' });
    await live.createSession({ id: 'shared', kind: 'agent', project: '/w' });

    // The pre-split store: one the live store shares, one it has never seen.
    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'shared', kind: 'tui', project: '/w' });
    await stale.createSession({ id: 'only-in-stale', kind: 'tui', project: '/w' });

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('swept');
    // Exactly the one the live store did not already have.
    expect(report.foldedSessions).toBe(1);
    expect(report.movedFiles).toEqual(['sessions.json']);
    expect(report.failures).toEqual([]);

    // The session is now readable from the store the broker actually serves.
    const reopened = makeBroker(join(home.scopedDirectory, 'sessions.json'));
    await reopened.start();
    const ids = new Set(reopened.listSessions(100).map((session) => session.id));
    expect(ids.has('only-in-stale')).toBe(true);
    expect(ids.has('live-1')).toBe(true);
    expect(ids.has('shared')).toBe(true);

    // The stale file is gone from the legacy path and recoverable in quarantine.
    expect(existsSync(join(home.legacyDirectory, 'sessions.json'))).toBe(false);
    expect(report.quarantineDirectory).not.toBeNull();
    expect(existsSync(join(report.quarantineDirectory as string, 'sessions.json'))).toBe(true);

    // Nothing else was in the legacy directory, so the directory itself is gone —
    // no empty decoy left for the next person to find.
    expect(report.legacyDirectoryRemoved).toBe(true);
    expect(existsSync(home.legacyDirectory)).toBe(false);

    // The receipt names the file, the count, and where it went.
    expect(report.receipt).toContain('sessions.json');
    expect(report.receipt).toContain('1 session');
    expect(report.receipt).toContain(report.quarantineDirectory as string);
  });

  test('MOVES a file that exists only at the legacy path into the scoped directory, whole, with a receipt naming it', async () => {
    const home = makeHome();

    const live = makeBroker(join(home.scopedDirectory, 'sessions.json'));
    await live.createSession({ id: 'live-1', kind: 'agent', project: '/w' });
    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'only-in-stale', kind: 'tui', project: '/w' });

    // The two files that were live-in-use on the owner's machine: no counterpart
    // in the scoped directory, so each is the ONLY copy of real state — written
    // there by a composition site that forgot the surface segment.
    const occasions = '{"occasions":[{"id":"birthday-1"}]}';
    const principals = '{"principals":[]}';
    writeFileSync(join(home.legacyDirectory, 'occasions-state.json'), occasions);
    writeFileSync(join(home.legacyDirectory, 'principals.json'), principals);

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('swept');
    expect(report.adoptedFiles).toEqual(['occasions-state.json', 'principals.json']);
    expect(report.movedFiles).toEqual(['sessions.json']);
    expect(report.conflictedFiles).toEqual([]);

    // Moved, not copied, and byte-for-byte: a move carries the state whole, so
    // no shape is parsed and no merge is invented.
    expect(readFileSync(join(home.scopedDirectory, 'occasions-state.json'), 'utf8')).toBe(occasions);
    expect(readFileSync(join(home.scopedDirectory, 'principals.json'), 'utf8')).toBe(principals);
    expect(existsSync(join(home.legacyDirectory, 'occasions-state.json'))).toBe(false);

    // Nothing is left, so the pre-split directory is gone — one store, no decoy.
    expect(report.legacyDirectoryRemoved).toBe(true);
    expect(existsSync(home.legacyDirectory)).toBe(false);

    expect(report.receipt).toContain('occasions-state.json');
    expect(report.receipt).toContain(home.scopedDirectory);
    expect(report.receipt).toContain('the pre-split directory is gone');
  });

  test('leaves the cross-product workspace register at the unscoped path on purpose, and says why', async () => {
    const home = makeHome();
    writeFileSync(join(home.scopedDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');
    const registrations = '{"registrations":["/home/somebody/project"]}';
    writeFileSync(join(home.legacyDirectory, 'workspace-registrations.json'), registrations);

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    // goodvibes-agent reads this same file directly. Moving it under one
    // product's surface root would hide it from the others, so the sweep does
    // not touch it — and the directory it keeps alive is explained rather than
    // left looking like an unfinished migration.
    expect(report.sharedFiles).toEqual(['workspace-registrations.json']);
    expect(report.adoptedFiles).toEqual([]);
    expect(report.movedFiles).toEqual([]);
    expect(readFileSync(join(home.legacyDirectory, 'workspace-registrations.json'), 'utf8')).toBe(registrations);
    expect(existsSync(join(home.scopedDirectory, 'workspace-registrations.json'))).toBe(false);
    expect(report.legacyDirectoryRemoved).toBe(false);
    expect(report.receipt).toContain('on purpose');
    expect(report.receipt).toContain('workspace-registrations.json');
  });

  test('REFUSES loudly when both copies exist and disagree: nothing moves, both survive, the receipt names the conflict', async () => {
    const home = makeHome();
    writeFileSync(join(home.scopedDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');

    const inUse = '{"occasions":[{"id":"scoped"}]}';
    const older = '{"occasions":[{"id":"legacy"}]}';
    writeFileSync(join(home.scopedDirectory, 'occasions-state.json'), inUse);
    writeFileSync(join(home.legacyDirectory, 'occasions-state.json'), older);

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('conflicted');
    expect(report.conflictedFiles).toEqual(['occasions-state.json']);
    expect(report.adoptedFiles).toEqual([]);
    expect(report.movedFiles).toEqual([]);
    expect(report.quarantineDirectory).toBeNull();

    // NOTHING is lost and nothing is picked as a winner. Both bytes survive.
    expect(readFileSync(join(home.scopedDirectory, 'occasions-state.json'), 'utf8')).toBe(inUse);
    expect(readFileSync(join(home.legacyDirectory, 'occasions-state.json'), 'utf8')).toBe(older);
    expect(report.legacyDirectoryRemoved).toBe(false);

    // The receipt says which copy readers use and where the other one is.
    expect(report.receipt).toContain('occasions-state.json');
    expect(report.receipt).toContain('different content');
    expect(report.receipt).toContain(home.scopedDirectory);
    expect(report.receipt).toContain(home.legacyDirectory);
  });

  test('retires a legacy copy that says exactly what the scoped one already says', async () => {
    const home = makeHome();
    writeFileSync(join(home.scopedDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');
    const same = '{"profiles":[]}';
    writeFileSync(join(home.scopedDirectory, 'channel-profiles.json'), same);
    writeFileSync(join(home.legacyDirectory, 'channel-profiles.json'), same);

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('swept');
    expect(report.movedFiles).toEqual(['channel-profiles.json']);
    expect(report.conflictedFiles).toEqual([]);
    expect(readFileSync(join(home.scopedDirectory, 'channel-profiles.json'), 'utf8')).toBe(same);
    expect(report.legacyDirectoryRemoved).toBe(true);
  });

  test('is idempotent: a second run finds nothing to do and mints no second quarantine', async () => {
    const home = makeHome();
    const live = makeBroker(join(home.scopedDirectory, 'sessions.json'));
    await live.createSession({ id: 'live-1', kind: 'agent', project: '/w' });
    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'only-in-stale', kind: 'tui', project: '/w' });

    const first = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });
    expect(first.status).toBe('swept');
    expect(quarantineDirectories(home.goodvibesRoot).length).toBe(1);

    const second = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });
    // The directory is gone, so there is nothing left to detect.
    expect(second.status).toBe('absent');
    expect(second.receipt).toBeNull();
    expect(quarantineDirectories(home.goodvibesRoot).length).toBe(1);
  });

  test('an empty legacy directory is reported clean and removed', async () => {
    const home = makeHome();
    writeFileSync(join(home.scopedDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('clean');
    expect(report.movedFiles).toEqual([]);
    expect(report.adoptedFiles).toEqual([]);
    expect(report.receipt).toBeNull();
    expect(report.legacyDirectoryRemoved).toBe(true);
  });

  test('no legacy directory at all is absent, not an error', async () => {
    const home = makeHome();
    rmSync(home.legacyDirectory, { recursive: true, force: true });

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.legacyDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('absent');
    expect(report.receipt).toBeNull();
  });

  test('never sweeps the live store when both paths resolve to the same place', async () => {
    const home = makeHome();
    writeFileSync(join(home.scopedDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');

    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: home.scopedDirectory,
      scopedDirectory: home.scopedDirectory,
      sessionStorePath: join(home.scopedDirectory, 'sessions.json'),
    });

    expect(report.status).toBe('absent');
    expect(existsSync(join(home.scopedDirectory, 'sessions.json'))).toBe(true);
  });

  test('quarantine directories are bounded: expired ones are reaped and the count is capped, newest kept', () => {
    const home = makeHome();
    const now = Date.UTC(2026, 7, 5);
    const day = 24 * 60 * 60 * 1000;

    // One well past the 30-day TTL.
    const expired = join(home.goodvibesRoot, `${PRE_SPLIT_QUARANTINE_PREFIX}${now - 40 * day}-1`);
    mkdirSync(expired, { recursive: true });
    utimesSync(expired, new Date(now - 40 * day), new Date(now - 40 * day));

    // Seven within the TTL, against a cap of five: the two oldest go.
    const withinTtl: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const at = now - (index + 1) * day;
      const path = join(home.goodvibesRoot, `${PRE_SPLIT_QUARANTINE_PREFIX}${at}-${index}`);
      mkdirSync(path, { recursive: true });
      utimesSync(path, new Date(at), new Date(at));
      withinTtl.push(path);
    }

    const result = reapQuarantineDirectories(home.goodvibesRoot, now);

    expect(result.expired).toBe(1);
    expect(result.overCap).toBe(2);
    expect(existsSync(expired)).toBe(false);
    // Newest five kept (indices 0..4), two oldest (5, 6) removed.
    for (const path of withinTtl.slice(0, 5)) expect(existsSync(path)).toBe(true);
    for (const path of withinTtl.slice(5)) expect(existsSync(path)).toBe(false);
  });
});

/**
 * The other half of the defect: the sweep is pointless while something keeps
 * recreating what it moved aside. These pin the boot fold's target.
 */
describe('boot fold targets the store the broker actually serves', () => {
  function shellPathsFor(home: Home) {
    return {
      workingDirectory: home.root,
      resolveUserPath: (...segments: string[]) => join(home.goodvibesRoot, ...segments),
    };
  }

  test('folds into the live store and leaves the unscoped path unwritten', async () => {
    const home = makeHome();
    const liveStorePath = join(home.scopedDirectory, 'sessions.json');
    const live = makeBroker(liveStorePath);
    await live.createSession({ id: 'live-1', kind: 'agent', project: '/w' });

    // Start from a legacy directory that does NOT exist, which is the state a
    // clean machine is in. The old code created it anyway, every boot.
    rmSync(home.legacyDirectory, { recursive: true, force: true });

    await importLegacyDaemonSessionStores(shellPathsFor(home), liveStorePath);

    expect(existsSync(join(home.legacyDirectory, 'sessions.json'))).toBe(false);
    const reopened = makeBroker(liveStorePath);
    await reopened.start();
    expect(reopened.listSessions(100).map((session) => session.id)).toContain('live-1');
  });

  test('treats an existing unscoped store as a SOURCE, so what landed there is folded forward once', async () => {
    const home = makeHome();
    const liveStorePath = join(home.scopedDirectory, 'sessions.json');
    const live = makeBroker(liveStorePath);
    await live.createSession({ id: 'live-1', kind: 'agent', project: '/w' });

    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'stranded', kind: 'tui', project: '/w' });

    await importLegacyDaemonSessionStores(shellPathsFor(home), liveStorePath);

    const reopened = makeBroker(liveStorePath);
    await reopened.start();
    const ids = new Set(reopened.listSessions(100).map((session) => session.id));
    expect(ids.has('stranded')).toBe(true);
    expect(ids.has('live-1')).toBe(true);
  });

  test('a broker built on a path exposes that path', () => {
    const home = makeHome();
    const liveStorePath = join(home.scopedDirectory, 'sessions.json');
    expect(makeBroker(liveStorePath).storePath).toBe(liveStorePath);
  });

  test('the combined boot step folds, sweeps and hands the receipt to the caller in one pass', async () => {
    const home = makeHome();
    const liveStorePath = join(home.scopedDirectory, 'sessions.json');
    const broker = makeBroker(liveStorePath);
    await broker.createSession({ id: 'live-1', kind: 'agent', project: '/w' });
    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'stranded', kind: 'tui', project: '/w' });

    const receipts: string[] = [];
    const report = await runDaemonSessionStoreBoot({
      sessionBroker: broker,
      shellPaths: shellPathsFor(home),
      surfaceRoot: 'tui',
      recordReceipt: (text) => receipts.push(text),
    });

    expect(report?.status).toBe('swept');
    expect(report?.movedFiles).toEqual(['sessions.json']);
    // The fold ran first, so the sweep found the stranded session already in
    // the live store and had nothing left to rescue from the file it moved.
    expect(report?.foldedSessions).toBe(0);
    expect(receipts.length).toBe(1);
    expect(receipts[0]).toContain('sessions.json');

    const reopened = makeBroker(liveStorePath);
    await reopened.start();
    expect(reopened.listSessions(100).map((session) => session.id)).toContain('stranded');
  });

  test('one boot migrates a pre-split machine whole; the second boot is a no-op', async () => {
    const home = makeHome();
    const liveStorePath = join(home.scopedDirectory, 'sessions.json');
    const broker = makeBroker(liveStorePath);
    await broker.createSession({ id: 'live-1', kind: 'agent', project: '/w' });

    // The owner's machine, reproduced: a pre-split directory holding a stale
    // session store plus the two files that were the only copy of live state.
    const stale = makeBroker(join(home.legacyDirectory, 'sessions.json'));
    await stale.createSession({ id: 'stranded', kind: 'tui', project: '/w' });
    const occasions = '{"occasions":[{"id":"birthday-1"}]}';
    writeFileSync(join(home.legacyDirectory, 'occasions-state.json'), occasions);
    writeFileSync(join(home.legacyDirectory, 'principals.json'), '{"principals":[]}');

    const firstBootReceipts: string[] = [];
    const first = await runDaemonSessionStoreBoot({
      sessionBroker: broker,
      shellPaths: shellPathsFor(home),
      surfaceRoot: 'tui',
      recordReceipt: (text) => firstBootReceipts.push(text),
    });

    // After ONE boot: the state is all in the scoped directory and the
    // pre-split directory is gone. No second store, no empty decoy.
    expect(first?.status).toBe('swept');
    expect(first?.legacyDirectoryRemoved).toBe(true);
    expect(existsSync(home.legacyDirectory)).toBe(false);
    expect(readFileSync(join(home.scopedDirectory, 'occasions-state.json'), 'utf8')).toBe(occasions);
    expect(existsSync(join(home.scopedDirectory, 'principals.json'))).toBe(true);
    expect(firstBootReceipts.length).toBe(1);

    // The stranded session survived, in the store the broker serves.
    const reopened = makeBroker(liveStorePath);
    await reopened.start();
    const ids = new Set(reopened.listSessions(100).map((session) => session.id));
    expect(ids.has('stranded')).toBe(true);
    expect(ids.has('live-1')).toBe(true);

    // Second boot: nothing to find, nothing said, no second quarantine.
    const quarantinesAfterFirst = quarantineDirectories(home.goodvibesRoot).length;
    const secondBootReceipts: string[] = [];
    const second = await runDaemonSessionStoreBoot({
      sessionBroker: reopened,
      shellPaths: shellPathsFor(home),
      surfaceRoot: 'tui',
      recordReceipt: (text) => secondBootReceipts.push(text),
    });

    expect(second?.status).toBe('absent');
    expect(secondBootReceipts).toEqual([]);
    expect(quarantineDirectories(home.goodvibesRoot).length).toBe(quarantinesAfterFirst);
    expect(readFileSync(join(home.scopedDirectory, 'occasions-state.json'), 'utf8')).toBe(occasions);
  });

  test('a broker with no file of its own leaves the session store alone rather than moving it where nothing reads', async () => {
    const home = makeHome();
    writeFileSync(join(home.legacyDirectory, 'sessions.json'), '{"version":1,"sessions":[]}');

    const receipts: string[] = [];
    const report = await runDaemonSessionStoreBoot({
      sessionBroker: { storePath: null },
      shellPaths: shellPathsFor(home),
      surfaceRoot: 'tui',
      recordReceipt: (text) => receipts.push(text),
    });

    // The other stores still migrate — that is real work and unrelated to the
    // broker. The SESSION store alone is left exactly where it is, and said so,
    // because nothing here can name where those sessions belong.
    expect(report?.skippedFiles).toEqual(['sessions.json']);
    expect(report?.adoptedFiles).toEqual([]);
    expect(existsSync(join(home.legacyDirectory, 'sessions.json'))).toBe(true);
    expect(existsSync(join(home.scopedDirectory, 'sessions.json'))).toBe(false);
    expect(receipts[0]).toContain('injected store');
  });
});
