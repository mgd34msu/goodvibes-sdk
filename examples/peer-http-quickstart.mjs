/**
 * Call peer/distributed-runtime endpoints over HTTP using the umbrella SDK.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/peer-http-quickstart.mjs
 */
import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const sdk = createPeerSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

// Peer endpoints include operator.snapshot — a read-only view that peers use to align with the operator state.
const snapshot = await sdk.operator.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
