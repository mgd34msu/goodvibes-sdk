import { describe, it, expect, beforeEach } from 'bun:test';
import { ChannelPolicyManager } from '../policy-manager.js';
import { RuntimeEventBus } from '../../runtime/events/index.js';
import type { PersistentStore } from '../../state/persistent-store.js';

// ---------------------------------------------------------------------------
// In-memory store stub — avoids hitting the filesystem
// ---------------------------------------------------------------------------

function makeMemoryStore<T extends Record<string, unknown>>(
  initial?: T,
): PersistentStore<T> {
  let data: T | undefined = initial;
  return {
    load: async () => data ?? null,
    persist: async (next: T) => { data = next; },
  } as unknown as PersistentStore<T>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicyManager(bus: RuntimeEventBus): ChannelPolicyManager {
  return new ChannelPolicyManager({
    store: makeMemoryStore(),
    runtimeBus: bus,
  });
}

interface CapturedEvent {
  readonly domain: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function captureEvents(bus: RuntimeEventBus): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  bus.onDomain('surfaces', (envelope) => {
    captured.push({
      domain: 'surfaces',
      type: (envelope.payload as { type: string }).type,
      data: envelope.payload as Record<string, unknown>,
    });
  });
  return captured;
}

// ---------------------------------------------------------------------------
// Tests — upsertPolicy paired emissions
// ---------------------------------------------------------------------------

describe('ChannelPolicyManager — paired emissions', () => {
  let bus: RuntimeEventBus;
  let manager: ChannelPolicyManager;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new RuntimeEventBus();
    manager = makePolicyManager(bus);
    events = captureEvents(bus);
  });

  it('emits SURFACE_POLICY_UPDATED after successful upsertPolicy', async () => {
    await manager.upsertPolicy('slack', { enabled: true });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('SURFACE_POLICY_UPDATED');
    expect(events[0].domain).toBe('surfaces');
  });

  it('includes surfaceKind and surfaceId in SURFACE_POLICY_UPDATED', async () => {
    await manager.upsertPolicy('discord', { requireMention: true });
    await flush();

    const evt = events[0];
    expect(evt).toBeDefined();
    expect((evt.data as { surfaceKind: string }).surfaceKind).toBe('discord');
    expect((evt.data as { surfaceId: string }).surfaceId).toBe('discord');
  });

  it('includes changedFields derived from the patch keys', async () => {
    await manager.upsertPolicy('slack', { enabled: false, requireMention: true });
    await flush();

    const evt = events[0];
    const changedFields = (evt.data as { changedFields: string[] }).changedFields;
    expect(changedFields).toContain('enabled');
    expect(changedFields).toContain('requireMention');
  });

  it('emits one event per upsertPolicy call', async () => {
    await manager.upsertPolicy('slack', { enabled: true });
    await manager.upsertPolicy('slack', { requireMention: false });
    await manager.upsertPolicy('ntfy', { enabled: true });
    await flush();

    expect(events).toHaveLength(3);
  });

  it('does not emit when no runtimeBus is configured', async () => {
    const nobusMgr = new ChannelPolicyManager({ store: makeMemoryStore() });
    const neverCalled: unknown[] = [];
    bus.onDomain('surfaces', (e) => neverCalled.push(e));

    await nobusMgr.upsertPolicy('slack', { enabled: true });
    await flush();

    expect(neverCalled).toHaveLength(0);
  });

  it('persists the policy independently of the event emission', async () => {
    const result = await manager.upsertPolicy('telegram', { enabled: false });
    await flush();

    expect(result.surface).toBe('telegram');
    expect(result.enabled).toBe(false);
    // Event should still have fired
    expect(events).toHaveLength(1);
  });

  it('emits SURFACE_POLICY_UPDATED even when updating an existing policy', async () => {
    await manager.upsertPolicy('slack', { enabled: true });
    await flush();
    events.length = 0; // reset

    await manager.upsertPolicy('slack', { requireMention: true });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('SURFACE_POLICY_UPDATED');
  });

  it('attachRuntimeBus wires bus after construction', async () => {
    const lateMgr = new ChannelPolicyManager({ store: makeMemoryStore() });
    const lateBus = new RuntimeEventBus();
    const lateEvents: CapturedEvent[] = [];
    lateBus.onDomain('surfaces', (envelope) => {
      lateEvents.push({
        domain: 'surfaces',
        type: (envelope.payload as { type: string }).type,
        data: envelope.payload as Record<string, unknown>,
      });
    });

    lateMgr.attachRuntimeBus(lateBus);
    await lateMgr.upsertPolicy('slack', { enabled: true });
    await flush();

    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0].type).toBe('SURFACE_POLICY_UPDATED');
  });
});
