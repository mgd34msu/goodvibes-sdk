import { createPeerSdk } from '@pellux/goodvibes-sdk/peer';

const sdk = createPeerSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_PEER_TOKEN ?? null,
});

const snapshot = await sdk.operator.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
