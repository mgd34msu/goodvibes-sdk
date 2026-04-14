import { createBrowserGoodVibesSdk } from '@goodvibes/sdk/browser';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
});

await sdk.operator.control.snapshot();

const unsubscribe = sdk.realtime.viaSse().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});

window.addEventListener('beforeunload', () => {
  unsubscribe();
});
