import { ConfigurationError } from '@pellux/goodvibes-errors';
import {
  createGoodVibesSdk,
  type GoodVibesSdkOptions,
  type GoodVibesSdk,
} from './client.js';

/**
 * Options for {@link createBrowserGoodVibesSdk}.
 *
 * Extends {@link GoodVibesSdkOptions} with browser-friendly defaults:
 * - `baseUrl` is optional and defaults to `location.origin`.
 * - `fetch` and `WebSocketImpl` default to the browser globals.
 *
 * This is the canonical options type for the browser entrypoint
 * (`@pellux/goodvibes-sdk/browser`). The web entrypoint
 * (`@pellux/goodvibes-sdk/web`) exposes the same shape as
 * `WebGoodVibesSdkOptions` — a named alias retained for ergonomic imports.
 */
export interface BrowserGoodVibesSdkOptions
  extends Omit<GoodVibesSdkOptions, 'baseUrl' | 'fetch' | 'WebSocketImpl'> {
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly WebSocketImpl?: typeof WebSocket | undefined;
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

/**
 * Create a GoodVibes SDK instance for browser environments.
 *
 * Differences from `createGoodVibesSdk`:
 * - `baseUrl` defaults to `location.origin` when omitted.
 * - HTTP retry and realtime reconnect are pre-configured with
 *   browser-appropriate defaults.
 * - Relies on the native browser `fetch` and `WebSocket` globals; pass
 *   `options.fetch` / `options.WebSocketImpl` to override.
 *
 * @example
 * // Example only: baseUrl defaults to location.origin in a real browser app.
 * import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';
 *
 * const sdk = createBrowserGoodVibesSdk({
 *   authToken: sessionStorage.getItem('gv-token') ?? undefined,
 * });
 *
 * const agents = await sdk.operator.agents.list();
 */
export { forSession } from './_companion-realtime.js';

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
      ...(options.realtime ?? {}),
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
    },
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
    ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
  });
}
