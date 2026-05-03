import { describe, it, expect, beforeEach } from 'bun:test';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { AutomationRouteStore } from '../packages/sdk/src/platform/automation/store/routes.js';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// In-memory route store stub
// ---------------------------------------------------------------------------

function makeMemoryRouteStore(): AutomationRouteStore {
  let routes: AutomationRouteBinding[] = [];
  return {
    load: async () => ({ version: 1 as const, routes }),
    save: async (next: readonly AutomationRouteBinding[]) => { routes = [...next]; },
  } as unknown as AutomationRouteStore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(bus: RuntimeEventBus): RouteBindingManager {
  return new RouteBindingManager({
    store: makeMemoryRouteStore(),
    runtimeBus: bus,
  });
}

const BASE_INPUT = {
  kind: 'session' as const,
  surfaceKind: 'slack' as const,
  surfaceId: 'T-test',
  externalId: 'U-test',
};

interface CapturedEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

async function flush(): Promise<void> {
  await settleEvents(0);
}

function captureRouteEvents(bus: RuntimeEventBus): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  bus.onDomain('routes', (envelope) => {
    captured.push({
      type: (envelope.payload as { type: string }).type,
      data: envelope.payload as Record<string, unknown>,
    });
  });
  return captured;
}

// ---------------------------------------------------------------------------
// Tests — upsertBinding emissions
// ---------------------------------------------------------------------------

describe('RouteBindingManager.upsertBinding — emissions', () => {
  let bus: RuntimeEventBus;
  let manager: RouteBindingManager;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new RuntimeEventBus();
    manager = makeManager(bus);
    events = captureRouteEvents(bus);
  });

  it('emits ROUTE_BINDING_CREATED when the binding is new', async () => {
    await manager.upsertBinding(BASE_INPUT);
    await flush();

    const created = events.find((e) => e.type === 'ROUTE_BINDING_CREATED');
    expect(created).toBeDefined();
  });

  it('emits ROUTE_BINDING_UPDATED when the binding already exists', async () => {
    const first = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.upsertBinding({ ...BASE_INPUT, id: first.id });
    await flush();

    const updated = events.find((e) => e.type === 'ROUTE_BINDING_UPDATED');
    expect(updated).toBeDefined();
    const created = events.find((e) => e.type === 'ROUTE_BINDING_CREATED');
    expect(created).toBeUndefined();
  });

  it('ROUTE_BINDING_CREATED contains surfaceKind and externalId', async () => {
    await manager.upsertBinding(BASE_INPUT);
    await flush();

    const evt = events.find((e) => e.type === 'ROUTE_BINDING_CREATED');
    expect((evt?.data as { surfaceKind: string }).surfaceKind).toBe('slack');
    expect((evt?.data as { externalId: string }).externalId).toBe('U-test');
  });

  it('does not emit when no runtimeBus is configured', async () => {
    const nobusMgr = new RouteBindingManager({ store: makeMemoryRouteStore() });
    const neverCalled: unknown[] = [];
    bus.onDomain('routes', (e) => neverCalled.push(e));

    await nobusMgr.upsertBinding(BASE_INPUT);
    await flush();

    expect(neverCalled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — removeBinding emissions
// ---------------------------------------------------------------------------

describe('RouteBindingManager.removeBinding — emissions', () => {
  let bus: RuntimeEventBus;
  let manager: RouteBindingManager;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new RuntimeEventBus();
    manager = makeManager(bus);
    events = captureRouteEvents(bus);
  });

  it('emits ROUTE_BINDING_REMOVED after successful removal', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect(removed).toBeDefined();
  });

  it('ROUTE_BINDING_REMOVED contains bindingId, surfaceKind, externalId', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const evt = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect((evt?.data as { bindingId: string }).bindingId).toBe(binding.id);
    expect((evt?.data as { surfaceKind: string }).surfaceKind).toBe('slack');
    expect((evt?.data as { externalId: string }).externalId).toBe('U-test');
  });

  it('does NOT emit ROUTE_BINDING_REMOVED when binding does not exist', async () => {
    await manager.removeBinding('non-existent-id');
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect(removed).toBeUndefined();
  });

  it('removal is idempotent — second call emits nothing', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    await manager.removeBinding(binding.id);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect(removed).toBeUndefined();
  });

  it('ROUTE_BINDING_REMOVED fires AFTER the binding is deleted from storage', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    let listingAfterRemove: AutomationRouteBinding[] | null = null;

    bus.onDomain('routes', (envelope) => {
      if ((envelope.payload as { type: string }).type === 'ROUTE_BINDING_REMOVED') {
        listingAfterRemove = manager.listBindings();
      }
    });

    await manager.removeBinding(binding.id);
    await flush();

    expect(listingAfterRemove).not.toBeNull();
    expect((listingAfterRemove as AutomationRouteBinding[]).find((b) => b.id === binding.id)).toBeUndefined();
  });
});
