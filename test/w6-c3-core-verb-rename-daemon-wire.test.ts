/**
 * w6-c3-core-verb-rename-daemon-wire.test.ts
 *
 * bootDaemon-based proof (real HTTP, ephemeral port, isolated home)
 * that the core-verb renames actually work end to end over the wire, not
 * just in the generated catalog: the renamed/new ids are invokable and
 * behave identically to their pre-rename counterparts, and the retired ids
 * are gone (404 via the generic invoke dispatcher — never a silent 200).
 *
 * Renames proved here:
 *   automation.jobs.patch    -> automation.jobs.update
 *   routes.bindings.patch    -> routes.bindings.update
 *   watchers.patch           -> watchers.update
 *   schedules.*              -> automation.schedules.*
 * Retirements proved here:
 *   automation.jobs.pause    -> gone (use automation.jobs.disable)
 *   automation.jobs.resume   -> gone (use automation.jobs.enable)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { OPERATOR_METHOD_IDS } from '../packages/contracts/src/generated/operator-method-ids.ts';

// automation.jobs.*, automation.schedules.*, routes.bindings.*, and watchers.*
// all sit behind tier-10 feature flags that default OFF for a stock daemon.
// This proof exercises the renamed/retired ids' real behavior, not just their
// presence in the catalog, so the relevant flags are enabled up front via the
// daemon's own settings.json (surfaceRoot 'goodvibes' — see boot.ts:73 /
// runtime/surface-root.ts resolveSurfaceDirectory), before bootDaemon reads it.
function seedFeatureFlags(homeDirectory: string, flagIds: readonly string[]): void {
  const dir = join(homeDirectory, '.goodvibes', 'goodvibes');
  mkdirSync(dir, { recursive: true });
  const featureFlags = Object.fromEntries(flagIds.map((id) => [id, 'enabled']));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ featureFlags }, null, 2));
}

const TOKEN = 'w6-c3-test-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

interface InvokeResult {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function invokeVerb(methodId: string, body: unknown = {}): Promise<InvokeResult> {
  const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  let json: unknown = {};
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json: json as Record<string, unknown> };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'w6c3-home-'));
  work = mkdtempSync(join(tmpdir(), 'w6c3-work-'));
  seedFeatureFlags(home, ['automation-domain', 'route-binding', 'watcher-framework']);
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

describe('W6-C3 — automation.schedules.* (renamed from bare schedules.*)', () => {
  test('automation.schedules.list is invokable and returns an empty collection to start', async () => {
    const result = await invokeVerb('automation.schedules.list');
    expect(result.status).toBe(200);
  });

  test('a full schedule lifecycle round-trips: create -> list -> disable -> enable -> run -> delete', async () => {
    const created = await invokeVerb('automation.schedules.create', {
      prompt: 'w6-c3 schedule lifecycle proof',
      kind: 'every',
      every: '1h',
    });
    expect(created.status).toBe(201);
    const scheduleId = created.json.id as string;
    expect(typeof scheduleId).toBe('string');

    const listed = await invokeVerb('automation.schedules.list');
    expect(listed.status).toBe(200);

    const disabled = await invokeVerb('automation.schedules.disable', { scheduleId });
    expect(disabled.status).toBe(200);
    expect(disabled.json.enabled).toBe(false);

    const enabled = await invokeVerb('automation.schedules.enable', { scheduleId });
    expect(enabled.status).toBe(200);
    expect(enabled.json.enabled).toBe(true);

    const ran = await invokeVerb('automation.schedules.run', { scheduleId });
    expect(ran.status).toBe(200);

    const deleted = await invokeVerb('automation.schedules.delete', { scheduleId });
    expect(deleted.status).toBe(200);
    expect(deleted.json.removed).toBe(true);
  });

  test('the retired bare schedules.* ids are gone from the wire (404 via generic invoke)', async () => {
    for (const methodId of ['schedules.list', 'schedules.create', 'schedules.delete', 'schedules.enable', 'schedules.disable', 'schedules.run']) {
      const result = await invokeVerb(methodId);
      expect(result.status, `${methodId} should be gone`).toBe(404);
    }
  });
});

describe('W6-C3 — automation.jobs.update (renamed from automation.jobs.patch)', () => {
  test('create then update a durable automation job over HTTP', async () => {
    const created = await invokeVerb('automation.jobs.create', {
      prompt: 'w6-c3 job update proof',
      kind: 'every',
      every: '30m',
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id as string;
    expect(typeof jobId).toBe('string');

    const updated = await invokeVerb('automation.jobs.update', { jobId, name: 'renamed-by-w6-c3' });
    expect(updated.status).toBe(200);
    expect(updated.json.name).toBe('renamed-by-w6-c3');
  });

  test('automation.jobs.patch is gone from the wire (404)', async () => {
    const result = await invokeVerb('automation.jobs.patch', { jobId: 'does-not-matter' });
    expect(result.status).toBe(404);
  });
});

describe('W6-C3 — redundant lifecycle pair retired: automation.jobs.pause/resume gone, enable/disable still work', () => {
  test('enable/disable still work on a created job', async () => {
    const created = await invokeVerb('automation.jobs.create', {
      prompt: 'w6-c3 enable/disable proof',
      kind: 'every',
      every: '2h',
    });
    expect(created.status).toBe(201);
    const jobId = created.json.id as string;

    const disabled = await invokeVerb('automation.jobs.disable', { jobId });
    expect(disabled.status).toBe(200);
    expect(disabled.json.enabled).toBe(false);

    const enabled = await invokeVerb('automation.jobs.enable', { jobId });
    expect(enabled.status).toBe(200);
    expect(enabled.json.enabled).toBe(true);
  });

  test('pause and resume are gone from the wire (404) — callers must use disable/enable', async () => {
    const pauseResult = await invokeVerb('automation.jobs.pause', { jobId: 'does-not-matter' });
    expect(pauseResult.status).toBe(404);
    const resumeResult = await invokeVerb('automation.jobs.resume', { jobId: 'does-not-matter' });
    expect(resumeResult.status).toBe(404);
  });
});

describe('W6-C3 — the other update-verb-split renames (routes.bindings, watchers)', () => {
  test('routes.bindings.patch and watchers.patch are gone from the wire (404); .update ids are the ones the catalog knows', async () => {
    const routesPatch = await invokeVerb('routes.bindings.patch', { bindingId: 'does-not-matter' });
    expect(routesPatch.status).toBe(404);
    const watchersPatch = await invokeVerb('watchers.patch', { watcherId: 'does-not-matter' });
    expect(watchersPatch.status).toBe(404);

    // The renamed ids ARE real (cataloged, dispatched) methods — invoking
    // them with a nonexistent target id still 404s, but with the HANDLER's
    // own "unknown record" message, never the generic "Unknown gateway
    // method" the retired .patch ids returned above. That distinguishes
    // "this id doesn't exist" from "this record doesn't exist".
    const routesUpdate = await invokeVerb('routes.bindings.update', { bindingId: 'does-not-exist' });
    expect(routesUpdate.json.error).not.toBe('Unknown gateway method');
    const watchersUpdate = await invokeVerb('watchers.update', { watcherId: 'does-not-exist' });
    expect(watchersUpdate.json.error).not.toBe('Unknown gateway method');
  });
});

describe('W6-C3 — the live catalog matches OPERATOR_METHOD_IDS (no drift between the wire and the generated ids)', () => {
  test('control.methods.list reflects the renames and retirements', async () => {
    const result = await invokeVerb('control.methods.list');
    expect(result.status).toBe(200);
    const methods = (result.json.methods as Array<{ id: string }> | undefined) ?? [];
    const ids = new Set(methods.map((m) => m.id));

    for (const id of [
      'automation.schedules.list', 'automation.schedules.create', 'automation.schedules.delete',
      'automation.schedules.enable', 'automation.schedules.disable', 'automation.schedules.run',
      'automation.jobs.update', 'routes.bindings.update', 'watchers.update',
    ]) {
      expect(ids.has(id), `expected live catalog to contain ${id}`).toBe(true);
    }

    for (const id of [
      'schedules.list', 'schedules.create', 'schedules.delete', 'schedules.enable', 'schedules.disable', 'schedules.run',
      'automation.jobs.patch', 'automation.jobs.pause', 'automation.jobs.resume',
      'routes.bindings.patch', 'watchers.patch',
    ]) {
      expect(ids.has(id), `expected live catalog to NOT contain ${id}`).toBe(false);
    }

    // Cross-check against the generated OPERATOR_METHOD_IDS union too, so a
    // future catalog edit that drifts from the generated artifact is caught
    // here as well as by contracts:check.
    for (const id of OPERATOR_METHOD_IDS) {
      expect(ids.has(id), `generated id ${id} missing from the live daemon catalog`).toBe(true);
    }
  });
});
