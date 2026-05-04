import { describe, expect, it } from 'bun:test';
import { z } from 'zod/v4';
import { ContractError } from '../packages/errors/dist/index.js';
import {
  ControlAuthLoginResponseSchema,
  ControlAuthCurrentResponseSchema,
  AccountsSnapshotResponseSchema,
  ControlStatusResponseSchema,
  SerializedEventEnvelopeSchema,
} from '../packages/contracts/dist/index.js';
import { invokeContractRoute, createHttpTransport } from '../packages/transport-http/dist/index.js';

// ---------------------------------------------------------------------------
// Helpers — create a transport that returns a fixed JSON body
// ---------------------------------------------------------------------------

function createJsonFetch(body: unknown, status = 200): typeof fetch {
  return (_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as ReturnType<typeof fetch>;
}

function makeTransport(responseBody: unknown) {
  return createHttpTransport({
    baseUrl: 'http://localhost:3000',
    fetch: createJsonFetch(responseBody),
  });
}

const LOGIN_ROUTE = { method: 'POST', path: '/api/control-plane/invoke/control.auth.login' };

// ---------------------------------------------------------------------------
// 1. Happy path — valid response passes through unchanged
// ---------------------------------------------------------------------------
describe('zod-validation: happy path', () => {
  it('returns valid login response body when schema matches', async () => {
    const validBody = {
      authenticated: true,
      token: 'tok_abc123',
      username: 'alice',
      expiresAt: Date.now() + 3_600_000,
    };

    const result = await invokeContractRoute(
      makeTransport(validBody),
      LOGIN_ROUTE,
      {},
      { responseSchema: ControlAuthLoginResponseSchema },
    );

    expect(result).toEqual(validBody);
  });

  it('passes through response when no schema is provided (graceful fallback)', async () => {
    const unknownBody = { whatever: true, nested: { foo: 'bar' } };

    const result = await invokeContractRoute(
      makeTransport(unknownBody),
      LOGIN_ROUTE,
      {},
      {},
    );

    expect(result).toEqual(unknownBody);
  });
});

// ---------------------------------------------------------------------------
// 2. Contract violation — malformed response throws ContractError
// ---------------------------------------------------------------------------
describe('zod-validation: contract violations', () => {
  it('throws ContractError with kind=contract when required login fields are missing', async () => {
    const malformedBody = { unexpected_field: 'oops' };

    await expect(
      invokeContractRoute(
        makeTransport(malformedBody),
        LOGIN_ROUTE,
        {},
        { responseSchema: ControlAuthLoginResponseSchema },
      ),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('throws ContractError with field path and operation in message on wrong type', async () => {
    const wrongTypes = {
      authenticated: 'yes', // should be boolean
      token: 'tok_abc',
      username: 'alice',
      expiresAt: Date.now(),
    };

    const caught = await invokeContractRoute(
      makeTransport(wrongTypes),
      LOGIN_ROUTE,
      {},
      { responseSchema: ControlAuthLoginResponseSchema },
    ).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(ContractError);
    const msg = (caught as ContractError).message;
    expect(msg).toContain('authenticated');
    expect(msg).toContain(LOGIN_ROUTE.path);
  });

  it('throws ContractError for accounts.snapshot when providers is wrong type', async () => {
    const badSnapshot = {
      capturedAt: Date.now(),
      providers: 'not-an-array',
      configuredCount: 0,
      issueCount: 0,
    };

    await expect(
      invokeContractRoute(
        makeTransport(badSnapshot),
        { method: 'GET', path: '/api/control-plane/invoke/accounts.snapshot' },
        {},
        { responseSchema: AccountsSnapshotResponseSchema },
      ),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('throws ContractError for control.status when version field is missing', async () => {
    const badStatus = { status: 'ok' /* missing: version */ };

    await expect(
      invokeContractRoute(
        makeTransport(badStatus),
        { method: 'GET', path: '/api/status' },
        {},
        { responseSchema: ControlStatusResponseSchema },
      ),
    ).rejects.toMatchObject({ kind: 'contract' });
  });
});

// ---------------------------------------------------------------------------
// 3. Schema unit tests — no transport needed
// ---------------------------------------------------------------------------
describe('zod-validation: schema correctness', () => {
  it('ControlAuthCurrentResponseSchema parses all auth modes', () => {
    for (const authMode of ['anonymous', 'invalid', 'session', 'shared-token'] as const) {
      const result = ControlAuthCurrentResponseSchema.safeParse({
        authenticated: true,
        authMode,
        tokenPresent: false,
        authorizationHeaderPresent: false,
        sessionCookiePresent: false,
        principalId: null,
        principalKind: null,
        admin: false,
        scopes: [],
        roles: [],
      });
      expect(result.success).toBe(true);
    }
  });

  it('SerializedEventEnvelopeSchema accepts envelope with only required fields', () => {
    const minimal = { type: 'STREAM_DELTA', payload: { type: 'STREAM_DELTA', content: 'hi' } };
    expect(SerializedEventEnvelopeSchema.safeParse(minimal).success).toBe(true);
  });

  it('ControlAuthLoginResponseSchema rejects partial body', () => {
    const partial = { authenticated: true }; // missing token, username, expiresAt
    expect(ControlAuthLoginResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('inline schema validation works for arbitrary method response shapes', async () => {
    const customSchema = z.object({ id: z.string(), active: z.boolean() });
    const validBody = { id: 'abc', active: true };

    const result = await invokeContractRoute(
      makeTransport(validBody),
      { method: 'GET', path: '/api/custom' },
      {},
      { responseSchema: customSchema },
    );

    expect(result).toEqual(validBody);
  });
});
