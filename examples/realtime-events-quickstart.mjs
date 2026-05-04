/**
 * Subscribe to runtime events over SSE and clean up the subscription.
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

const events = sdk.realtime.viaSse();

const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log('AGENT_COMPLETED', event);
});

const unsubscribeTimer = setTimeout(() => {
  unsubscribe();
  console.log('unsubscribed from AGENT_COMPLETED');
}, 30_000);
// unref() prevents the timer from keeping the process alive when it is the only pending task.
// This lets Bun/Node exit cleanly after all other async work finishes.
unsubscribeTimer.unref?.();
