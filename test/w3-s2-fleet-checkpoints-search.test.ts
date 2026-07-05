/**
 * w3-s2-fleet-checkpoints-search.test.ts
 *
 * W3-S2 bootDaemon parity proof: fleet.snapshot / fleet.list / checkpoints.* /
 * sessions.search, each proven over a REAL live daemon (bootDaemon, port 0,
 * isolated home) via the generic gateway-method invoke endpoint
 * `POST /api/control-plane/methods/{methodId}/invoke` — mirrors the R1
 * pattern in test/boot-daemon-factory.test.ts (real HTTP, honest
 * failure/validation shape, no mocked daemon internals).
 *
 * NOTE on fleet.* coverage: proving "a live process appears in fleet.snapshot"
 * end-to-end would need a real agent/watcher/schedule registered through the
 * daemon's HTTP surface. Every one of those sources is feature-flag-gated
 * (e.g. `watcher-framework`, default disabled) or requires a real provider,
 * and there is no HTTP route to toggle a feature flag on a black-box
 * bootDaemon instance. This suite therefore proves fleet.snapshot/fleet.list
 * over the real (here: empty) ProcessRegistry — correct shape, filtering,
 * pagination, and honest 400s — which is the full surface this brief owns;
 * ProcessRegistry's own aggregation from live sources is pre-existing,
 * already-tested machinery from an earlier wave (W2.1), not part of this
 * verb-registration brief.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'w3-s2-test-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

interface InvokeResult {
  readonly status: number;
  readonly json: any;
}

/**
 * Call a gateway method through the generic invoke endpoint (real HTTP).
 *
 * Params ride in the envelope's `body` — for a handler verb (no http
 * binding) that is the channel S1's invoke-layer input gate
 * (invoke-input-validation.ts) validates against the typed inputSchema, so
 * these calls exercise both the gate and the handler. The `query` channel
 * is a fallback the handlers also merge in (body wins); one fleet.list test
 * below covers it explicitly.
 */
async function invokeVerb(
  methodId: string,
  input: { readonly query?: unknown; readonly body?: unknown } = {},
): Promise<InvokeResult> {
  const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ query: input.query, body: input.body ?? {} }),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'w3s2-home-'));
  work = mkdtempSync(join(tmpdir(), 'w3s2-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('W3-S2 — fleet.snapshot / fleet.list', () => {
  test('fleet.snapshot returns a well-shaped, empty-or-sparse fleet before any process exists', async () => {
    const { status, json } = await invokeVerb('fleet.snapshot');
    expect(status).toBe(200);
    expect(typeof json.capturedAt).toBe('number');
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(json.truncated).toBe(false);
    expect(json.totalCount).toBe(json.nodes.length);
  });

  test('fleet.list over an empty fleet returns a well-shaped empty page (params via the query fallback channel)', async () => {
    // Deliberately uses the envelope's `query` channel (body {}): handlers
    // merge query in as a fallback (body wins), so optional filters may ride
    // either channel. body {} passes S1's typed-schema gate because
    // FLEET_LIST_INPUT_SCHEMA has no required fields.
    const { status, json } = await invokeVerb('fleet.list', { query: { limit: 10 } });
    expect(status).toBe(200);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeUndefined();
    expect(typeof json.capturedAt).toBe('number');
  });

  test('fleet.list rejects an unknown kind with an honest 400 (not a silent empty result)', async () => {
    const { status, json } = await invokeVerb('fleet.list', { body: { kinds: ['not-a-real-kind'] } });
    expect(status).toBe(400);
    expect(typeof json.error).toBe('string');
  });

  test('fleet.list rejects an unknown state with an honest 400', async () => {
    const { status, json } = await invokeVerb('fleet.list', { body: { states: ['not-a-real-state'] } });
    expect(status).toBe(400);
    expect(typeof json.error).toBe('string');
  });

  test('fleet.list rejects a garbage cursor with an honest 400', async () => {
    const { status, json } = await invokeVerb('fleet.list', { body: { cursor: 'not-a-real-cursor!!' } });
    expect(status).toBe(400);
    expect(typeof json.error).toBe('string');
  });

  test('fleet.list rejects an invalid limit with an honest 400', async () => {
    const { status } = await invokeVerb('fleet.list', { body: { limit: -5 } });
    expect(status).toBe(400);
  });
});

describe('W3-S2 — checkpoints.list / create / diff / restore', () => {
  // A fresh bootDaemon `work` tmpdir is EMPTY, whose git tree hash equals the
  // canonical empty-tree constant WorkspaceCheckpointManager also uses as the
  // "no parent yet" sentinel (manager.ts:349-357) — so the very first
  // checkpoint on a truly empty workspace is itself a no-op (tree unchanged).
  // Seed a real file (and change it before each subsequent create) so every
  // create() in this suite produces a genuine, non-noop checkpoint.
  let seedCounter = 0;
  function touchWorkspaceFile(): void {
    seedCounter += 1;
    writeFileSync(join(work, `w3s2-checkpoint-seed-${seedCounter}.txt`), `seed ${seedCounter}\n`);
  }

  test('checkpoints.create then checkpoints.list returns the created checkpoint', async () => {
    touchWorkspaceFile();
    const created = await invokeVerb('checkpoints.create', { body: { kind: 'manual', label: 'w3s2 test checkpoint' } });
    expect(created.status).toBe(200);
    expect(created.json.noop).toBe(false);
    expect(created.json.checkpoint).not.toBeNull();
    expect(created.json.checkpoint.kind).toBe('manual');
    expect(created.json.checkpoint.label).toBe('w3s2 test checkpoint');
    const checkpointId: string = created.json.checkpoint.id;

    const list = await invokeVerb('checkpoints.list');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json.checkpoints)).toBe(true);
    expect(list.json.checkpoints.some((c: any) => c.id === checkpointId)).toBe(true);
  });

  test('checkpoints.create is an honest no-op (not an error, not a fabricated record) when the tree is unchanged', async () => {
    touchWorkspaceFile();
    const first = await invokeVerb('checkpoints.create', { body: { kind: 'manual', label: 'noop base' } });
    expect(first.status).toBe(200);
    expect(first.json.noop).toBe(false);

    // Immediately create again with NO workspace change in between.
    const second = await invokeVerb('checkpoints.create', { body: { kind: 'manual', label: 'noop repeat' } });
    expect(second.status).toBe(200);
    expect(second.json.noop).toBe(true);
    expect(second.json.checkpoint).toBeNull();
  });

  test('checkpoints.create rejects a missing/invalid kind with an honest 400', async () => {
    const missing = await invokeVerb('checkpoints.create', { body: {} });
    expect(missing.status).toBe(400);

    const invalid = await invokeVerb('checkpoints.create', { body: { kind: 'not-a-real-kind' } });
    expect(invalid.status).toBe(400);
  });

  test('checkpoints.diff against the live working tree returns a diff shape', async () => {
    touchWorkspaceFile();
    const created = await invokeVerb('checkpoints.create', { body: { kind: 'manual', label: 'diff base' } });
    expect(created.status).toBe(200);
    expect(created.json.noop).toBe(false);
    const checkpointId: string = created.json.checkpoint.id;

    // Modify an EXISTING already-checkpointed (tracked) file rather than
    // creating a brand-new untracked one: a plain `git diff <commit>`
    // (WorkspaceCheckpointManager.diff's single-arg "against WORKING" path,
    // manager.ts:420-437) does not surface untracked files, only tracked
    // modifications — so the diff must touch a file the side-git index
    // already knows about to show up in `files`.
    writeFileSync(join(work, 'w3s2-checkpoint-seed-1.txt'), 'modified after diff-base checkpoint\n');
    const diff = await invokeVerb('checkpoints.diff', { body: { a: checkpointId } });
    expect(diff.status).toBe(200);
    expect(diff.json.diff.from).toBe(checkpointId);
    expect(diff.json.diff.to).toBe('WORKING');
    expect(Array.isArray(diff.json.diff.files)).toBe(true);
    expect(diff.json.diff.files).toContain('w3s2-checkpoint-seed-1.txt');
    expect(typeof diff.json.diff.unifiedDiff).toBe('string');
  });

  test('checkpoints.diff of an unknown id is an honest 404, not a silent empty diff', async () => {
    const { status, json } = await invokeVerb('checkpoints.diff', { body: { a: 'wcp_does_not_exist' } });
    expect(status).toBe(404);
    expect(typeof json.error).toBe('string');
    expect(json.code).toBe('NOT_FOUND');
  });

  test('checkpoints.diff requires the "a" field with an honest 400', async () => {
    const { status } = await invokeVerb('checkpoints.diff', { body: {} });
    expect(status).toBe(400);
  });

  test('checkpoints.restore of an unknown id is an honest 404, not a silent no-op', async () => {
    const { status, json } = await invokeVerb('checkpoints.restore', { body: { id: 'wcp_does_not_exist' } });
    expect(status).toBe(404);
    expect(typeof json.error).toBe('string');
    expect(json.code).toBe('NOT_FOUND');
  });

  test('checkpoints.restore of a real id executes without a server-side confirm gate', async () => {
    touchWorkspaceFile();
    const created = await invokeVerb('checkpoints.create', { body: { kind: 'manual', label: 'restore target', paths: [] } });
    expect(created.status).toBe(200);
    expect(created.json.noop).toBe(false);
    const checkpointId: string = created.json.checkpoint.id;

    const restored = await invokeVerb('checkpoints.restore', { body: { id: checkpointId, safetyCheckpoint: false } });
    expect(restored.status).toBe(200);
    expect(restored.json.result.checkpointId).toBe(checkpointId);
    expect(restored.json.result.safetyCheckpointId).toBeNull();
  });
});

describe('W3-S2 — sessions.search', () => {
  const searchProject = `w3s2-search-project-${Date.now()}`;

  beforeAll(async () => {
    await fetch(`${daemon.url}/api/sessions/register`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        sessionId: 'w3s2-search-active',
        kind: 'tui',
        project: searchProject,
        title: 'w3s2 active session',
        participant: { surfaceKind: 'tui', surfaceId: 's-active', lastSeenAt: Date.now() },
      }),
    });
    await fetch(`${daemon.url}/api/sessions/register`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        sessionId: 'w3s2-search-closed',
        kind: 'tui',
        project: searchProject,
        title: 'w3s2 closed session',
        participant: { surfaceKind: 'tui', surfaceId: 's-closed', lastSeenAt: Date.now() },
      }),
    });
    await fetch(`${daemon.url}/api/sessions/w3s2-search-closed/close`, { method: 'POST', headers: auth() });
  });

  test('excludes closed sessions by default', async () => {
    const { status, json } = await invokeVerb('sessions.search', { body: { project: searchProject } });
    expect(status).toBe(200);
    const ids = (json.sessions as any[]).map((s) => s.id);
    expect(ids).toContain('w3s2-search-active');
    expect(ids).not.toContain('w3s2-search-closed');
  });

  test('includeClosed:true includes the closed session with an honest status', async () => {
    const { status, json } = await invokeVerb('sessions.search', { body: { project: searchProject, includeClosed: true } });
    expect(status).toBe(200);
    const closed = (json.sessions as any[]).find((s) => s.id === 'w3s2-search-closed');
    expect(closed).toBeDefined();
    expect(closed.status).toBe('closed');
    const active = (json.sessions as any[]).find((s) => s.id === 'w3s2-search-active');
    expect(active.status).toBe('active');
  });

  test('project filter isolates the search scope', async () => {
    const { json } = await invokeVerb('sessions.search', { body: { project: 'some-other-project-entirely', includeClosed: true } });
    const ids = (json.sessions as any[]).map((s) => s.id);
    expect(ids).not.toContain('w3s2-search-active');
    expect(ids).not.toContain('w3s2-search-closed');
  });

  test('free-text query matches title', async () => {
    const { status, json } = await invokeVerb('sessions.search', { body: { project: searchProject, query: 'active session' } });
    expect(status).toBe(200);
    const ids = (json.sessions as any[]).map((s) => s.id);
    expect(ids).toContain('w3s2-search-active');
  });

  test('cursor pagination returns disjoint pages that union to the full matching set', async () => {
    const page1 = await invokeVerb('sessions.search', { body: { project: searchProject, includeClosed: true, limit: 1 } });
    expect(page1.status).toBe(200);
    expect(page1.json.sessions.length).toBe(1);
    expect(page1.json.hasMore).toBe(true);

    const page2 = await invokeVerb('sessions.search', {
      body: { project: searchProject, includeClosed: true, limit: 1, cursor: page1.json.nextCursor },
    });
    expect(page2.status).toBe(200);

    const unionIds = new Set([...page1.json.sessions, ...page2.json.sessions].map((s: any) => s.id));
    expect(unionIds.has('w3s2-search-active')).toBe(true);
    expect(unionIds.has('w3s2-search-closed')).toBe(true);
    // Pages are disjoint.
    const page1Ids = page1.json.sessions.map((s: any) => s.id);
    const page2Ids = page2.json.sessions.map((s: any) => s.id);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);
  });

  test('an invalid cursor is an honest 400', async () => {
    const { status, json } = await invokeVerb('sessions.search', { body: { cursor: 'not-a-real-cursor!!' } });
    expect(status).toBe(400);
    expect(typeof json.error).toBe('string');
  });

  test('an invalid kind/status/surfaceKind filter is an honest 400', async () => {
    const badKind = await invokeVerb('sessions.search', { body: { kind: 'not-a-real-kind' } });
    expect(badKind.status).toBe(400);
    const badStatus = await invokeVerb('sessions.search', { body: { status: 'not-a-real-status' } });
    expect(badStatus.status).toBe(400);
    const badSurface = await invokeVerb('sessions.search', { body: { surfaceKind: 'not-a-real-surface' } });
    expect(badSurface.status).toBe(400);
  });
});

describe('W3-S2 — access gates', () => {
  test('the generic invoke endpoint requires auth like every other route', async () => {
    const res = await fetch(`${daemon.url}/api/control-plane/methods/fleet.snapshot/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: null }),
    });
    expect(res.status).toBe(401);
  });

  test('an unknown methodId is an honest 404', async () => {
    const { status } = await invokeVerb('fleet.not-a-real-verb');
    expect(status).toBe(404);
  });
});

describe('W3-S2 — event-emission honesty (verified-not-applicable for EVENT_DOMAIN)', () => {
  // The W3-S2 landed scope is read/lifecycle verbs with NO broadcast events:
  // the handlers call the managers and return; ProcessRegistry.subscribe() is
  // an in-registry callback (explicitly not a runtime-bus event contract) and
  // WorkspaceCheckpointManager only SUBSCRIBES to bus events for automatic
  // snapshots. So there is nothing for S1's EVENT_DOMAIN map to tag. This test
  // pins that: if a later wave adds a broadcast event to one of these verbs
  // (e.g. the deferred fleet-update alongside fleet mutators), its descriptor
  // grows an `events` declaration, this test fails, and the author is forced
  // to register the event's domain in EVENT_DOMAIN (gateway-scope-enforcement.ts)
  // at the same time instead of shipping an untagged over-broadcast.
  const W3_S2_METHOD_IDS = [
    'fleet.snapshot',
    'fleet.list',
    'checkpoints.list',
    'checkpoints.create',
    'checkpoints.diff',
    'checkpoints.restore',
    'sessions.search',
  ] as const;

  test('none of the W3-S2 verbs declares a wire event (no EVENT_DOMAIN entries needed)', async () => {
    for (const methodId of W3_S2_METHOD_IDS) {
      const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}`, { headers: auth() });
      expect(res.status).toBe(200);
      const { method } = await res.json() as { method: { id: string; events?: string[] } };
      expect(method.id).toBe(methodId);
      expect(method.events ?? []).toEqual([]);
    }
  });
});
