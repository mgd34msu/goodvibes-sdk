/**
 * Subscribe to approval updates from a browser companion surface.
 *
 * Both `@pellux/goodvibes-sdk/browser` and `@pellux/goodvibes-sdk/web` are valid
 * for browser companion code. This example uses `/browser` for explicit browser
 * context; use `/web` when you want web + service-worker defaults.
 */
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});

async function refreshApprovals() {
  // approvals.list() returns paginated results; pass { cursor } from the previous response
  // to page through all records when the list may exceed the default page size.
  const approvals = await sdk.operator.approvals.list();
  console.log('approvals', approvals);
}

await refreshApprovals();

const stopAgentCompleted = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', async () => {
  await refreshApprovals();
});

// window is typed because tsconfig includes lib: 'DOM'; in a browser this works at runtime.
// In a non-browser environment (test, SSR), the guard below skips registration.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopAgentCompleted();
  });
}
