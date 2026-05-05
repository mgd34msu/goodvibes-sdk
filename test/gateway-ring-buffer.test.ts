/**
 * gateway.recentMessages ring-buffer tests.
 *
 * Verifies that:
 *  1. The RingBuffer<T> utility class has correct O(1) bounded semantics.
 *  2. ControlPlaneGateway.publishSurfaceMessage is bounded at 200 entries.
 *  3. listSurfaceMessages returns newest-first order (matches prior unshift behaviour).
 *  4. getSnapshot().totals.surfaceMessages reflects actual ring size (capped at 200).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { RingBuffer } from '../packages/sdk/src/platform/utils/ring-buffer.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';

// ---------------------------------------------------------------------------
// RingBuffer unit tests
// ---------------------------------------------------------------------------

describe('RingBuffer', () => {
  it('starts empty', () => {
    const rb = new RingBuffer<number>(4);
    expect(rb.size).toBe(0);
    expect(rb.isEmpty).toBe(true);
    expect(rb.toArray()).toEqual([]);
  });

  it('stores items in insertion order', () => {
    const rb = new RingBuffer<number>(4);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.size).toBe(3);
  });

  it('evicts oldest entry when full (FIFO)', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    // Buffer full — push evicts 1
    rb.push(4);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it('exposes eviction count and evicted entries', () => {
    const evicted: number[] = [];
    const rb = new RingBuffer<number>(2, { onEvict: (item) => evicted.push(item) });
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.evictedCount).toBe(2);
    expect(evicted).toEqual([1, 2]);
    expect(rb.toArray()).toEqual([3, 4]);
  });

  it('keeps size bounded at capacity after many pushes', () => {
    const cap = 5;
    const rb = new RingBuffer<number>(cap);
    for (let i = 0; i < 1000; i++) rb.push(i);
    expect(rb.size).toBe(cap);
    // Most recent 5 values: 995..999
    expect(rb.toArray()).toEqual([995, 996, 997, 998, 999]);
  });

  it('takeLastReversed returns newest first', () => {
    const rb = new RingBuffer<number>(10);
    for (let i = 1; i <= 5; i++) rb.push(i);
    // newest-first: 5, 4, 3, ...
    expect(rb.takeLastReversed(3)).toEqual([5, 4, 3]);
  });

  it('takeLastReversed with n >= size returns all entries newest-first', () => {
    const rb = new RingBuffer<number>(10);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.takeLastReversed(100)).toEqual([3, 2, 1]);
  });

  it('takeLast returns newest-last slice', () => {
    const rb = new RingBuffer<number>(10);
    for (let i = 1; i <= 6; i++) rb.push(i);
    expect(rb.takeLast(3)).toEqual([4, 5, 6]);
  });

  it('clear resets state, preserving capacity', () => {
    const rb = new RingBuffer<number>(4);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.isEmpty).toBe(true);
    expect(rb.evictedCount).toBe(0);
    expect(rb.capacity).toBe(4);
    rb.push(99);
    expect(rb.toArray()).toEqual([99]);
  });

  it('throws RangeError for capacity < 1', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
  });

  it('works at capacity boundary (single slot)', () => {
    const rb = new RingBuffer<string>(1);
    rb.push('a');
    rb.push('b');
    expect(rb.size).toBe(1);
    expect(rb.toArray()).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// ControlPlaneGateway.recentMessages ring-buffer integration tests
// ---------------------------------------------------------------------------

function makeGateway(): ControlPlaneGateway {
  return new ControlPlaneGateway();
}

function pushMessages(gateway: ControlPlaneGateway, count: number): void {
  for (let i = 0; i < count; i++) {
    gateway.publishSurfaceMessage({
      kind: 'info',
      text: `msg-${i}`,
    });
  }
}

describe('ControlPlaneGateway — recentMessages ring buffer', () => {
  let gateway: ControlPlaneGateway;

  beforeEach(() => {
    gateway = makeGateway();
  });

  it('starts with zero surface messages', () => {
    expect(gateway.listSurfaceMessages()).toEqual([]);
  });

  it('stores messages up to the limit', () => {
    pushMessages(gateway, 5);
    const msgs = gateway.listSurfaceMessages(10);
    expect(msgs).toHaveLength(5);
  });

  it('listSurfaceMessages returns newest-first', () => {
    pushMessages(gateway, 3);
    const msgs = gateway.listSurfaceMessages(10);
    // Newest (msg-2) should be first
    expect(msgs[0]!.text).toBe('msg-2');
    expect(msgs[1]!.text).toBe('msg-1');
    expect(msgs[2]!.text).toBe('msg-0');
  });

  it('is hard-bounded at 200 entries', () => {
    pushMessages(gateway, 300);
    const all = gateway.listSurfaceMessages(300);
    expect(all.length).toBe(200);
  });

  it('evicts oldest entries after overflow (FIFO)', () => {
    // Push 201 messages; oldest (msg-0) should be evicted
    pushMessages(gateway, 201);
    const msgs = gateway.listSurfaceMessages(201);
    expect(msgs).toHaveLength(200);
    // Newest first: msg-200
    expect(msgs[0]!.text).toBe('msg-200');
    // Oldest retained: msg-1 (msg-0 was evicted)
    expect(msgs[199]!.text).toBe('msg-1');
  });

  it('getSnapshot().totals.surfaceMessages reflects bounded count', () => {
    pushMessages(gateway, 250);
    const snap = gateway.getSnapshot() as { totals: { surfaceMessages: number } };
    expect(snap.totals.surfaceMessages).toBe(200);
  });

  it('limit parameter on listSurfaceMessages is respected', () => {
    pushMessages(gateway, 50);
    const msgs = gateway.listSurfaceMessages(10);
    expect(msgs).toHaveLength(10);
    // Newest first: msg-49
    expect(msgs[0]!.text).toBe('msg-49');
  });

  it('each message has required id and createdAt fields', () => {
    pushMessages(gateway, 1);
    const [msg] = gateway.listSurfaceMessages(1);
    expect(typeof msg!.id).toBe('string');
    expect(msg!.id.startsWith('cpmsg-')).toBe(true);
    expect(typeof msg!.createdAt).toBe('number');
  });
});
