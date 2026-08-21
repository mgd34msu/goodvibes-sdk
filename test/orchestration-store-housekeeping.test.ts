/**
 * Housekeeping regressions for three persisted orchestration-side stores:
 *  1. the cross-session task graph (sessions/orchestration/registry.ts),
 *  2. the orchestration workstream snapshots (orchestration/persistence.ts),
 *  3. the managed worktree register (runtime/worktree/registry.ts).
 *
 * Each store must reap records whose owner is gone, bound itself by BOTH a
 * count cap and an age TTL, reject a torn/partial file by CONTENT rather than
 * serving it, sweep more than once, disclose what it reclaimed, and reclaim
 * nothing on a second identical pass.
 */
import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrossSessionTaskRegistry } from '../packages/sdk/src/platform/sessions/orchestration/registry.js';
import type { CrossSessionTaskRef, SessionTaskGraphSnapshot } from '../packages/sdk/src/platform/sessions/orchestration/types.js';
import {
  listSnapshotWorkstreamIds,
  loadWorkstreamSnapshot,
  reapOrchestrationSnapshots,
  writeWorkstreamSnapshot,
} from '../packages/sdk/src/platform/orchestration/persistence.js';
import { emptyWorkItemUsage, type WorkItem, type Workstream } from '../packages/sdk/src/platform/orchestration/types.js';
import { WorktreeRegistry } from '../packages/sdk/src/platform/runtime/worktree/registry.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

const NOW = 1_800_000_000_000; // fixed clock for every age assertion

/**
 * An `updatedAt` far enough in the past to clear the 24-hour ownerless grace
 * floor, but nowhere near the 30-day TTL, so a record stamped with it is
 * removable ONLY by the missing-owner rule, never by expiry. That separation is
 * what lets these tests attribute a deletion to the right rule.
 */
const PAST_GRACE = NOW - 2 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const scratchRoots: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

function spyInfo(): Mock<typeof logger.info> {
  const spy = spyOn(logger, 'info');
  spies.push(spy);
  return spy;
}

function spyWarn(): Mock<typeof logger.warn> {
  const spy = spyOn(logger, 'warn');
  spies.push(spy);
  return spy;
}

function messages(spy: Mock<typeof logger.info> | Mock<typeof logger.warn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

function dataFor(spy: Mock<typeof logger.info>, needle: string): Record<string, unknown> | undefined {
  const call = spy.mock.calls.find((entry) => String(entry[0]).includes(needle));
  return call?.[1] as Record<string, unknown> | undefined;
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ── 1. Cross-session task graph ───────────────────────────────────────────────

function graphSnapshot(overrides: Partial<SessionTaskGraphSnapshot> = {}): SessionTaskGraphSnapshot {
  return {
    version: 1,
    snapshotAt: NOW,
    refs: {},
    edges: [],
    handoffs: [],
    ...overrides,
  };
}

function ref(sessionId: string, taskId: string, updatedAt = NOW): CrossSessionTaskRef {
  return { sessionId, taskId, title: `${taskId} title`, status: 'running', createdAt: updatedAt, updatedAt };
}

function writeGraph(path: string, snapshot: SessionTaskGraphSnapshot): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8');
}

function makeRegistry(
  path: string,
  options: { sessionExists?: (sessionId: string) => boolean; now?: number } = {},
): CrossSessionTaskRegistry {
  return new CrossSessionTaskRegistry(path, {
    ...(options.sessionExists ? { sessionExists: options.sessionExists } : {}),
    now: () => options.now ?? NOW,
    sweepIntervalMs: 0,
  });
}

describe('cross-session task graph housekeeping', () => {
  test('a zero-byte graph file is rejected, not served, and preserved aside', () => {
    const root = scratch('graph-zero-');
    const path = join(root, 'task-graph.json');
    writeFileSync(path, '', 'utf-8');
    const warn = spyWarn();

    const registry = makeRegistry(path);
    try {
      expect(registry.getAllRefs()).toEqual([]);
      expect(existsSync(`${path}.unrecognized`)).toBe(true);
      expect(messages(warn).some((message) => message.includes('failed content validation'))).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  test('a truncated graph file is rejected and its bytes preserved verbatim', () => {
    const root = scratch('graph-truncated-');
    const path = join(root, 'task-graph.json');
    const full = JSON.stringify(graphSnapshot({ refs: { 'a:t1': ref('a', 't1') } }));
    const torn = full.slice(0, Math.floor(full.length / 2));
    writeFileSync(path, torn, 'utf-8');

    const registry = makeRegistry(path);
    try {
      expect(registry.getAllRefs()).toEqual([]);
      expect(readFileSync(`${path}.unrecognized`, 'utf-8')).toBe(torn);
    } finally {
      registry.dispose();
    }
  });

  test('refs for a vanished session are reaped at hydration while live refs survive', () => {
    const root = scratch('graph-reap-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: {
        'live:t1': ref('live', 't1'),
        'live:t2': ref('live', 't2'),
        // Older than the ownerless grace floor, so "this session is gone" is
        // allowed to act on it. A ref this new would be protected, see the
        // grace-floor tests below.
        'gone:t9': ref('gone', 't9', PAST_GRACE),
      },
      edges: [
        { fromRef: { sessionId: 'live', taskId: 't1' }, toRef: { sessionId: 'gone', taskId: 't9' }, linkedAt: NOW },
        { fromRef: { sessionId: 'live', taskId: 't2' }, toRef: { sessionId: 'live', taskId: 't1' }, linkedAt: NOW },
      ],
      handoffs: [{
        handoffId: 'h-gone',
        taskRef: { sessionId: 'gone', taskId: 't9' },
        fromSessionId: 'gone',
        toSessionId: 'live',
        initiatedAt: PAST_GRACE,
        acknowledged: false,
      }],
    }));
    const info = spyInfo();

    const registry = makeRegistry(path, { sessionExists: (id) => id === 'live' });
    try {
      expect(registry.getAllRefs().map((entry) => `${entry.sessionId}:${entry.taskId}`).sort()).toEqual(['live:t1', 'live:t2']);
      expect(registry.getHandoffs()).toEqual([]);

      const summary = registry.lastReapSummary();
      expect(summary.refsMissingSession).toBe(1);
      expect(summary.edgesDangling).toBe(1);
      expect(summary.handoffsOrphaned).toBe(1);
      expect(summary.total).toBe(3);

      // The surviving edge is intact.
      expect(registry.getDependencies('live', 't2').map((entry) => entry.taskId)).toEqual(['t1']);

      const disclosed = dataFor(info, 'reclaimed stale task graph records');
      expect(disclosed).toBeDefined();
      expect(disclosed?.['refsMissingSession']).toBe(1);
      expect(disclosed?.['edgesDangling']).toBe(1);
      expect(disclosed?.['handoffsOrphaned']).toBe(1);
      expect(disclosed?.['phase']).toBe('hydration');
    } finally {
      registry.dispose();
    }
  });

  test('a RECENT ref whose session is unknown survives — a transient false answer is not data loss', () => {
    // The case the grace floor exists for: a sweep lands during startup, before
    // the session broker has registered the session that owns these refs, and
    // sessionExists truthfully answers "no" for a session that is about to
    // exist. Without a floor that momentary answer deletes the user's graph.
    const root = scratch('graph-grace-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: {
        'starting-up:t1': ref('starting-up', 't1', NOW - 60_000), // one minute old
        'stale-gone:t2': ref('stale-gone', 't2', PAST_GRACE),
      },
    }));

    const registry = makeRegistry(path, { sessionExists: () => false });
    try {
      // The young one is kept even though its owner reports as absent...
      expect(registry.getAllRefs().map((entry) => entry.sessionId)).toEqual(['starting-up']);
      // ...and only the one past the floor was taken.
      expect(registry.lastReapSummary().refsMissingSession).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  test('an in-flight handoff to a session that has not registered yet is not orphaned', () => {
    const root = scratch('graph-handoff-grace-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: { 'live:t1': ref('live', 't1') },
      handoffs: [{
        handoffId: 'h-inflight',
        taskRef: { sessionId: 'live', taskId: 't1' },
        fromSessionId: 'live',
        toSessionId: 'not-yet-registered',
        initiatedAt: NOW - 30_000,
        acknowledged: false,
      }],
    }));

    const registry = makeRegistry(path, { sessionExists: (id) => id === 'live' });
    try {
      expect(registry.getHandoffs().map((entry) => entry.handoffId)).toEqual(['h-inflight']);
      expect(registry.lastReapSummary().handoffsOrphaned).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  test('legacy "local" refs are NEVER owner-reaped, however dead that name looks', () => {
    // Nobody can say which real session wrote these, so judging them by
    // owner-existence would delete the entire pre-binding store on the first
    // sweep after upgrading. Age is the only rule allowed to touch them.
    const root = scratch('graph-legacy-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: {
        'local:t1': ref('local', 't1', PAST_GRACE),
        'local:t2': ref('local', 't2', NOW),
      },
    }));

    const registry = makeRegistry(path, { sessionExists: () => false });
    try {
      expect(registry.getAllRefs().map((entry) => entry.taskId).sort()).toEqual(['t1', 't2']);
      expect(registry.lastReapSummary().refsMissingSession).toBe(0);
      expect(registry.lastReapSummary().total).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  test('legacy "local" refs DO age out, and their drain-down is disclosed separately', () => {
    const root = scratch('graph-legacy-age-');
    const path = join(root, 'task-graph.json');
    const beyondTtl = NOW - 40 * 24 * 60 * 60 * 1000;
    writeGraph(path, graphSnapshot({
      refs: {
        'local:old': ref('local', 'old', beyondTtl),
        'local:new': ref('local', 'new', NOW),
        'realsession:old': ref('realsession', 'old', beyondTtl),
      },
    }));
    const info = spyInfo();

    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      expect(registry.getAllRefs().map((entry) => `${entry.sessionId}:${entry.taskId}`).sort())
        .toEqual(['local:new']);

      const summary = registry.lastReapSummary();
      // The legacy record is counted apart from the ordinary expiry, so the
      // migration draining down is visible rather than blended into routine TTL.
      expect(summary.refsLegacyNamespaceExpired).toBe(1);
      expect(summary.refsExpired).toBe(1);

      const disclosed = dataFor(info, 'reclaimed stale task graph records');
      expect(disclosed?.['refsLegacyNamespaceExpired']).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  test('without a sessionExists predicate, nothing is owner-reaped at all', () => {
    const root = scratch('graph-nopredicate-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: { 'whoever:t1': ref('whoever', 't1', PAST_GRACE) },
    }));

    const registry = makeRegistry(path);
    try {
      expect(registry.getAllRefs()).toHaveLength(1);
      expect(registry.lastReapSummary().refsMissingSession).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  test('reaping twice is a no-op the second time, and the reaped file rehydrates clean', () => {
    const root = scratch('graph-idempotent-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: { 'live:t1': ref('live', 't1'), 'gone:t9': ref('gone', 't9', PAST_GRACE) },
    }));

    const first = makeRegistry(path, { sessionExists: (id) => id === 'live' });
    try {
      expect(first.lastReapSummary().total).toBe(1);
      // Second pass over the already-reaped in-memory graph reclaims nothing.
      expect(first.reap().total).toBe(0);
      first.flush();
    } finally {
      first.dispose();
    }

    const info = spyInfo();
    const second = makeRegistry(path, { sessionExists: (id) => id === 'live' });
    try {
      expect(second.lastReapSummary().total).toBe(0);
      expect(second.getAllRefs()).toHaveLength(1);
      // Nothing was reclaimed, so nothing is disclosed.
      expect(messages(info).filter((message) => message.includes('reclaimed stale task graph records'))).toEqual([]);
    } finally {
      second.dispose();
    }
  });

  test('refs past the age TTL are reaped even when their session still exists', () => {
    const root = scratch('graph-ttl-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: {
        'live:fresh': ref('live', 'fresh', NOW - 5 * DAY_MS),
        'live:stale': ref('live', 'stale', NOW - 31 * DAY_MS),
      },
    }));

    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      expect(registry.getAllRefs().map((entry) => entry.taskId)).toEqual(['fresh']);
      expect(registry.lastReapSummary().refsExpired).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  test('an acknowledged handoff is retired once it has aged out, and a fresh one survives', () => {
    const root = scratch('graph-handoff-');
    const path = join(root, 'task-graph.json');
    writeGraph(path, graphSnapshot({
      refs: { 'live:t1': ref('live', 't1'), 'live:t2': ref('live', 't2') },
      handoffs: [
        {
          handoffId: 'h-old',
          taskRef: { sessionId: 'live', taskId: 't1' },
          fromSessionId: 'live',
          toSessionId: 'live',
          initiatedAt: NOW - 3 * DAY_MS,
          acknowledged: true,
          acknowledgedAt: NOW - 2 * DAY_MS,
        },
        {
          handoffId: 'h-new',
          taskRef: { sessionId: 'live', taskId: 't2' },
          fromSessionId: 'live',
          toSessionId: 'live',
          initiatedAt: NOW - 60_000,
          acknowledged: true,
          acknowledgedAt: NOW - 30_000,
        },
      ],
    }));

    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      expect(registry.getHandoffs().map((handoff) => handoff.handoffId)).toEqual(['h-new']);
      expect(registry.lastReapSummary().handoffsRetired).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  test('a graph written by a newer runtime is not interpreted and is preserved aside', () => {
    const root = scratch('graph-future-');
    const path = join(root, 'task-graph.json');
    writeFileSync(path, JSON.stringify({ ...graphSnapshot({ refs: { 'live:t1': ref('live', 't1') } }), version: 99 }), 'utf-8');

    const registry = makeRegistry(path);
    try {
      expect(registry.getAllRefs()).toEqual([]);
      const preserved = JSON.parse(readFileSync(`${path}.unrecognized`, 'utf-8')) as { version: number };
      expect(preserved.version).toBe(99);
    } finally {
      registry.dispose();
    }
  });

  test('an OLDER envelope version still hydrates (version equality no longer discards everything)', () => {
    const root = scratch('graph-older-');
    const path = join(root, 'task-graph.json');
    writeFileSync(path, JSON.stringify({ ...graphSnapshot({ refs: { 'live:t1': ref('live', 't1') } }), version: 0 }), 'utf-8');

    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      expect(registry.getAllRefs().map((entry) => entry.taskId)).toEqual(['t1']);
      expect(existsSync(`${path}.unrecognized`)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  test('records whose persisted shape does not validate are dropped and counted', () => {
    const root = scratch('graph-malformed-');
    const path = join(root, 'task-graph.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      snapshotAt: NOW,
      refs: {
        'live:t1': ref('live', 't1'),
        'bad:1': { sessionId: 'bad', taskId: 'x', title: 'x', status: 'not-a-status', createdAt: NOW, updatedAt: NOW },
        'bad:2': { sessionId: 'bad', title: 'missing task id', status: 'running', createdAt: NOW, updatedAt: NOW },
      },
      edges: [],
      handoffs: [{
        handoffId: 'h',
        taskRef: { sessionId: 'live' },
        fromSessionId: 'live',
        toSessionId: 'live',
        initiatedAt: NOW,
        acknowledged: false,
      }],
    }), 'utf-8');

    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      expect(registry.getAllRefs().map((entry) => entry.taskId)).toEqual(['t1']);
      expect(registry.lastReapSummary().refsMalformed).toBe(2);
      expect(registry.lastReapSummary().handoffsMalformed).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  test('the flush path leaves no temp file behind and the written graph reloads', () => {
    const root = scratch('graph-atomic-');
    const path = join(root, 'task-graph.json');
    const registry = makeRegistry(path, { sessionExists: () => true });
    try {
      registry.linkTask(ref('live', 't1'));
      registry.flush();
      expect(readdirSync(root).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      const written = JSON.parse(readFileSync(path, 'utf-8')) as SessionTaskGraphSnapshot;
      expect(written.refs['live:t1']?.taskId).toBe('t1');
    } finally {
      registry.dispose();
    }
  });
});

// ── 2. Orchestration workstream snapshots ─────────────────────────────────────

function makeItem(state: WorkItem['state'], id = 'item-1'): WorkItem {
  return {
    id,
    title: id,
    task: 'do the thing',
    dependsOn: [],
    currentPhaseId: null,
    state,
    allAgentIds: [],
    visits: new Map<string, number>(),
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: NOW,
  };
}

function makeWorkstream(id: string, state: WorkItem['state']): Workstream {
  return {
    id,
    title: `workstream ${id}`,
    schemaVersion: 1,
    phases: [],
    items: [makeItem(state)],
    createdAt: NOW,
  };
}

function orchestrationDir(root: string): string {
  return join(root, '.goodvibes', 'orchestration');
}

/** Write a snapshot envelope directly, with an explicit `writtenAt` age. */
function writeSnapshotFile(root: string, id: string, itemStates: readonly WorkItem['state'][], writtenAt: number): string {
  const dir = orchestrationDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    writtenAt,
    workstream: {
      id,
      title: id,
      schemaVersion: 1,
      phases: [],
      createdAt: writtenAt,
      items: itemStates.map((state, index) => ({ ...makeItem(state, `${id}-i${index}`), visits: {} })),
    },
    completedResults: [],
  }), 'utf-8');
  return path;
}

describe('orchestration snapshot housekeeping', () => {
  test('a zero-byte snapshot is rejected and quarantined rather than served', () => {
    const root = scratch('ws-zero-');
    const dir = orchestrationDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ws-a.json'), '', 'utf-8');

    expect(loadWorkstreamSnapshot(root, 'ws-a')).toBeNull();
    expect(existsSync(join(dir, 'ws-a.json.unrecognized'))).toBe(true);
    expect(existsSync(join(dir, 'ws-a.json'))).toBe(false);
  });

  test('a truncated snapshot is rejected and quarantined rather than served', () => {
    const root = scratch('ws-truncated-');
    const dir = orchestrationDir(root);
    mkdirSync(dir, { recursive: true });
    const full = JSON.stringify({
      schemaVersion: 1,
      writtenAt: NOW,
      workstream: { ...makeWorkstream('ws-a', 'passed'), items: [{ ...makeItem('passed'), visits: {} }] },
      completedResults: [],
    });
    writeFileSync(join(dir, 'ws-a.json'), full.slice(0, Math.floor(full.length / 2)), 'utf-8');

    expect(loadWorkstreamSnapshot(root, 'ws-a')).toBeNull();
    expect(existsSync(join(dir, 'ws-a.json.unrecognized'))).toBe(true);
  });

  test('writeWorkstreamSnapshot is atomic: no temp file survives and the snapshot reloads', () => {
    const root = scratch('ws-atomic-');
    writeWorkstreamSnapshot(root, makeWorkstream('ws-atomic', 'passed'), []);

    expect(readdirSync(orchestrationDir(root)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(loadWorkstreamSnapshot(root, 'ws-atomic')?.workstream.id).toBe('ws-atomic');
  });

  test('completed snapshots age out while a running workstream survives', () => {
    const root = scratch('ws-ttl-');
    writeSnapshotFile(root, 'ws-old-done', ['passed'], NOW - 20 * DAY_MS);
    writeSnapshotFile(root, 'ws-recent-done', ['passed', 'failed'], NOW - 2 * DAY_MS);
    writeSnapshotFile(root, 'ws-running', ['pending'], NOW - 40 * DAY_MS);
    const info = spyInfo();

    const summary = reapOrchestrationSnapshots(root, { now: NOW });
    expect(summary.terminalExpired).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.bytesReclaimed).toBeGreaterThan(0);

    expect(readdirSync(orchestrationDir(root)).sort()).toEqual(['ws-recent-done.json', 'ws-running.json']);
    expect(dataFor(info, 'reclaimed snapshot files')?.['terminalExpired']).toBe(1);

    // Idempotent: the second pass reclaims nothing and discloses nothing.
    expect(reapOrchestrationSnapshots(root, { now: NOW }).total).toBe(0);
    expect(messages(info).filter((message) => message.includes('reclaimed snapshot files'))).toHaveLength(1);
  });

  test('a still-running workstream is exempt even when the injected predicate is the only signal', () => {
    const root = scratch('ws-running-');
    // Terminal on disk, but the engine says it is live (e.g. items were requeued).
    writeSnapshotFile(root, 'ws-live', ['passed'], NOW - 90 * DAY_MS);

    const summary = reapOrchestrationSnapshots(root, { now: NOW, isRunning: (id) => id === 'ws-live' });
    expect(summary.total).toBe(0);
    expect(existsSync(join(orchestrationDir(root), 'ws-live.json'))).toBe(true);
  });

  test('completed snapshots over the count cap are trimmed oldest-first', () => {
    const root = scratch('ws-cap-');
    for (let index = 0; index < 60; index++) {
      writeSnapshotFile(root, `ws-${String(index).padStart(3, '0')}`, ['passed'], NOW - index * 1000);
    }

    const summary = reapOrchestrationSnapshots(root, { now: NOW });
    expect(summary.terminalOverCap).toBe(10);
    expect(readdirSync(orchestrationDir(root))).toHaveLength(50);
    // The oldest (largest index, earliest writtenAt) went first.
    expect(existsSync(join(orchestrationDir(root), 'ws-059.json'))).toBe(false);
    expect(existsSync(join(orchestrationDir(root), 'ws-000.json'))).toBe(true);
  });

  test('.unrecognized quarantine files age out; recent ones are kept for forensics', () => {
    const root = scratch('ws-quarantine-');
    const dir = orchestrationDir(root);
    mkdirSync(dir, { recursive: true });
    const oldPath = join(dir, 'ws-old.json.unrecognized');
    const newPath = join(dir, 'ws-new.json.unrecognized');
    writeFileSync(oldPath, '{ torn', 'utf-8');
    writeFileSync(newPath, '{ torn', 'utf-8');
    const oldSeconds = (NOW - 45 * DAY_MS) / 1000;
    utimesSync(oldPath, oldSeconds, oldSeconds);
    const newSeconds = (NOW - DAY_MS) / 1000;
    utimesSync(newPath, newSeconds, newSeconds);

    const summary = reapOrchestrationSnapshots(root, { now: NOW });
    expect(summary.quarantineExpired).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  test('temp files left by an interrupted write are reclaimed once they are stale', () => {
    const root = scratch('ws-temp-');
    const dir = orchestrationDir(root);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'ws-a.json.999.1.tmp');
    writeFileSync(stale, '{"partial":', 'utf-8');
    const staleSeconds = (NOW - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, staleSeconds, staleSeconds);

    const summary = reapOrchestrationSnapshots(root, { now: NOW });
    expect(summary.staleTempRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  test('listSnapshotWorkstreamIds reaps before it enumerates, so no reclaimed id is handed back', () => {
    const root = scratch('ws-list-');
    writeSnapshotFile(root, 'ws-old-done', ['passed'], NOW - 30 * DAY_MS);
    writeSnapshotFile(root, 'ws-running', ['in-phase'], NOW - 30 * DAY_MS);

    expect(listSnapshotWorkstreamIds(root, { now: NOW })).toEqual(['ws-running']);
  });

  test('nothing is disclosed when a housekeeping pass reclaims nothing', () => {
    const root = scratch('ws-quiet-');
    writeSnapshotFile(root, 'ws-fresh', ['passed'], NOW - 1000);
    const info = spyInfo();

    expect(reapOrchestrationSnapshots(root, { now: NOW }).total).toBe(0);
    expect(messages(info).filter((message) => message.includes('reclaimed snapshot files'))).toEqual([]);
  });
});

// ── 3. Managed worktree register ──────────────────────────────────────────────

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
}

function makeRepo(prefix: string): string {
  const root = scratch(prefix);
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'test']);
  writeFileSync(join(root, 'README.md'), '# test\n', 'utf-8');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'init', '--no-verify']);
  return root;
}

function storePath(root: string): string {
  return join(root, '.goodvibes', 'worktrees.json');
}

function writeRegister(root: string, records: Record<string, unknown>, version = 1): void {
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  writeFileSync(storePath(root), JSON.stringify({ version, records }, null, 2), 'utf-8');
}

function readRegisterRecords(root: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(storePath(root), 'utf-8')) as { records: Record<string, unknown> };
  return parsed.records;
}

function preservedFiles(root: string): string[] {
  return readdirSync(join(root, '.goodvibes')).filter((entry) => entry.includes('worktrees.json.unreadable'));
}

describe('worktree register housekeeping', () => {
  test('a corrupt register is preserved aside and disclosed instead of silently emptied', async () => {
    const root = makeRepo('wt-corrupt-');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    const original = '{"version":1,"records":{"/gone": {"path": "/gone", "state": "kept"';
    writeFileSync(storePath(root), original, 'utf-8');
    const warn = spyWarn();

    await new WorktreeRegistry(root).list();

    const preserved = preservedFiles(root);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(root, '.goodvibes', preserved[0]!), 'utf-8')).toBe(original);
    expect(messages(warn).some((message) => message.includes('preserved aside'))).toBe(true);
  });

  test('a zero-byte register is rejected rather than served as an empty register', async () => {
    const root = makeRepo('wt-zero-');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(storePath(root), '', 'utf-8');

    await new WorktreeRegistry(root).list();

    expect(preservedFiles(root)).toHaveLength(1);
  });

  test('a missing register is normal: nothing preserved aside, nothing warned', async () => {
    const root = makeRepo('wt-missing-');
    const warn = spyWarn();

    await new WorktreeRegistry(root).list();

    expect(preservedFiles(root)).toEqual([]);
    expect(messages(warn).some((message) => message.includes('worktree registry'))).toBe(false);
  });

  test('records for vanished worktrees are reaped WITH disclosure, kept tombstones survive', async () => {
    const root = makeRepo('wt-reap-');
    writeRegister(root, {
      '/vanished/a': { path: '/vanished/a', kind: 'agent', state: 'active', updatedAt: Date.now() },
      '/vanished/b': { path: '/vanished/b', kind: 'agent', state: 'pending-cleanup', updatedAt: Date.now() },
      '/vanished/kept': { path: '/vanished/kept', kind: 'agent', state: 'kept', updatedAt: Date.now() },
    });
    const info = spyInfo();

    const registry = new WorktreeRegistry(root);
    await registry.list();

    const stored = readRegisterRecords(root);
    expect(Object.keys(stored)).toContain('/vanished/kept');
    expect(Object.keys(stored)).not.toContain('/vanished/a');
    expect(Object.keys(stored)).not.toContain('/vanished/b');

    const disclosed = dataFor(info, 'reclaimed stale register records');
    expect(disclosed?.['vanished']).toBe(2);
    expect(disclosed?.['tombstonesExpired']).toBe(0);

    // Idempotent: a second list reclaims nothing and discloses nothing more.
    await registry.list();
    expect(messages(info).filter((message) => message.includes('reclaimed stale register records'))).toHaveLength(1);
  });

  test('kept tombstones past the age TTL are reaped; a live kept worktree is never aged out', async () => {
    const root = makeRepo('wt-tombstone-');
    writeRegister(root, {
      '/vanished/ancient': { path: '/vanished/ancient', kind: 'agent', state: 'kept', updatedAt: Date.now() - 200 * DAY_MS },
      '/vanished/recent': { path: '/vanished/recent', kind: 'agent', state: 'kept', updatedAt: Date.now() - 3 * DAY_MS },
      // The repo root itself IS a live worktree; a stale timestamp must not expire it.
      [root]: { path: root, kind: 'manual', state: 'kept', updatedAt: Date.now() - 500 * DAY_MS },
    });
    const info = spyInfo();

    await new WorktreeRegistry(root).list();

    expect(Object.keys(readRegisterRecords(root)).sort()).toEqual([root, '/vanished/recent'].sort());
    expect(dataFor(info, 'reclaimed stale register records')?.['tombstonesExpired']).toBe(1);
  });

  test('register records whose shape does not validate are dropped without discarding the good ones', async () => {
    const root = makeRepo('wt-malformed-');
    writeRegister(root, {
      '/vanished/kept': { path: '/vanished/kept', kind: 'agent', state: 'kept', updatedAt: Date.now() },
      '/vanished/bad': { path: '/vanished/bad', kind: 'agent', state: 'not-a-state', updatedAt: Date.now() },
      '/vanished/bad2': { kind: 'agent', state: 'kept', updatedAt: Date.now() },
    });

    await new WorktreeRegistry(root).list();

    // The repo root is itself a live worktree, so it is (re)recorded; the two
    // records that failed validation are gone and the good tombstone survives.
    const keys = Object.keys(readRegisterRecords(root));
    expect(keys).toContain('/vanished/kept');
    expect(keys).not.toContain('/vanished/bad');
    expect(keys).not.toContain('/vanished/bad2');
    expect(preservedFiles(root)).toEqual([]);
  });

  test('a register written by a newer runtime is preserved aside, never overwritten in place', async () => {
    const root = makeRepo('wt-future-');
    writeRegister(root, { '/vanished/kept': { path: '/vanished/kept', kind: 'agent', state: 'kept', updatedAt: Date.now() } }, 99);

    await new WorktreeRegistry(root).list();

    const preserved = preservedFiles(root);
    expect(preserved).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(join(root, '.goodvibes', preserved[0]!), 'utf-8')) as { version: number };
    expect(parsed.version).toBe(99);
  });

  test('preserved-aside registers age out, and writes leave no temp file behind', async () => {
    const root = makeRepo('wt-preserved-ttl-');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    const stale = `${storePath(root)}.unreadable-1-1`;
    writeFileSync(stale, 'torn', 'utf-8');
    const staleSeconds = (Date.now() - 60 * DAY_MS) / 1000;
    utimesSync(stale, staleSeconds, staleSeconds);

    await new WorktreeRegistry(root).list();

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(root, '.goodvibes')).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});
