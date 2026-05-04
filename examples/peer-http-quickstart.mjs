/**
 * Call peer/distributed-runtime endpoints over HTTP using the umbrella SDK.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/peer-http-quickstart.mjs
 */
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const authToken = process.env.GOODVIBES_TOKEN;
if (!authToken) {
  throw new Error('GOODVIBES_TOKEN env var is required (operator bearer token from the daemon).');
}
const sdk = createPeerSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken,
});

// The peer SDK exposes the same capability namespaces documented in docs/public-surface.md:
// 'pairing', 'peer', 'work', and 'operator'. operator.snapshot returns a read-only
// daemon-state view that peers use to align with the operator's view.
const snapshot = await sdk.operator.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
