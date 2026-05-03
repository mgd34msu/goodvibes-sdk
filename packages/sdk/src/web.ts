import {
  createBrowserGoodVibesSdk,
  type BrowserGoodVibesSdkOptions,
} from './browser.js';
import type { GoodVibesSdk } from './client.js';

export interface WebGoodVibesSdkOptions extends BrowserGoodVibesSdkOptions {}

/**
 * Create a GoodVibes SDK instance from the web-specific entrypoint.
 */
export { forSession } from './transport-realtime.js';

export function createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {}): GoodVibesSdk {
  return createBrowserGoodVibesSdk(options);
}
