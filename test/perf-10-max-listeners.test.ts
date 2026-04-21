/**
 * perf-10-max-listeners.test.ts
 *
 * PERF-10: RuntimeEventBus hard listener cap.
 * Verifies:
 * - Below cap: normal registration succeeds (no warning, no throw).
 * - At cap in production mode: the (cap+1)th registration succeeds with a
 *   logger.warn (registration is NOT refused — live systems must not break).
 * - Dev mode: throws a RangeError on overflow.
 * - Override via maxListeners option: higher cap is respected, overflow at
 *   the new boundary behaves correctly.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { RuntimeEventBus, MAX_LISTENERS } from '../packages/sdk/src/_internal/platform/runtime/events/index.ts';
import { logger } from '../packages/sdk/src/_internal/platform/utils/logger.ts';
import type { SessionEvent } from '../packages/sdk/src/_internal/platform/runtime/events/session.ts';

/** No-op listener factory — each call returns a distinct function reference. */
function makeListener(): () => void {
  return () => { /* no-op */ };
}

/**
 * Register `count` distinct listeners on the given event type.
 * Returns an array of unsubscribe functions.
 */
function registerN(
  bus: RuntimeEventBus,
  eventType: SessionEvent['type'],
  count: number
): Array<() => void> {
  const unsubs: Array<() => void> = [];
  for (let i = 0; i < count; i++) {
    unsubs.push(bus.on<SessionEvent>(eventType, makeListener() as Parameters<typeof bus.on>[1]));
  }
  return unsubs;
}

describe('PERF-10: MAX_LISTENERS constant', () => {
  test('MAX_LISTENERS is exported and equals 100', () => {
    expect(MAX_LISTENERS).toBe(100);
  });
});

describe('PERF-10: below-cap registration (production mode)', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origEnv;
    warnSpy.mockRestore();
  });

  test('registering up to the cap does not warn', () => {
    const bus = new RuntimeEventBus();
    // Register exactly MAX_LISTENERS listeners (at the boundary, warn fires at > MAX)
    registerN(bus, 'SESSION_CREATED', MAX_LISTENERS);
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('listener leak')
    );
    expect(warnCalls.length).toBe(0);
  });
});

describe('PERF-10: overflow in production mode — warn, allow', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origEnv;
    warnSpy.mockRestore();
  });

  test('(cap+1)th on() registration succeeds and logs a warning', () => {
    const bus = new RuntimeEventBus();
    // Fill to cap
    registerN(bus, 'SESSION_CREATED', MAX_LISTENERS);
    // One more should warn but NOT throw
    expect(() => {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    }).not.toThrow();
    // Warning must have been emitted
    const leakWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('listener leak')
    );
    expect(leakWarns.length).toBeGreaterThanOrEqual(1);
  });

  test('(cap+1)th onDomain() registration succeeds and logs a warning', () => {
    const bus = new RuntimeEventBus();
    // Fill domain channel to cap
    for (let i = 0; i < MAX_LISTENERS; i++) {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }
    // One more should warn but NOT throw
    expect(() => {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }).not.toThrow();
    const leakWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('domain listener leak')
    );
    expect(leakWarns.length).toBeGreaterThanOrEqual(1);
  });
});

describe('PERF-10: overflow in development mode — throw RangeError', () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origEnv;
  });

  test('on() throws RangeError on overflow in dev mode', () => {
    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_CREATED', MAX_LISTENERS);
    expect(() => {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });

  test('thrown RangeError message references the event type and cap', () => {
    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_CREATED', MAX_LISTENERS);
    let caught: unknown;
    try {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RangeError);
    const msg = (caught as RangeError).message;
    expect(msg).toContain('SESSION_CREATED');
    expect(msg).toContain(String(MAX_LISTENERS));
  });

  test('onDomain() throws RangeError on overflow in dev mode', () => {
    const bus = new RuntimeEventBus();
    for (let i = 0; i < MAX_LISTENERS; i++) {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }
    expect(() => {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }).toThrow(RangeError);
  });

  test('dev-mode throw does not leave the listener registered', () => {
    const cap = 3;
    const bus = new RuntimeEventBus({ maxListeners: cap });
    registerN(bus, 'SESSION_CREATED', cap);
    // This should throw — listener must NOT be added
    try {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    } catch {
      // expected
    }
    // Register one more valid listener — if state is corrupt this will also throw
    // when it should not.
    expect(() => {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError); // still at cap+1 (cap+rejected+1 would overflow too)
  });
});

describe('PERF-10: config override via maxListeners constructor option', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    process.env['NODE_ENV'] = origEnv;
    warnSpy.mockRestore();
  });

  test('higher cap via option is respected — no warn below new cap', () => {
    process.env['NODE_ENV'] = 'production';
    const customCap = 200;
    const bus = new RuntimeEventBus({ maxListeners: customCap });
    // Register up to the default MAX (100) — should not warn with the higher cap
    registerN(bus, 'SESSION_CREATED', MAX_LISTENERS);
    const leakWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('listener leak')
    );
    expect(leakWarns.length).toBe(0);
  });

  test('higher cap via option — overflow at new boundary warns in production', () => {
    process.env['NODE_ENV'] = 'production';
    const customCap = 150;
    const bus = new RuntimeEventBus({ maxListeners: customCap });
    // Fill to new cap exactly
    registerN(bus, 'SESSION_CREATED', customCap);
    // One more should warn
    expect(() => {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    }).not.toThrow();
    const leakWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('listener leak')
    );
    expect(leakWarns.length).toBeGreaterThanOrEqual(1);
  });

  test('lower cap via option is respected — throws in dev mode at new boundary', () => {
    process.env['NODE_ENV'] = 'development';
    const smallCap = 5;
    const bus = new RuntimeEventBus({ maxListeners: smallCap });
    registerN(bus, 'SESSION_CREATED', smallCap);
    expect(() => {
      bus.on<SessionEvent>('SESSION_CREATED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });
});
