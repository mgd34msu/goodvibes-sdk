/**
 * Smoke tests for SDKObserver wire-up.
 *
 * Verifies that:
 * 1. createGoodVibesAuthClient accepts an observer and fires onAuthTransition on login.
 * 2. Observers that throw do NOT propagate errors into SDK logic.
 * 3. createConsoleObserver and createOpenTelemetryObserver construct without error.
 */

import { describe, expect, test } from 'bun:test';
import {
  createGoodVibesAuthClient,
} from '../packages/sdk/src/auth.js';
import {
  createConsoleObserver,
  createOpenTelemetryObserver,
  invokeObserver,
  type SDKObserver,
  type AuthTransitionInfo,
  type TransportActivityInfo,
} from '../packages/sdk/src/observer/index.js';
import type { OperatorSdk } from '../packages/operator-sdk/src/index.js';

function makeRawStore(initial: string | null = null) {
  let current = initial;
  return {
    async getToken() { return current; },
    async setToken(t: string | null) { current = t; },
    async clearToken() { current = null; },
  };
}

function makeOperator() {
  return {
    control: {
      auth: {
        current: async () => ({
          authenticated: true,
          authMode: 'session',
          tokenPresent: true,
          authorizationHeaderPresent: true,
          sessionCookiePresent: false,
          principalId: 'alice',
          principalKind: 'user',
          admin: false,
          scopes: [],
          roles: [],
        }),
        login: async (_input: unknown) => ({
          token: 'tok_test',
          authenticated: true,
          username: 'alice',
          expiresAt: Date.now() + 60_000,
        }),
      },
    },
  } as unknown as OperatorSdk;
}

describe('SDKObserver — auth wire-up', () => {
  test('onAuthTransition is called with login transition on successful login', async () => {
    const observed: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { observed.push(t); },
    };

    const auth = createGoodVibesAuthClient(
      makeOperator(),
      makeRawStore(),
      undefined,
      observer,
    );

    await auth.login({ username: 'alice', password: 'secret' });
    expect(observed).toHaveLength(1);
    expect(observed[0].reason).toBe('login');
    expect(observed[0].to).toBe('token');
  });

  test('onAuthTransition is called with logout transition on clearToken', async () => {
    const observed: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { observed.push(t); },
    };

    const auth = createGoodVibesAuthClient(
      makeOperator(),
      makeRawStore('existing-token'),
      undefined,
      observer,
    );

    await auth.clearToken();
    expect(observed).toHaveLength(1);
    expect(observed[0].reason).toBe('logout');
  });

  test('an observer that throws does NOT propagate into SDK logic', async () => {
    const observer: SDKObserver = {
      onAuthTransition(_t) {
        throw new Error('observer is broken');
      },
    };

    const auth = createGoodVibesAuthClient(
      makeOperator(),
      makeRawStore(),
      undefined,
      observer,
    );

    // Should NOT throw despite the observer throwing
    await expect(auth.login({ username: 'alice', password: 'secret' })).resolves.toBeDefined();
  });

  test('createGoodVibesAuthClient works identically when observer is undefined', async () => {
    const auth = createGoodVibesAuthClient(
      makeOperator(),
      makeRawStore(),
    );
    const result = await auth.login({ username: 'alice', password: 'secret' });
    expect(result.token).toBe('tok_test');
  });
});

describe('SDKObserver — TransportObserver callbacks', () => {
  test('invokeObserver fires onTransportActivity send+recv', () => {
    const activities: TransportActivityInfo[] = [];
    const observer: SDKObserver = {
      onTransportActivity(a) { activities.push(a); },
    };

    invokeObserver(() => observer.onTransportActivity?.({ direction: 'send', url: 'http://localhost/api', kind: 'http' }));
    invokeObserver(() => observer.onTransportActivity?.({ direction: 'recv', url: 'http://localhost/api', kind: 'http', durationMs: 42 }));

    expect(activities).toHaveLength(2);
    expect(activities[0].direction).toBe('send');
    expect(activities[1].direction).toBe('recv');
    expect(activities[1].durationMs).toBe(42);
  });

  test('invokeObserver swallows onTransportActivity errors', () => {
    const observer: SDKObserver = {
      onTransportActivity(_a) { throw new Error('transport observer broken'); },
    };
    expect(() =>
      invokeObserver(() => observer.onTransportActivity?.({ direction: 'send', url: 'http://x', kind: 'http' }))
    ).not.toThrow();
  });

  test('invokeObserver swallows onError errors', () => {
    const observer: SDKObserver = {
      onError(_e) { throw new Error('error observer broken'); },
    };
    expect(() =>
      invokeObserver(() => (observer as { onError?: (e: Error) => void }).onError?.(new Error('sdk error')))
    ).not.toThrow();
  });

  test('invokeObserver swallows onEvent errors', () => {
    const observer: SDKObserver = {
      onEvent(_e) { throw new Error('event observer broken'); },
    };
    expect(() =>
      invokeObserver(() => (observer as { onEvent?: (e: unknown) => void }).onEvent?.({ type: 'UNKNOWN' }))
    ).not.toThrow();
  });

  test('onTransportActivity sse and ws kind values accepted', () => {
    const activities: TransportActivityInfo[] = [];
    const observer: SDKObserver = {
      onTransportActivity(a) { activities.push(a); },
    };
    invokeObserver(() => observer.onTransportActivity?.({ direction: 'send', url: 'http://x', kind: 'sse' }));
    invokeObserver(() => observer.onTransportActivity?.({ direction: 'send', url: 'http://x', kind: 'ws' }));
    expect(activities[0].kind).toBe('sse');
    expect(activities[1].kind).toBe('ws');
  });
});

describe('SDKObserver — built-in adapters', () => {
  test('createConsoleObserver constructs without error', () => {
    expect(() => createConsoleObserver()).not.toThrow();
    expect(() => createConsoleObserver({ level: 'debug' })).not.toThrow();
    expect(() => createConsoleObserver({ level: 'info' })).not.toThrow();
  });

  test('createConsoleObserver.onAuthTransition does not throw', () => {
    const obs = createConsoleObserver();
    expect(() => obs.onAuthTransition?.({ from: 'anonymous', to: 'token', reason: 'login' })).not.toThrow();
  });

  test('createOpenTelemetryObserver constructs and calls meter/tracer without error', () => {
    const spans: Array<{ name: string; ended: boolean }> = [];
    const counters: Array<{ name: string; value: number }> = [];

    const mockTracer: Parameters<typeof createOpenTelemetryObserver>[0] = {
      startActiveSpan(name, fn) {
        const span = {
          setAttribute: () => span,
          setStatus: () => span,
          recordException: () => span,
          end: () => { spans.push({ name, ended: true }); },
        };
        return fn(span) as ReturnType<typeof fn>;
      },
      startSpan(name) {
        const span = {
          setAttribute: () => span,
          setStatus: () => span,
          recordException: () => span,
          end: () => { spans.push({ name, ended: true }); },
        };
        return span;
      },
    };

    const mockMeter: Parameters<typeof createOpenTelemetryObserver>[1] = {
      createCounter(name) {
        return { add: (v) => { counters.push({ name, value: v }); } };
      },
      createHistogram(_name) {
        return { record: (_v) => {} };
      },
    };

    const obs = createOpenTelemetryObserver(mockTracer, mockMeter);
    expect(obs).toBeDefined();

    obs.onAuthTransition?.({ from: 'anonymous', to: 'token', reason: 'login' });
    expect(counters.some((c) => c.name === 'sdk.auth.transitions' && c.value === 1)).toBe(true);
    expect(spans.some((s) => s.name === 'sdk.auth.transition' && s.ended)).toBe(true);
  });
});
