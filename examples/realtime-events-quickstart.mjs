import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';

const sdk = createNodeGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

const events = sdk.realtime.viaSse();

const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log('AGENT_COMPLETED', event);
});

setTimeout(() => {
  unsubscribe();
  console.log('unsubscribed from AGENT_COMPLETED');
}, 30_000);
