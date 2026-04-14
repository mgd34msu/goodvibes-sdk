import { ConfigurationError } from './_internal/errors/index.js';
import {
  createGoodVibesSdk,
  type GoodVibesSdkOptions,
  type GoodVibesSdk,
} from './client.js';

export interface BrowserGoodVibesSdkOptions
  extends Omit<GoodVibesSdkOptions, 'baseUrl' | 'fetch' | 'WebSocketImpl'> {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly WebSocketImpl?: typeof WebSocket;
}

function resolveBrowserBaseUrl(baseUrl?: string): string {
  const explicit = baseUrl?.trim();
  if (explicit) return explicit;
  if (typeof globalThis.location?.origin === 'string' && globalThis.location.origin.trim()) {
    return globalThis.location.origin.trim();
  }
  throw new ConfigurationError(
    'Browser baseUrl is required when location.origin is unavailable.',
  );
}

export function createBrowserGoodVibesSdk(
  options: BrowserGoodVibesSdkOptions = {},
): GoodVibesSdk {
  return createGoodVibesSdk({
    baseUrl: resolveBrowserBaseUrl(options.baseUrl),
    authToken: options.authToken ?? null,
    ...(options.retry ? { retry: options.retry } : {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 1_500,
      },
    }),
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
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
  });
}
