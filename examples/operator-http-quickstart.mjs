/**
 * Call operator endpoints over HTTP using the umbrella SDK.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/operator-http-quickstart.mjs
 */
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const authToken = process.env.GOODVIBES_TOKEN;
if (!authToken) {
  throw new Error('GOODVIBES_TOKEN env var is required (operator bearer token from the daemon).');
}
const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken,
});

const snapshot = await sdk.operator.control.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
