import {
  createGoodVibesSdk,
  type GoodVibesSdkOptions,
  type GoodVibesSdk,
} from './client.js';

export interface NodeGoodVibesSdkOptions extends GoodVibesSdkOptions {}

/**
 * Create a GoodVibes SDK instance configured for Node.js.
 *
 * Applies Node-friendly defaults on top of `createGoodVibesSdk`:
 * - HTTP retry: 3 attempts, 200 ms base delay, 2 s max.
 * - SSE and WebSocket reconnect enabled (500 ms base, 5 s max).
 *
 * Uses `globalThis.fetch` (available in Node 18+). For older runtimes pass
 * `options.fetch` explicitly.
 *
 * @example
 * // Example only: replace baseUrl and authToken with your own values.
 * import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';
 *
 * const sdk = createNodeGoodVibesSdk({
 *   baseUrl: process.env.GV_BASE_URL!,
 *   authToken: process.env.GV_TOKEN,
 * });
 *
 * const session = await sdk.operator.sessions.create({ name: 'my-session' });
 * console.log(session.id);
 */
export function createNodeGoodVibesSdk(
  options: NodeGoodVibesSdkOptions,
): GoodVibesSdk {
  return createGoodVibesSdk({
    ...options,
    retry: options.retry ?? {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 2_000,
    },
    realtime: {
      sseReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.sseReconnect ?? {}),
      },
      webSocketReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.webSocketReconnect ?? {}),
      },
      ...(options.realtime ?? {}),
    },
  });
}
