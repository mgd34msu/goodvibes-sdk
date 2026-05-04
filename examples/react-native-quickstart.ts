/**
 * Create a React Native client with host-provided token storage.
 */
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  // Read from SecureStore in production: await SecureStore.getItemAsync('gv-token')
  authToken: process.env.GOODVIBES_TOKEN ?? (() => { throw new Error('GOODVIBES_TOKEN env var is required'); })() as string,
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);

const unsubscribe = sdk.realtime.viaWebSocket().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});

const unsubscribeTimer = setTimeout(() => {
  unsubscribe();
}, 60_000);
unsubscribeTimer.unref?.();
