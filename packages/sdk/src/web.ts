import {
  createBrowserGoodVibesSdk,
  type BrowserGoodVibesSdkOptions,
} from './browser.js';
import type { GoodVibesSdk } from './client.js';

export interface WebGoodVibesSdkOptions extends BrowserGoodVibesSdkOptions {}

/**
 * Alias for `createBrowserGoodVibesSdk`. Use this entry-point when importing
 * from `@pellux/goodvibes-sdk/web`.
 *
 * @example
 * // Example only: replace with your own auth strategy.
 * import { createWebGoodVibesSdk } from '@pellux/goodvibes-sdk/web';
 *
 * const sdk = createWebGoodVibesSdk({ authToken: myToken });
 * const events = sdk.realtime.viaSse();
 * events.agents.on('AGENT_SPAWNING', ({ agentId }) => console.log(agentId));
 */
export { forSession } from './transport-realtime.js';

export function createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {}): GoodVibesSdk {
  return createBrowserGoodVibesSdk(options);
}
