import {
  createBrowserGoodVibesSdk,
  type BrowserGoodVibesSdkOptions,
} from './browser.js';
import type { GoodVibesSdk } from './client.js';

export interface WebGoodVibesSdkOptions extends BrowserGoodVibesSdkOptions {}

export function createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {}): GoodVibesSdk {
  return createBrowserGoodVibesSdk(options);
}
