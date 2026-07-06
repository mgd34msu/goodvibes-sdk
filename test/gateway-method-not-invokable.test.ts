/**
 * gateway-method-not-invokable.test.ts
 *
 * Review-fix: codifies the `invokable` flag's real semantics. It is
 * enforced on the generic HTTP/WS method-dispatch path
 * (`validateGatewayInvocation` / `invokeGatewayMethodCall` in
 * ../packages/sdk/src/platform/daemon/control-plane.ts) but `GatewayMethodCatalog`'s
 * own `invoke()` does NOT consult it for a method that has a registered handler —
 * that is intentional: a runtime that has wired up a real in-process handler is
 * authoritative over whether the method actually works, not the descriptor's flag.
 *
 * Covers:
 *  (a) the doc comment on `invokable` (method-catalog-shared.ts) states this
 *      precisely — read there, not re-asserted here as prose.
 *  (b) the HTTP 400 for an `invokable:false` method carries a machine-readable
 *      `code: 'NOT_INVOKABLE'` (SDKErrorCodes), not just a message string.
 *  (c) `GatewayMethodCatalog.invoke()` on a method with `invokable:false` AND no
 *      registered handler throws an honest NOT_INVOKABLE error, not a generic
 *      "no internal handler" one — while a method with `invokable:false` but a REAL
 *      registered handler still runs it.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { isGatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../packages/sdk/src/platform/daemon/control-plane.ts';
import { SDKErrorCodes } from '../packages/errors/src/index.ts';

function blockedDescriptor(id: string) {
  return {
    id,
    title: 'Blocked',
    description: 'A method cataloged as not invokable through generic dispatch.',
    category: 'test',
    source: 'plugin' as const,
    access: 'public' as const,
    transport: ['http' as const],
    scopes: [],
    invokable: false,
  };
}

describe('GatewayMethodCatalog.invoke() and invokable:false', () => {
  test('(c) invokable:false with NO registered handler throws an honest NOT_INVOKABLE error', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    catalog.register(blockedDescriptor('test.blocked.no-handler'));

    let caught: unknown;
    try {
      await catalog.invoke('test.blocked.no-handler', { context: {} });
    } catch (err) {
      caught = err;
    }
    expect(isGatewayVerbError(caught)).toBe(true);
    if (isGatewayVerbError(caught)) {
      expect(caught.code).toBe(SDKErrorCodes.NOT_INVOKABLE);
      expect(caught.status).toBe(400);
    }
  });

  test('(c) invokable:false with a REGISTERED handler still runs it — the flag does not block a real handler', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    let called = false;
    catalog.register(blockedDescriptor('test.blocked.with-handler'), async (input) => {
      called = true;
      return { echoed: input.body };
    });

    const result = await catalog.invoke('test.blocked.with-handler', { body: { hello: 'world' }, context: {} });
    expect(called).toBe(true);
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  test('regression pin: a method with NO invokable override and no handler still throws the plain generic error, not NOT_INVOKABLE', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    catalog.register({
      id: 'test.normal.no-handler',
      title: 'Normal',
      description: 'A normal (invokable, default true) method with no internal handler — e.g. an HTTP-bound method served by a route, not a handler.',
      category: 'test',
      source: 'plugin',
      access: 'public',
      transport: ['http'],
      scopes: [],
    });

    await expect(catalog.invoke('test.normal.no-handler', { context: {} })).rejects.toThrow(
      'Gateway method has no internal handler: test.normal.no-handler',
    );
    let caught: unknown;
    try {
      await catalog.invoke('test.normal.no-handler', { context: {} });
    } catch (err) {
      caught = err;
    }
    expect(isGatewayVerbError(caught)).toBe(false);
  });
});

describe('DaemonControlPlaneHelper.validateGatewayInvocation / invokeGatewayMethodCall — (b) machine-readable NOT_INVOKABLE', () => {
  function helperWithCatalog(catalog: GatewayMethodCatalog): DaemonControlPlaneHelper {
    // validateGatewayInvocation's invokable:false branch (and invokeGatewayMethodCall's
    // early `denied` return before it) never touches any other context field, so a
    // minimal stub carrying only gatewayMethods is sufficient and honest for this path.
    const context = { gatewayMethods: catalog } as unknown as DaemonControlPlaneContext;
    return new DaemonControlPlaneHelper(context);
  }

  test('validateGatewayInvocation returns a 400 body carrying code: NOT_INVOKABLE', () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    const helper = helperWithCatalog(catalog);
    const descriptor = blockedDescriptor('test.blocked.validate');
    const denied = helper.validateGatewayInvocation(descriptor);
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(400);
    expect(denied?.body.code).toBe(SDKErrorCodes.NOT_INVOKABLE);
    expect(denied?.body.code).toBe('NOT_INVOKABLE');
  });

  test('invokeGatewayMethodCall end-to-end: an invokable:false method 400s with code NOT_INVOKABLE before any handler runs', async () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    let handlerCalled = false;
    catalog.register(blockedDescriptor('test.blocked.e2e'), async () => {
      handlerCalled = true;
      return {};
    });
    const helper = helperWithCatalog(catalog);

    const result = await helper.invokeGatewayMethodCall({ authToken: 'irrelevant', methodId: 'test.blocked.e2e' });
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
    expect((result.body as Record<string, unknown>).code).toBe(SDKErrorCodes.NOT_INVOKABLE);
    // The HTTP/WS dispatch gate rejects it before the registered handler is ever
    // reached — the flag DOES block this path, even though the handler exists.
    expect(handlerCalled).toBe(false);
  });
});
