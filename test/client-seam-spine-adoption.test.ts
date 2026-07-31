/**
 * client-seam-spine-adoption.test.ts — the reconcile policy behind "the adopted
 * daemon changed".
 *
 * The two surface products drive this from different signals — one has a boot
 * discovery probe and gates on its verdict, the other treats its own connection
 * resolution as the signal and comes up immediately — and the reconcile rules
 * underneath are identical. That is why the timing is an OPTION here rather than
 * a second implementation, and it is what these tests pin: the same
 * idempotency, the same teardown, the same one-time fold, under both timings.
 *
 * The failure being guarded is a mirror that is torn down and put back up on
 * every probe tick. It is not visible as an error — it shows up as sessions
 * flickering out of the cross-surface list and inbound steers landing twice.
 */
import { describe, expect, test } from 'bun:test';
import { createSpineAdoptionSync } from '../packages/sdk/src/platform/runtime/client/spine-adoption.ts';
import type { SpineWireBundle } from '../packages/sdk/src/platform/runtime/client/spine-adoption.ts';

function harness(options: { activation?: 'adopt-on-status' | 'live-immediately' } = {}) {
  const events: string[] = [];
  const connections: string[] = [];
  const bundle = (baseUrl: string): SpineWireBundle => ({
    sessionTransport: { register: async () => ({ outcome: 'ok' }) as never, close: async () => ({ outcome: 'ok' }) as never },
    inboundInputs: { listInputs: async () => ({ inputs: [] }) as never, deliverInput: async () => ({}) },
    sessionList: { list: async () => [] },
    memoryTransport: { marker: baseUrl } as never,
  });

  const sync = createSpineAdoptionSync({
    sessionSpine: {
      activate: () => { events.push('session:activate'); },
      deactivate: (reason) => { events.push(`session:deactivate(${reason})`); },
      foldLegacyRecords: () => ({ folded: 0 }) as never,
    },
    memorySpine: {
      activate: () => { events.push('memory:activate'); },
      deactivate: () => { events.push('memory:deactivate'); },
    },
    sessionInboundInputs: {
      activate: () => { events.push('inbound:activate'); },
      deactivate: () => { events.push('inbound:deactivate'); },
    },
    sessionUnionCache: {
      activate: () => { events.push('union:activate'); },
      deactivate: () => { events.push('union:deactivate'); },
    },
    connect: (baseUrl) => { connections.push(baseUrl); return bundle(baseUrl); },
    // A path nothing wrote, so the fold is a no-op and this suite touches no disk.
    legacyStorePath: '/nonexistent/spine-adoption-test/sessions.json',
    workingDirectory: '/nonexistent/spine-adoption-test',
    onAdopted: () => { events.push('adopted'); },
    onDetached: () => { events.push('detached'); },
    log: { info: () => { /* quiet */ }, debug: () => { /* quiet */ } },
    ...(options.activation ? { activation: options.activation } : {}),
  });
  return { sync, events, connections };
}

describe('adopting a daemon, and doing it once', () => {
  test('adoption wires every seam that is meaningless without a daemon', () => {
    const h = harness();
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    expect(h.events).toEqual([
      'memory:activate', 'session:activate', 'inbound:activate', 'adopted', 'union:activate',
    ]);
  });

  test('re-running against the SAME daemon changes nothing', () => {
    const h = harness();
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    const after = h.events.length;
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    // A re-probe after an autostart must not tear a live mirror down and put it
    // back up: that is what makes sessions flicker and steers arrive twice.
    expect(h.events).toHaveLength(after);
    expect(h.connections).toEqual(['http://127.0.0.1:39471']);
  });

  test('a daemon that moved is torn down before the new one comes up', () => {
    const h = harness();
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    h.events.length = 0;
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39472' }, 'token-2');
    expect(h.events[0]).toBe('memory:deactivate');
    expect(h.events).toContain('detached');
    expect(h.events).toContain('session:activate');
    expect(h.connections).toEqual(['http://127.0.0.1:39471', 'http://127.0.0.1:39472']);
  });

  test('losing the daemon detaches everything and mirrors nowhere', () => {
    const h = harness();
    h.sync({ mode: 'external', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    h.events.length = 0;
    h.sync({ mode: 'unavailable', baseUrl: '' }, '');
    expect(h.events).toContain('memory:deactivate');
    expect(h.events).toContain('detached');
    expect(h.events).toContain('union:deactivate');
    expect(h.events.some((event) => event.startsWith('session:deactivate'))).toBe(true);
  });

  test('with nothing ever adopted, a non-external verdict wires nothing and connects nowhere', () => {
    const h = harness();
    h.sync({ mode: 'disabled', baseUrl: '' }, '');
    expect(h.events).toEqual(['union:deactivate']);
    expect(h.connections).toEqual([]);
  });
});

describe('the one product choice: when the wire comes up', () => {
  test('adopt-on-status waits for the probe to say external', () => {
    const h = harness({ activation: 'adopt-on-status' });
    // A base URL is known, but the probe has not confirmed a daemon answers on
    // it. A surface that can render "no daemon" honestly gates on that.
    h.sync({ mode: 'unavailable', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    expect(h.connections).toEqual([]);
  });

  test('live-immediately wires on the base URL it was handed', () => {
    const h = harness({ activation: 'live-immediately' });
    // A surface with no discovery probe treats its own connection resolution as
    // the signal, and lets the spine client's reachability handling deal with a
    // daemon that turns out not to be there.
    h.sync({ mode: 'unknown', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    expect(h.connections).toEqual(['http://127.0.0.1:39471']);
    expect(h.events).toContain('session:activate');
  });

  test('live-immediately still detaches when the base URL goes away', () => {
    const h = harness({ activation: 'live-immediately' });
    h.sync({ mode: 'unknown', baseUrl: 'http://127.0.0.1:39471' }, 'token-1');
    h.events.length = 0;
    h.sync({ mode: 'unknown', baseUrl: '' }, '');
    expect(h.events).toContain('detached');
  });
});
