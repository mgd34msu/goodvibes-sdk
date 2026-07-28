/**
 * The three control-plane verbs that let an authorized workstream register
 * what it is about to expect.
 *
 * These sit on top of `InboundExpectationRegistry`, and the split matters:
 * the handlers read arguments and refuse the malformed ones with honest
 * statuses, and every RULE — the window ceiling, the open cap, the refusal
 * when email holds command authority — stays in the book underneath. So these
 * tests check argument handling and pass-through, and deliberately do not
 * re-assert the bounds that `inbound-mail-expectation-registry.test.ts`
 * already covers at their source.
 *
 * The service is the real registry on a temp file, not a stub. A stub would
 * let a handler pass while the thing it calls refuses.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboundExpectationRegistry } from '../packages/sdk/src/platform/email/inbound/expectation-registry.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import {
  createEmailExpectationCancelHandler,
  createEmailExpectationListHandler,
  createEmailExpectationOpenHandler,
  registerEmailExpectationGatewayMethods,
  type EmailExpectationService,
} from '../packages/sdk/src/platform/control-plane/routes/email-expectations.ts';
import { builtinGatewayEmailMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-email.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRegistry(): InboundExpectationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-expectation-verbs-'));
  dirs.push(dir);
  return new InboundExpectationRegistry({
    store: new PersistedExpectationStore(join(dir, 'expectations.json')),
  });
}

function invocation(body: Record<string, unknown>): GatewayMethodInvocation {
  // A real GatewayMethodInvocation: `body` plus the required `context`. There
  // is no `method` field on it — the old literal asserted a shape the type
  // never had, which is why the cast was needed to compile it.
  return { body, context: {} };
}

const VALID = {
  serviceDomain: 'example.com',
  recipientAddress: 'signup-a1@alias.test',
  purpose: 'confirm the account for example.com',
};

describe('email.expectation.open', () => {
  test('registers an expectation and hands back the record', async () => {
    const registry = newRegistry();
    const open = createEmailExpectationOpenHandler(registry);

    const result = await open(invocation(VALID)) as Record<string, unknown>;

    expect(result.recipientAddress).toBe('signup-a1@alias.test');
    expect(result.serviceDomain).toBe('example.com');
    // Carried on the wire so a consumer reads the grant's scope off the
    // record rather than assuming it from the fact that a match occurred.
    expect(result.authority).toBe('evidence-only');
    expect(registry.list().length).toBe(1);
  });

  test.each([
    ['serviceDomain', { ...VALID, serviceDomain: '' }],
    ['recipientAddress', { ...VALID, recipientAddress: '   ' }],
    ['purpose', { ...VALID, purpose: undefined }],
  ])('refuses a missing %s rather than registering a partial expectation', async (field, body) => {
    const open = createEmailExpectationOpenHandler(newRegistry());
    await expect(open(invocation(body))).rejects.toThrow(field);
  });

  test('refuses a malformed windowMs rather than silently substituting the default', async () => {
    // A caller that sent "soon" has a bug. Substituting the default would hide
    // it behind an expectation that expires at a time nobody chose.
    const open = createEmailExpectationOpenHandler(newRegistry());
    await expect(open(invocation({ ...VALID, windowMs: 'soon' }))).rejects.toThrow('windowMs');
    await expect(open(invocation({ ...VALID, windowMs: -5 }))).rejects.toThrow('windowMs');
  });

  test('refuses an unrecognised kind rather than defaulting it', async () => {
    const open = createEmailExpectationOpenHandler(newRegistry());
    await expect(open(invocation({ ...VALID, kind: 'password-reset' }))).rejects.toThrow('kind');
  });

  test('an over-long window is clamped by the book, not refused by the handler', async () => {
    // The handler does not re-implement the ceiling; it passes a
    // well-formed value through and the book clamps it. Asserting that here
    // is what keeps a second copy of the clamp from growing in the handler.
    const registry = newRegistry();
    const open = createEmailExpectationOpenHandler(registry);
    const result = await open(invocation({
      ...VALID, windowMs: 30 * 24 * 60 * 60 * 1000,
    })) as Record<string, unknown>;

    const granted = Date.parse(String(result.expiresAt)) - Date.parse(String(result.openedAt));
    expect(granted).toBe(InboundExpectationRegistry.maxWindowMs);
  });

  test('a refusal because email gained command authority is a 409, not a 400', async () => {
    // That is a statement about the platform's configuration, not about this
    // request — a caller cannot fix it by sending different arguments.
    const dir = mkdtempSync(join(tmpdir(), 'goodvibes-expectation-verbs-'));
    dirs.push(dir);
    const registry = new InboundExpectationRegistry({
      store: new PersistedExpectationStore(join(dir, 'expectations.json')),
      authority: { surfaceHasCommandAuthority: () => true },
    });
    const open = createEmailExpectationOpenHandler(registry);

    await expect(open(invocation(VALID))).rejects.toMatchObject({ status: 409 });
  });
});

describe('email.expectation.list', () => {
  test('discloses open expectations with their remaining window', async () => {
    const registry = newRegistry();
    await registry.open(VALID);
    const list = createEmailExpectationListHandler(registry);

    const result = await list(invocation({})) as {
      expectations: readonly Record<string, unknown>[];
      total: number;
    };

    expect(result.total).toBe(1);
    expect(result.expectations[0]?.recipientAddress).toBe('signup-a1@alias.test');
    expect(typeof result.expectations[0]?.remainingMs).toBe('number');
  });

  test('an empty book is an empty list, not an error', async () => {
    const list = createEmailExpectationListHandler(newRegistry());
    const result = await list(invocation({})) as { total: number };
    expect(result.total).toBe(0);
  });
});

describe('email.expectation.cancel', () => {
  test('closes the expectation so a later matching arrival satisfies nothing', async () => {
    const registry = newRegistry();
    const opened = await registry.open(VALID);
    const cancel = createEmailExpectationCancelHandler(registry);

    const result = await cancel(invocation({ id: opened.id })) as Record<string, unknown>;

    expect(result.cancelled).toBe(true);
    expect(registry.list().length).toBe(0);
  });

  test('an id that is not open reports cancelled: false rather than failing', async () => {
    // A caller retrying after a crash must not read success as failure.
    const cancel = createEmailExpectationCancelHandler(newRegistry());
    const result = await cancel(invocation({ id: 'not-a-real-id' })) as Record<string, unknown>;
    expect(result.cancelled).toBe(false);
  });

  test('refuses a missing id', async () => {
    const cancel = createEmailExpectationCancelHandler(newRegistry());
    await expect(cancel(invocation({}))).rejects.toThrow('id');
  });
});

describe('the catalog and the handlers agree', () => {
  const ids = ['email.expectation.open', 'email.expectation.list', 'email.expectation.cancel'];

  test('every expectation verb is declared', () => {
    for (const id of ids) {
      expect(builtinGatewayEmailMethodDescriptors.some((d) => d.id === id)).toBe(true);
    }
  });

  test('each declares the required inputs its handler actually enforces', () => {
    // The durable half of the instruction that produced this file: declare
    // what the handler enforces, for every method added. A contract that
    // under-states its requirements is how a consumer ships a call that
    // always fails.
    const requiredFor = (id: string): readonly string[] => {
      const descriptor = builtinGatewayEmailMethodDescriptors.find((d) => d.id === id);
      const schema = descriptor?.inputSchema as { required?: readonly string[] } | undefined;
      return schema?.required ?? [];
    };
    expect([...requiredFor('email.expectation.open')].sort())
      .toEqual(['purpose', 'recipientAddress', 'serviceDomain']);
    expect(requiredFor('email.expectation.cancel')).toEqual(['id']);
    expect(requiredFor('email.expectation.list')).toEqual([]);
  });

  test('none advertises an http path, because no route serves one', () => {
    // The route-reconcile gate reddens a descriptor promising an /api path
    // that nothing serves. These are daemon-internal verbs reached over the
    // control plane; inventing a REST surface would be inventing a promise.
    for (const id of ids) {
      const descriptor = builtinGatewayEmailMethodDescriptors.find((d) => d.id === id);
      expect(descriptor?.http).toBeUndefined();
    }
  });

  test('registering attaches all three handlers to their descriptors', () => {
    const registered: string[] = [];
    const service: EmailExpectationService = newRegistry();
    registerEmailExpectationGatewayMethods({
      get: (id: string) => (ids.includes(id) ? { id } : undefined),
      register: (descriptor: { id: string }) => { registered.push(descriptor.id); },
    } as unknown as Parameters<typeof registerEmailExpectationGatewayMethods>[0], service);

    expect(registered.sort()).toEqual([...ids].sort());
  });
});
