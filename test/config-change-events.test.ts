/**
 * config-change-events.test.ts
 *
 * The `config` runtime-event domain: key-level change notices, so a client
 * whose settings live in the daemon can subscribe to a change instead of
 * re-reading config on a timer.
 *
 * The two properties that matter, and the second is why this is not just a
 * convenience:
 *   - an ordinary setting's notice carries the new VALUE, so a subscriber can
 *     apply it without a round trip;
 *   - a credential-bearing key's notice carries the key NAME and nothing else —
 *     `secret: true`, and no `value` property at all. Not a nulled value, which
 *     a subscriber would read as "the credential was cleared".
 */

import { describe, expect, test } from 'bun:test';
import {
  attachConfigEmitBridge,
  listWatchableConfigPaths,
  toConfigEventValue,
  type ConfigChangeSource,
} from '../packages/sdk/src/platform/runtime/config/index.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { RUNTIME_EVENT_DOMAINS } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { ConfigEvent } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { builtinGatewayEventDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-events.ts';

/** A ConfigManager stand-in with the one seam the bridge uses. */
function fakeConfig(): ConfigChangeSource & { change(key: string, value: unknown): void; watched(): number } {
  const listeners = new Map<string, Set<(next: unknown, previous: unknown) => void>>();
  return {
    subscribe(key, callback) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(callback);
      return () => { listeners.get(key)?.delete(callback); };
    },
    change(key, value) {
      for (const callback of listeners.get(key) ?? []) callback(value, undefined);
    },
    watched: () => listeners.size,
  };
}

/** Collect config-domain events; bus dispatch is via queueMicrotask, so flush after. */
function collector(bus: RuntimeEventBus): ConfigEvent[] {
  const seen: ConfigEvent[] = [];
  bus.onDomain('config', (envelope) => { seen.push(envelope.payload as ConfigEvent); });
  return seen;
}

async function flush(): Promise<void> {
  // Two macrotask hops comfortably drains the queued microtask dispatch.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the config event domain exists and is documented', () => {
  test('`config` is a real runtime event domain', () => {
    expect([...RUNTIME_EVENT_DOMAINS]).toContain('config');
  });

  test('the catalog describes it, and says values are withheld for secret keys', () => {
    const descriptor = builtinGatewayEventDescriptors.find((entry) => entry.id === 'runtime.config');
    expect(descriptor).toBeDefined();
    expect(descriptor?.domains).toEqual(['config']);
    expect(descriptor?.transport).toEqual(['sse', 'ws']);
    expect(descriptor?.description).toContain('secret');
  });
});

describe('attachConfigEmitBridge', () => {
  test('an ordinary setting changing emits the key, its scope and its new value', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, now: () => 1_700_000_000_000 });

    config.change('voice.wake.enabled', true);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'CONFIG_KEY_CHANGED',
      key: 'voice.wake.enabled',
      secret: false,
      value: true,
      changedAt: 1_700_000_000_000,
    });
    detach();
  });

  test('a daemon-owned key is reported as daemon-scoped, a client-owned one as client', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('watchers.enabled', false);
    config.change('voice.wake.enabled', true);
    await flush();

    const byKey = new Map(seen.map((event) => [event.key, event]));
    expect(byKey.get('watchers.enabled')?.scope).toBe('daemon');
    expect(byKey.get('voice.wake.enabled')?.scope).toBe('client');
    detach();
  });

  test('a credential-bearing key travels by NAME ONLY — no value property at all', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('surfaces.telegram.botToken', 'a-real-looking-bot-token');
    await flush();

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.key).toBe('surfaces.telegram.botToken');
    expect(event.secret).toBe(true);
    // Absent, not null: a null would read as "the credential was cleared".
    expect(Object.hasOwn(event, 'value')).toBe(false);
    expect(JSON.stringify(event)).not.toContain('a-real-looking-bot-token');
    detach();
  });

  test('detaching stops the notices, so a torn-down bus is never emitted into', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('voice.wake.enabled', true);
    detach();
    config.change('voice.wake.enabled', false);
    await flush();

    expect(seen).toHaveLength(1);
  });

  test('a product may name extra keys the platform set does not', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.customSetting'] });

    config.change('acme.customSetting', 'on');
    await flush();

    expect(seen.map((event) => event.key)).toEqual(['acme.customSetting']);
    detach();
  });
});

describe('the watched surface', () => {
  test('covers the declared schema keys plus the daemon-owned non-schema paths', () => {
    const paths = listWatchableConfigPaths();
    expect(paths).toContain('watchers.enabled');
    // A daemon-owned path with no scalar schema entry — the class that every
    // owned-set walk used to miss.
    expect(paths).toContain('email.passwordRef');
    // A declared credential-bearing path.
    expect(paths).toContain('surfaces.telegram.botToken');
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('subscribing the whole surface is what makes an EXTERNAL file edit fire', () => {
    // The manager's reload diff walks the keys something subscribed to, so a
    // key nobody watched was never compared. The bridge subscribing everything
    // is the mechanism, so assert the subscription count matches the surface.
    const bus = new RuntimeEventBus();
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });
    expect(config.watched()).toBe(listWatchableConfigPaths().length);
    detach();
  });
});

describe('toConfigEventValue', () => {
  test('passes JSON-shaped values through', () => {
    expect(toConfigEventValue(true)).toBe(true);
    expect(toConfigEventValue('x')).toBe('x');
    expect(toConfigEventValue(null)).toBe(null);
    expect(toConfigEventValue(['a', 'b'])).toEqual(['a', 'b']);
    expect(toConfigEventValue({ a: 1 })).toEqual({ a: 1 });
  });

  test('drops what cannot survive the wire rather than coercing it into prose', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toConfigEventValue(cyclic)).toBeUndefined();
    expect(toConfigEventValue(undefined)).toBeUndefined();
  });
});
