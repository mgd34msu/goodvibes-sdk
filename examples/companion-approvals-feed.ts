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

// companion-approvals-feed runs in a browser context
window.addEventListener('beforeunload', () => {
  stopAgentCompleted();
});
