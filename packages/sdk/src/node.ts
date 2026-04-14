import {
  createGoodVibesSdk,
  type GoodVibesSdkOptions,
  type GoodVibesSdk,
} from './client.js';

export interface NodeGoodVibesSdkOptions extends GoodVibesSdkOptions {}

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
