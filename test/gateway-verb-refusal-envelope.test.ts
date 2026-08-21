/**
 * gateway-verb-refusal-envelope.test.ts
 *
 * Two properties of the method-dispatch refusal path, proven at the level a
 * client actually reads.
 *
 * REFUSALS ARE READ BY SHAPE, NOT BY CLASS. `invokeGatewayMethodCall` used to
 * honor `instanceof GatewayVerbError` and nothing else, so a handler registered
 * by a consuming runtime, which compiles against its own error class, had
 * every refusal collapsed into a blanket 500. The daemon product's confirmation
 * gate refuses with a 403 the caller is meant to answer; as a 500 it read as a
 * daemon fault and no client could act on it.
 *
 * ONE ENVELOPE. Every refusal this dispatcher mints now carries the same
 * structured body the plain-REST surface has always used (`error`, `code`,
 * `category`, `status`, and a `hint` when one applies). `error` stays a string
 * and `code` keeps its spelling, so a client reading only those two is
 * unaffected.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  GatewayVerbError,
  readGatewayVerbRefusal,
} from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { methodDescriptor, objectSchema, STRING_SCHEMA } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../packages/sdk/src/platform/daemon/control-plane.ts';

/** A refusal class a consuming runtime defines for itself, not our class. */
class HandlerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'HandlerError';
    this.code = code;
    this.status = status;
  }
}

const DESCRIPTOR = methodDescriptor({
  id: 'test.refusal.probe',
  title: 'Refusal Probe',
  description: 'A handler-registered verb used to observe how a thrown refusal reaches the wire.',
  category: 'sessions',
  transport: ['ws'],
  scopes: [],
  access: 'public',
  inputSchema: objectSchema({ note: STRING_SCHEMA }, []),
});

function helperWithHandler(handler: () => unknown): DaemonControlPlaneHelper {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register(DESCRIPTOR, handler);
  return new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
}

function invoke(helper: DaemonControlPlaneHelper): Promise<{ status: number; ok: boolean; body: unknown }> {
  return helper.invokeGatewayMethodCall({ authToken: 'irrelevant', methodId: DESCRIPTOR.id, body: {} });
}

describe('readGatewayVerbRefusal — what counts as a refusal', () => {
  test('our own GatewayVerbError, with its field attribution intact', () => {
    const refusal = readGatewayVerbRefusal(new GatewayVerbError('sessionId is required', 'INVALID_ARGUMENT', 400, 'sessionId'));
    expect(refusal).toEqual({ status: 400, code: 'INVALID_ARGUMENT', message: 'sessionId is required', field: 'sessionId' });
  });

  test('a foreign error class carrying the same two facts', () => {
    const refusal = readGatewayVerbRefusal(new HandlerError('This call needs confirmation.', 'REQUIRE_CONFIRM', 403));
    expect(refusal?.status).toBe(403);
    expect(refusal?.code).toBe('REQUIRE_CONFIRM');
    expect(refusal?.message).toBe('This call needs confirmation.');
  });

  test('a plain Error is not a refusal — it stays a server fault', () => {
    expect(readGatewayVerbRefusal(new Error('the disk went away'))).toBeNull();
  });

  test('a status outside the error range, or a missing code, is not a refusal', () => {
    expect(readGatewayVerbRefusal({ status: 200, code: 'OK', message: 'fine' })).toBeNull();
    expect(readGatewayVerbRefusal({ status: 700, code: 'WAT', message: 'no' })).toBeNull();
    expect(readGatewayVerbRefusal({ status: 400, message: 'no code' })).toBeNull();
    expect(readGatewayVerbRefusal({ status: 400, code: '   ' })).toBeNull();
    expect(readGatewayVerbRefusal(null)).toBeNull();
    expect(readGatewayVerbRefusal('nope')).toBeNull();
  });
});

describe('invokeGatewayMethodCall — a foreign refusal reaches the wire as itself', () => {
  test('a daemon-repo-shaped confirmation refusal is a 403 REQUIRE_CONFIRM, not a 500', async () => {
    const helper = helperWithHandler(() => {
      throw new HandlerError('This action needs an explicit confirmation.', 'REQUIRE_CONFIRM', 403);
    });
    const result = await invoke(helper);
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
    const body = result.body as Record<string, unknown>;
    expect(body.code).toBe('REQUIRE_CONFIRM');
    expect(body.error).toBe('This action needs an explicit confirmation.');
    expect(body.status).toBe(403);
    expect(body.category).toBe('authorization');
  });

  test('our own GatewayVerbError keeps its status and code through the same path', async () => {
    const helper = helperWithHandler(() => {
      throw new GatewayVerbError('No such checkpoint.', 'NOT_FOUND', 404);
    });
    const result = await invoke(helper);
    expect(result.status).toBe(404);
    const body = result.body as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
    expect(body.category).toBe('not_found');
  });

  test('a plain Error still collapses to 500, in the same envelope', async () => {
    const helper = helperWithHandler(() => {
      throw new Error('the store is unreachable');
    });
    const result = await invoke(helper);
    expect(result.status).toBe(500);
    const body = result.body as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('the store is unreachable');
    expect(body.status).toBe(500);
    expect(body.category).toBe('service');
  });
});

describe('one envelope — the fields every client already parses keep their names', () => {
  test('the refusal body is a superset of the thin {error, code} shape', async () => {
    const helper = helperWithHandler(() => {
      throw new GatewayVerbError('workspaceRoot must be absolute.', 'INVALID_ARGUMENT', 400, 'workspaceRoot');
    });
    const body = (await invoke(helper)).body as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect(typeof body.code).toBe('string');
    expect(typeof body.category).toBe('string');
    expect(typeof body.status).toBe('number');
    // The structured body must never turn `error` into an object: several
    // clients coerce it with String() and one reads it only when it IS a string.
    expect(typeof body.error).not.toBe('object');
  });
});
