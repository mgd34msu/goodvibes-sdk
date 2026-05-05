/**
 * provider-sse-integration.test.ts
 *
 * Exercises the real SSE plumbing end-to-end.
 *
 * - Constructs a real ControlPlaneGateway with an in-memory RuntimeEventBus
 * - Opens a live SSE event stream via gateway.createEventStream()
 * - Emits a MODEL_CHANGED envelope on the runtime bus while reading the stream
 * - Asserts exactly ONE SSE frame arrives with domain 'providers' carrying the
 *   MODEL_CHANGED payload
 *
 * The cheap "DEFAULT_DOMAINS includes 'providers'" sanity check is also retained.
 */

import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway, DEFAULT_DOMAINS_TEST_EXPORT } from '../packages/sdk/src/platform/control-plane/gateway.js';
import { RuntimeEventBus, createEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { RuntimeEventDomain } from '../packages/sdk/src/platform/runtime/events/index.js';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// DEFAULT_DOMAINS includes 'providers' (cheap sanity check)
// ---------------------------------------------------------------------------

describe('gateway DEFAULT_DOMAINS', () => {
  test("includes 'providers' domain so MODEL_CHANGED reaches companion SSE subscribers", () => {
    const domains: readonly RuntimeEventDomain[] = DEFAULT_DOMAINS_TEST_EXPORT;
    expect(domains).toContain('providers');
  });

  test("includes core session domains", () => {
    const domains: readonly RuntimeEventDomain[] = DEFAULT_DOMAINS_TEST_EXPORT;
    expect(domains).toContain('session');
    expect(domains).toContain('tasks');
    expect(domains).toContain('control-plane');
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end SSE test
// ---------------------------------------------------------------------------

describe('ControlPlaneGateway SSE — real end-to-end', () => {
  test('MODEL_CHANGED emitted on bus arrives as exactly one SSE frame on the providers domain', async () => {
    const bus = new RuntimeEventBus();
    const gateway = new ControlPlaneGateway({ runtimeBus: bus });

    // AbortController lets us cleanly close the stream after receiving the frame
    const abort = new AbortController();

    const req = new Request('http://localhost/api/companion/chat/sessions/test-session/events', {
      signal: abort.signal,
    });

    const response = gateway.createEventStream(req, {
      clientId: 'test-client',
      clientKind: 'web',
      sessionId: 'test-session',
      label: 'test',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Collect received frames (event:, data: pairs)
    const received: Array<{ event: string; data: unknown }> = [];
    let buffer = '';

    // Promise resolves when we see at least one 'providers' domain frame
    const modelChangedPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for MODEL_CHANGED SSE frame'));
      }, 5000);

      async function readLoop(): Promise<void> {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Parse complete SSE events (separated by \n\n)
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const lines = part.split('\n').filter(Boolean);
              let event = '';
              let data = '';
              for (const line of lines) {
                if (line.startsWith('event: ')) event = line.slice(7).trim();
                else if (line.startsWith('data: ')) data = line.slice(6).trim();
              }
              if (event && data) {
                let parsed: unknown;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                received.push({ event, data: parsed });
                if (event === 'providers') {
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              }
            }
          }
        } catch (err) {
          // Stream aborted after we found what we needed — that's fine
          if ((err as Error).name === 'AbortError') {
            clearTimeout(timeout);
            resolve();
          } else {
            clearTimeout(timeout);
            reject(err);
          }
        }
      }

      void readLoop();
    });

    // Wait a tick for subscriptions to register, then emit the event.
    await settleEvents(10);

    const envelope = createEventEnvelope('MODEL_CHANGED', {
      type: 'MODEL_CHANGED',
      registryKey: 'inception:mercury-2',
      provider: 'inception',
    }, { sessionId: 'test-session', source: 'test', traceId: 'test-trace' });

    bus.emit('providers', envelope);

    // Wait for the frame to arrive
    await modelChangedPromise;

    // Abort the stream cleanly
    abort.abort();

    // Give the teardown a moment.
    await settleEvents(10);

    // Assert exactly ONE 'providers' domain frame was received (the MODEL_CHANGED one)
    const providerFrames = received.filter((f) => f.event === 'providers');
    expect(providerFrames).toHaveLength(1);

    const frame = providerFrames[0]!;
    const frameData = frame.data as Record<string, unknown>;

    // Validates serializeEnvelope output
    expect(frameData['type']).toBe('MODEL_CHANGED');
    expect((frameData['payload'] as Record<string, unknown>)?.['registryKey']).toBe('inception:mercury-2');
    expect((frameData['payload'] as Record<string, unknown>)?.['provider']).toBe('inception');
    expect(typeof frameData['traceId']).toBe('string');
    expect(typeof frameData['ts']).toBe('number');
    expect(Object.hasOwn(frameData, 'timestamp')).toBe(false);
  });
});
