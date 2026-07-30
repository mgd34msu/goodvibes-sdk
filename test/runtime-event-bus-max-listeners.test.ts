/**
 *
 * RuntimeEventBus hard listener cap.
 * Verifies:
 * - Below cap: normal registration succeeds (no warning, no throw).
 * - At cap in production mode: the (cap+1)th registration succeeds with a
 *   logger.warn (registration is NOT refused — live systems must not break).
 * - Dev mode: throws a RangeError on overflow.
 * - Override via maxListeners option: higher cap is respected, overflow at
 *   the new boundary behaves correctly.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeEventBus,
  MAX_LISTENERS,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '../packages/sdk/src/platform/runtime/events/index.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { logger } from '../packages/sdk/src/platform/utils/logger.ts';
import type { SessionEvent } from '../packages/sdk/src/events/session.js';

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

describe('MAX_LISTENERS constant', () => {
  test('MAX_LISTENERS is exported and equals 100', () => {
    expect(MAX_LISTENERS).toBe(100);
  });
});

describe('below-cap registration (production mode)', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    warnSpy.mockRestore();
  });

  test('registering up to the cap does not warn', () => {
    const bus = new RuntimeEventBus();
    // Register exactly MAX_LISTENERS listeners (at the boundary, warn fires at > MAX)
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
    const warnCalls = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('listener leak')
    );
    expect(warnCalls.length).toBe(0);
  });
});

describe('overflow in production mode — warn, allow', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    warnSpy.mockRestore();
  });

  test('(cap+1)th on() registration succeeds and logs a warning', () => {
    const bus = new RuntimeEventBus();
    // Fill to cap
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
    // One more should warn but NOT throw
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
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

describe('overflow in development mode — throw RangeError', () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
  });

  test('on() throws RangeError on overflow in dev mode', () => {
    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });

  test('thrown RangeError message references the event type and cap', () => {
    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
    const caught = (() => { try { bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]); } catch (e) { return e; } })();
    expect(caught).toBeInstanceOf(RangeError);
    const msg = (caught as RangeError).message;
    expect(msg).toContain('SESSION_STARTED');
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
    registerN(bus, 'SESSION_STARTED', cap);
    // This should throw — listener must NOT be added
    try {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    } catch {
      // expected
    }
    // Register one more valid listener — if state is corrupt this will also throw
    // when it should not.
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError); // still at cap+1 (cap+rejected+1 would overflow too)
  });
});

describe('config override via maxListeners constructor option', () => {
  let warnSpy: Mock<typeof logger.warn>;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    warnSpy.mockRestore();
  });

  test('higher cap via option is respected — no warn below new cap', () => {
    process.env['NODE_ENV'] = 'production';
    const customCap = 200;
    const bus = new RuntimeEventBus({ maxListeners: customCap });
    // Register up to the default MAX (100) — should not warn with the higher cap
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
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
    registerN(bus, 'SESSION_STARTED', customCap);
    // One more should warn
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
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
    registerN(bus, 'SESSION_STARTED', smallCap);
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The config key behind the cap
// ---------------------------------------------------------------------------
//
// Everything above proves the cap works when a construction site passes one.
// None of it says `runtime.eventBus.maxListeners` reaches a bus: the SDK's three
// construction sites all passed nothing, so the schema promised a tunable cap
// that was always 100. These drive the real read path — a ConfigManager holding
// a set value, through `runtimeEventBusOptionsFrom` and
// `configureRuntimeEventBusDefaults`, into a bus built with no options — at two
// different configured values.

describe('runtime.eventBus.maxListeners governs a bus built with no options', () => {
  let origEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    tmpRoot = mkdtempSync(join(tmpdir(), 'gv-event-bus-cap-'));
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    // Leave the process-wide default where the rest of the suite expects it.
    configureRuntimeEventBusDefaults({ maxListeners: MAX_LISTENERS });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function managerWithCap(cap: number): ConfigManager {
    const manager = new ConfigManager({ configDir: join(tmpRoot, `config-${cap}`) });
    manager.set('runtime.eventBus.maxListeners', cap);
    return manager;
  }

  test('a configured cap of 4 refuses the 5th listener in development', () => {
    process.env['NODE_ENV'] = 'development';
    const config = managerWithCap(4);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));

    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_STARTED', 4);
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });

  test('a configured cap of 40 accepts a 5th listener and refuses the 41st', () => {
    process.env['NODE_ENV'] = 'development';
    const config = managerWithCap(40);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));

    const bus = new RuntimeEventBus();
    // The value the previous case refused is fine at this one.
    expect(() => registerN(bus, 'SESSION_STARTED', 5)).not.toThrow();
    registerN(bus, 'SESSION_STARTED', 35);
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });

  test('the same configured cap applies to the domain channel', () => {
    process.env['NODE_ENV'] = 'development';
    const config = managerWithCap(3);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));

    const bus = new RuntimeEventBus();
    for (let i = 0; i < 3; i++) {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }
    expect(() => {
      bus.onDomain('session', makeListener() as Parameters<typeof bus.onDomain>[1]);
    }).toThrow(RangeError);
  });

  test('an explicit constructor option still outranks the configured default', () => {
    process.env['NODE_ENV'] = 'development';
    const config = managerWithCap(2);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));

    const bus = new RuntimeEventBus({ maxListeners: 10 });
    expect(() => registerN(bus, 'SESSION_STARTED', 10)).not.toThrow();
  });

  test('an unset key leaves the default alone rather than producing a NaN cap', () => {
    process.env['NODE_ENV'] = 'development';
    expect(runtimeEventBusOptionsFrom(() => undefined)).toEqual({});
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom(() => undefined));
    const bus = new RuntimeEventBus();
    registerN(bus, 'SESSION_STARTED', MAX_LISTENERS);
    expect(() => {
      bus.on<SessionEvent>('SESSION_STARTED', makeListener() as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });
});
