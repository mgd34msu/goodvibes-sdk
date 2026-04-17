import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

const snapshot = await sdk.operator.control.snapshot();
console.log(JSON.stringify(snapshot, null, 2));
