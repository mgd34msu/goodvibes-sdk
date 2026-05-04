import {
  createBrowserGoodVibesSdk,
  type BrowserGoodVibesSdkOptions,
} from './browser.js';
import type { GoodVibesSdk } from './client.js';

// WebGoodVibesSdkOptions is intentionally identical to BrowserGoodVibesSdkOptions.
// A type alias avoids the empty-interface lint warning while preserving a
// distinct public name in the web entrypoint.
export type WebGoodVibesSdkOptions = BrowserGoodVibesSdkOptions;

export { forSession } from './transport-realtime.js';

/**
 * Create a GoodVibes SDK instance from the web-specific entrypoint.
 */
export function createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {}): GoodVibesSdk {
  return createBrowserGoodVibesSdk(options);
}
