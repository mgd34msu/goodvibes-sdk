/**
 * Subscribe to approval updates from a browser companion surface.
 */
import { createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});

async function refreshApprovals() {
  const approvals = await sdk.operator.approvals.list();
  console.log('approvals', approvals);
}

await refreshApprovals();

const stopAgentCompleted = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', async () => {
  await refreshApprovals();
});

// browser-only example; window is guaranteed by the surrounding HTML host
window.addEventListener('beforeunload', () => {
  stopAgentCompleted();
});
