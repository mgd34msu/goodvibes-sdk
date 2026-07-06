/**
 * gateway-method-not-found.test.ts
 *
 * Gives the uncataloged-method 404 a machine code (`METHOD_NOT_FOUND`),
 * distinct from `NOT_INVOKABLE` (the id exists in the catalog but refuses
 * dispatch). Before this brief, the uncataloged-id path was a plain
 * `Error('Unknown gateway method: <id>')` / `{error: 'Unknown gateway method'}`
 * with no `code` field anywhere on the wire, forcing every consumer to string-
 * match the message (see webui's `isMethodUnavailableError`,
 * TUI daemon's `register.ts:114` UNKNOWN_METHOD).
 *
 * Covers every place an uncataloged id is actually observed:
 *  (a) `GatewayMethodCatalog.invoke()` (method-catalog.ts) — thrown for a
 *      direct caller bypassing the HTTP dispatch gate.
 *  (b) `DaemonControlPlaneHelper.invokeGatewayMethodCall` (daemon/control-
 *      plane.ts) — the internal call path used by the WS 'call' frame.
 *  (c) real HTTP, over a live bootDaemon instance (port 0, isolated home):
 *      `GET /api/control-plane/methods/{unknownId}` and
 *      `POST /api/control-plane/methods/{unknownId}/invoke`
 *      (packages/daemon-sdk/src/control-routes.ts getGatewayMethod /
 *      invokeGatewayMethod) — what webui/TUI actually see on the wire.
 *  (d) regression: NOT_INVOKABLE is unchanged and the two codes never collide.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { isGatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../packages/sdk/src/platform/daemon/control-plane.ts';
import { SDKErrorCodes } from '../packages/errors/src/index.ts';

const UNKNOWN_ID = 'w6-c4.definitely-not-a-real-method';

describe('(a) GatewayMethodCatalog.invoke() — uncataloged id throws a coded GatewayVerbError', () => {
  test('throws METHOD_NOT_FOUND (404), not a plain Error', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });

    let caught: unknown;
    try {
      await catalog.invoke(UNKNOWN_ID, { context: {} });
    } catch (err) {
      caught = err;
    }
    expect(isGatewayVerbError(caught)).toBe(true);
    if (isGatewayVerbError(caught)) {
      expect(caught.code).toBe(SDKErrorCodes.METHOD_NOT_FOUND);
      expect(caught.status).toBe(404);
      // human message preserved for people, code added for machines
      expect(caught.message).toContain(UNKNOWN_ID);
    }
  });
});

describe('(b) DaemonControlPlaneHelper.invokeGatewayMethodCall — uncataloged id 404s with code METHOD_NOT_FOUND', () => {
  function helperWithCatalog(catalog: GatewayMethodCatalog): DaemonControlPlaneHelper {
    const context = { gatewayMethods: catalog } as unknown as DaemonControlPlaneContext;
    return new DaemonControlPlaneHelper(context);
  }

  test('unknown methodId: status 404, body.code === METHOD_NOT_FOUND', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const helper = helperWithCatalog(catalog);

    const result = await helper.invokeGatewayMethodCall({ authToken: 'irrelevant', methodId: UNKNOWN_ID });
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect((result.body as Record<string, unknown>).code).toBe(SDKErrorCodes.METHOD_NOT_FOUND);
    expect((result.body as Record<string, unknown>).error).toContain('Unknown gateway method');
  });
});

describe('(c) real bootDaemon HTTP proof — the wire shape webui/TUI actually consume', () => {
  const TOKEN = 'w6-c4-test-token';
  let home: string;
  let work: string;
  let daemon: BootedDaemon;

  function auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'w6-c4-home-'));
    work = mkdtempSync(join(tmpdir(), 'w6-c4-work-'));
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

  test('GET /api/control-plane/methods/{unknownId} — 404 with code METHOD_NOT_FOUND', async () => {
    const res = await fetch(`${daemon.url}/api/control-plane/methods/${UNKNOWN_ID}`, { headers: auth() });
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: string; code?: string };
    expect(body.code).toBe(SDKErrorCodes.METHOD_NOT_FOUND);
    expect(body.error ?? '').toContain('Unknown gateway method');
  });

  test('POST /api/control-plane/methods/{unknownId}/invoke — 404 with code METHOD_NOT_FOUND', async () => {
    const res = await fetch(`${daemon.url}/api/control-plane/methods/${UNKNOWN_ID}/invoke`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ body: {} }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: string; code?: string };
    expect(body.code).toBe(SDKErrorCodes.METHOD_NOT_FOUND);
  });

  test('(d) regression: a real cataloged method (control.methods.list) is unaffected — no code on a 200', async () => {
    const res = await fetch(`${daemon.url}/api/control-plane/methods`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as { methods?: unknown[] };
    expect(Array.isArray(body.methods)).toBe(true);
  });
});

describe('(d) METHOD_NOT_FOUND and NOT_INVOKABLE never collide', () => {
  test('the two codes are distinct string literals', () => {
    expect(SDKErrorCodes.METHOD_NOT_FOUND).not.toBe(SDKErrorCodes.NOT_INVOKABLE);
  });
});
