/**
 * Call peer/distributed-runtime endpoints over HTTP using the umbrella SDK.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3210).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/peer-http-quickstart.mjs
 */
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const sdk = createPeerSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

const snapshot = await sdk.operator.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
