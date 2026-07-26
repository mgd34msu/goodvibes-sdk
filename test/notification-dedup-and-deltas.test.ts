/**
 * Notification defects from the "Testing" incident.
 *
 * One inbound message produced 23 notifications: the identical 3-line body was
 * published 14 times and another identical body 5 times, in same-timestamp
 * batches, and the line count per notification climbed 3 -> 10 -> 13 because
 * each one re-sent the entire accumulated log instead of what was new. The
 * click target on all of them was `http://0.0.0.0:3421/...`, which goes
 * nowhere when tapped on a phone.
 *
 * Covers, in order: delta-only progress, identical-body suppression (including
 * under `force`), and the reachable-URL resolution.
 */
import { describe, expect, test } from 'bun:test';
import { ChannelReplyPipeline } from '../packages/sdk/src/platform/channels/reply-pipeline.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { emitAgentProgress } from '../packages/sdk/src/platform/runtime/emitters/index.ts';
import {
  findRoutableHostAddress,
  isWildcardHost,
  normalizeReachableBaseUrl,
  resolveReachableBaseUrl,
  type NetworkInterfaceReader,
} from '../packages/sdk/src/platform/utils/reachable-base-url.ts';

// ---------------------------------------------------------------------------
// Delta-only progress + duplicate suppression
// ---------------------------------------------------------------------------

interface Published {
  readonly phase: string;
  readonly text: string;
}

/**
 * Drives the pipeline the way the incident did: real AGENT_PROGRESS events on
 * a real RuntimeEventBus, which is what the workflow chain emitted.
 */
function pipelineHarness(surfaceKind = 'ntfy') {
  const published: Published[] = [];
  let now = 1_000_000;
  const channelPlugins = {
    getRenderPolicy: async () => null,
    render: async (_surface: string, request: { phase: string; text: string }) => {
      published.push({ phase: request.phase, text: request.text });
      return { delivered: true, metadata: {} };
    },
  };
  const bus = new RuntimeEventBus();
  const pipeline = new ChannelReplyPipeline({
    channelPlugins,
    routeBindings: { getBinding: () => undefined },
    runtimeBus: bus,
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

  let sequence = 0;
  return {
    pipeline,
    published,
    advance(ms: number) { now += ms; },
    track(agentId: string) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task: 'Testing',
        createdAt: now,
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    /** Emit one progress event, exactly as the workflow chain does. */
    async progress(agentId: string, text: string) {
      sequence += 1;
      emitAgentProgress(bus, {
        sessionId: 'test-session',
        traceId: `trace-${sequence}`,
        source: 'test',
        agentId,
      }, { agentId, progress: text });
      // The bus dispatch is async; let the pipeline's handler settle.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
    /** Re-publish with no new events, the way the forced workflow path did. */
    async redeliverForced(agentId: string) {
      await pipeline.deliverProgress(agentId, undefined, true);
    },
  };
}

describe('reply pipeline progress', () => {
  test('an identical body is never republished, even when forced', async () => {
    const harness = pipelineHarness();
    harness.track('agent-1');
    // Past the floor below which no progress notification is warranted at all;
    // what this test is about is what happens once one IS warranted.
    harness.advance(45_000);
    await harness.progress('agent-1', 'engineering');
    const afterFirst = harness.published.length;
    expect(afterFirst).toBe(1);

    // The workflow path forced every delivery, which is what turned one chain
    // into 14 copies of one message.
    for (let attempt = 0; attempt < 13; attempt += 1) {
      harness.advance(1_000);
      await harness.redeliverForced('agent-1');
    }

    expect(harness.published.length).toBe(afterFirst);
  });

  test('nothing new to say means nothing is published', async () => {
    const harness = pipelineHarness();
    harness.track('agent-2');
    expect(await harness.pipeline.deliverProgress('agent-2', '', true)).toBeNull();
    expect(harness.published).toHaveLength(0);
  });

  test('an untracked agent publishes nothing', async () => {
    const harness = pipelineHarness();
    expect(await harness.pipeline.deliverProgress('unknown', 'x', true)).toBeNull();
    expect(harness.published).toHaveLength(0);
  });

  test('each published body carries only what is new, not the whole log', async () => {
    const harness = pipelineHarness();
    harness.track('agent-3');
    for (const phase of ['engineering', 'reviewing', 'gating']) {
      harness.advance(30_000);
      await harness.progress('agent-3', phase);
    }

    // The defect signature was a body that grew every time: 3 lines, then 10,
    // then 13. Every body here is one line naming one event.
    expect(harness.published.map((entry) => entry.text)).toEqual(['engineering', 'reviewing', 'gating']);
    for (const entry of harness.published) {
      expect(entry.text.split('\n')).toHaveLength(1);
    }
  });

  test('a repeated event body is published once, not once per emission', async () => {
    const harness = pipelineHarness();
    harness.track('agent-4');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      harness.advance(30_000);
      await harness.progress('agent-4', 'awaiting_gates');
    }
    expect(harness.published.map((entry) => entry.text)).toEqual(['awaiting_gates']);
  });
});

// ---------------------------------------------------------------------------
// Reachable click target
// ---------------------------------------------------------------------------

function interfaces(addresses: Array<{ address: string; family: string; internal: boolean }>): NetworkInterfaceReader {
  return () => ({ eth0: addresses });
}

const LAN: NetworkInterfaceReader = interfaces([
  { address: '127.0.0.1', family: 'IPv4', internal: true },
  { address: '192.168.1.42', family: 'IPv4', internal: false },
]);
const NO_LAN: NetworkInterfaceReader = interfaces([
  { address: '127.0.0.1', family: 'IPv4', internal: true },
]);

describe('isWildcardHost', () => {
  test.each(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '*', '', undefined])('wildcard: %p', (host) => {
    expect(isWildcardHost(host)).toBe(true);
  });

  test.each(['127.0.0.1', 'localhost', '192.168.1.42', 'example.com'])('not wildcard: %p', (host) => {
    expect(isWildcardHost(host)).toBe(false);
  });
});

describe('findRoutableHostAddress', () => {
  test('returns the first non-internal IPv4 address', () => {
    expect(findRoutableHostAddress(LAN)).toBe('192.168.1.42');
  });

  test('skips loopback and link-local', () => {
    expect(findRoutableHostAddress(interfaces([
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '169.254.5.5', family: 'IPv4', internal: false },
    ]))).toBeNull();
  });

  test('a throwing reader yields null rather than propagating', () => {
    expect(findRoutableHostAddress(() => { throw new Error('no interfaces'); })).toBeNull();
  });
});

describe('normalizeReachableBaseUrl', () => {
  test('the reported bad URL is rewritten to this host LAN address', () => {
    expect(normalizeReachableBaseUrl('http://0.0.0.0:3421', 'off-host', LAN)).toBe('http://192.168.1.42:3421');
  });

  test('a wildcard with no LAN address yields null so the click target is omitted', () => {
    expect(normalizeReachableBaseUrl('http://0.0.0.0:3421', 'off-host', NO_LAN)).toBeNull();
  });

  test('loopback is left alone for a link opened on the host itself', () => {
    expect(normalizeReachableBaseUrl('http://127.0.0.1:3421', 'local', LAN)).toBe('http://127.0.0.1:3421');
  });

  test('a real hostname passes through with the trailing slash trimmed', () => {
    expect(normalizeReachableBaseUrl('https://gv.example.com/', 'off-host', LAN)).toBe('https://gv.example.com');
  });

  test.each(['', '   ', 'not a url', undefined])('unusable input yields null: %p', (raw) => {
    expect(normalizeReachableBaseUrl(raw, 'off-host', LAN)).toBeNull();
  });
});

describe('resolveReachableBaseUrl', () => {
  // The control-plane candidate is DERIVED from the bind now, not read from a
  // stored `controlPlane.baseUrl`. A wildcard network bind therefore yields a
  // loopback dial target, which is unusable off-host without a LAN address.
  const wildcardBind = (key: string): unknown => {
    if (key === 'controlPlane.hostMode') return 'network';
    if (key === 'controlPlane.host') return '0.0.0.0';
    if (key === 'controlPlane.port') return 3421;
    return undefined;
  };

  test('falls through to web.publicBaseUrl when the control-plane URL is unusable', () => {
    const reader = {
      get: (key: string) => wildcardBind(key) ?? (key === 'web.publicBaseUrl' ? 'https://gv.example.com' : undefined),
    };
    expect(resolveReachableBaseUrl(reader, 'off-host', NO_LAN)).toBe('https://gv.example.com');
  });

  test('returns undefined when nothing configured is reachable — callers omit the link', () => {
    const reader = {
      get: (key: string) => wildcardBind(key) ?? (key === 'web.publicBaseUrl' ? 'http://0.0.0.0:3423' : undefined),
    };
    expect(resolveReachableBaseUrl(reader, 'off-host', NO_LAN)).toBeUndefined();
  });

  test('prefers the declared external control-plane URL when it is already reachable', () => {
    const reader = {
      get: (key: string) => key === 'controlPlane.publicBaseUrl'
        ? 'https://primary.example.com'
        : key === 'web.publicBaseUrl' ? 'https://secondary.example.com' : undefined,
    };
    expect(resolveReachableBaseUrl(reader, 'off-host', LAN)).toBe('https://primary.example.com');
  });

  test('non-string config values are ignored', () => {
    expect(resolveReachableBaseUrl({ get: () => 42 }, 'off-host', LAN)).toBeUndefined();
  });
});
