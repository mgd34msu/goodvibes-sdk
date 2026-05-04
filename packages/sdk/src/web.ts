import {
  createBrowserGoodVibesSdk,
  type BrowserGoodVibesSdkOptions,
} from './browser.js';
import type { GoodVibesSdk } from './client.js';

/**
 * Options for {@link createWebGoodVibesSdk}.
 *
 * This type is an alias for {@link BrowserGoodVibesSdkOptions} and carries the
 * same shape. It exists so that code importing from `@pellux/goodvibes-sdk/web`
 * has a semantically accurate name without requiring an empty-interface declaration.
 *
 * Use `WebGoodVibesSdkOptions` when importing from `@pellux/goodvibes-sdk/web`;
 * use {@link BrowserGoodVibesSdkOptions} when importing from
 * `@pellux/goodvibes-sdk/browser`.
 */
export type WebGoodVibesSdkOptions = BrowserGoodVibesSdkOptions;

export { forSession } from './_companion-realtime.js';

/**
 * Create a GoodVibes SDK instance from the web-specific entrypoint.
 */
export function createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {}): GoodVibesSdk {
  return createBrowserGoodVibesSdk(options);
}
