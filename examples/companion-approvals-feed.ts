import { createBrowserGoodVibesSdk } from '@goodvibes/sdk/browser';

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

const pollHandle = globalThis.setInterval(() => {
  void refreshApprovals();
}, 15_000);

globalThis.addEventListener?.('beforeunload', () => {
  stopAgentCompleted();
  globalThis.clearInterval?.(pollHandle);
});
