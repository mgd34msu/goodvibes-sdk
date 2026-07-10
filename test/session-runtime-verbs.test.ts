/**
 * session-runtime-verbs.test.ts
 *
 * The session-scoped operator verbs: sessions.permissionMode.get/set and
 * sessions.contextUsage.get. Pins the operator<->config mode vocabulary
 * mapping, the honest 404 for a non-local session, the previousMode reported
 * on a set, and the context-usage figures (derived from the estimator, flagged
 * `estimated`).
 */
import { describe, expect, test } from 'bun:test';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.js';
import type { PermissionMode } from '../packages/sdk/src/platform/config/schema-types.js';
import { GatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.js';
import {
  createSessionRuntimeControls,
  createSessionPermissionModeGetHandler,
  createSessionPermissionModeSetHandler,
  createSessionContextUsageGetHandler,
  toOperatorPermissionMode,
  toConfigPermissionMode,
  type PermissionModeConfig,
  type SessionRuntimeStateReader,
} from '../packages/sdk/src/platform/control-plane/routes/session-runtime.js';

function invoke(body: Record<string, unknown>): GatewayMethodInvocation {
  return { body, context: {} };
}

/** A config double storing a single permissions.mode value. */
function makeConfig(initial: PermissionMode): PermissionModeConfig & { current: PermissionMode } {
  return {
    current: initial,
    get(_key) {
      return this.current;
    },
    set(_key, value) {
      this.current = value;
    },
  };
}

function makeStore(sessionId: string, usedTokens: number, contextWindow: number): SessionRuntimeStateReader {
  return {
    getState: () => ({
      session: { id: sessionId },
      conversation: { estimatedContextTokens: usedTokens },
      model: { tokenLimits: { contextWindow } },
    }),
  };
}

// ── vocabulary mapping ───────────────────────────────────────────────────────

describe('permission mode vocabulary', () => {
  test('config -> operator vocabulary', () => {
    expect(toOperatorPermissionMode('prompt')).toBe('normal');
    expect(toOperatorPermissionMode('allow-all')).toBe('auto');
    expect(toOperatorPermissionMode('plan')).toBe('plan');
    expect(toOperatorPermissionMode('accept-edits')).toBe('accept-edits');
    expect(toOperatorPermissionMode('custom')).toBe('custom');
  });

  test('operator -> config vocabulary (settable only)', () => {
    expect(toConfigPermissionMode('normal')).toBe('prompt');
    expect(toConfigPermissionMode('auto')).toBe('allow-all');
    expect(toConfigPermissionMode('plan')).toBe('plan');
    expect(toConfigPermissionMode('accept-edits')).toBe('accept-edits');
  });

  test('an unknown or non-settable mode is a 400', () => {
    expect(() => toConfigPermissionMode('custom')).toThrow(GatewayVerbError);
    expect(() => toConfigPermissionMode('nope')).toThrow(GatewayVerbError);
  });
});

// ── get / set handlers ───────────────────────────────────────────────────────

describe('sessions.permissionMode get/set', () => {
  test('get returns the operator-vocabulary mode for the local runtime', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'normal' });
  });

  test('the stable "runtime" alias always resolves the local runtime', () => {
    const config = makeConfig('plan');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'runtime' }));
    expect(out).toEqual({ sessionId: 'runtime', mode: 'plan' });
  });

  test('set writes config and reports the previous mode', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'sess-1', mode: 'plan' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'plan', previousMode: 'normal' });
    expect(config.current).toBe('plan'); // config actually mutated (fires the wire event via the binding)
  });

  test('a non-local session id is an honest 404, never a fabricated answer', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    let thrown: unknown;
    try {
      createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'other-session' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).code).toBe('SESSION_NOT_LOCAL');
  });

  test('a missing sessionId is a 400', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    expect(() => createSessionPermissionModeGetHandler(controls)(invoke({}))).toThrow(GatewayVerbError);
  });
});

// ── context usage ─────────────────────────────────────────────────────────────

describe('sessions.contextUsage.get', () => {
  test('reports estimated tokens + derived pct/remaining, flagged estimated', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 40_000, 100_000),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({
      sessionId: 'sess-1',
      estimatedContextTokens: 40_000,
      contextWindow: 100_000,
      contextUsagePct: 40,
      contextRemainingTokens: 60_000,
      estimated: true,
    });
  });

  test('safe when the context window is unknown (0)', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 1234, 0),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' })) as {
      contextUsagePct: number;
      contextRemainingTokens: number;
    };
    expect(out.contextUsagePct).toBe(0);
    expect(out.contextRemainingTokens).toBe(0);
  });
});
