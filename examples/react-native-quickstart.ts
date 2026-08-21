/**
 * Create a React Native client with host-provided token storage.
 */
import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';

// Read from SecureStore in production: await SecureStore.getItemAsync('gv-token')
const token = process.env.GOODVIBES_TOKEN ?? (() => { throw new Error('GOODVIBES_TOKEN env var is required'); })() as string;

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});

const snapshot = await sdk.operator.control.snapshot();
console.log(snapshot);

// The daemon authenticates the WebSocket upgrade request itself; a bare
// `new WebSocket(url)` carries no Authorization header and is answered 401.
// React Native's WebSocket accepts a headers option, so hand the SDK a
// wrapper implementation that attaches the bearer token to the upgrade.
// DOM lib types declare only (url, protocols); React Native's runtime accepts
// a third { headers } options argument, so the constructor is reached through
// a three-argument view of the same signature.
type ReactNativeWebSocketCtor = new (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
) => WebSocket;

const AuthorizedWebSocket = function AuthorizedWebSocket(url: string | URL): WebSocket {
  return new (WebSocket as unknown as ReactNativeWebSocketCtor)(
    String(url),
    [],
    { headers: { Authorization: `Bearer ${token}` } },
  );
} as unknown as typeof WebSocket;

const unsubscribe = sdk.realtime.viaWebSocket(AuthorizedWebSocket as typeof WebSocket).agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent completed', event);
});

const unsubscribeTimer = setTimeout(() => {
  unsubscribe();
}, 60_000);
unsubscribeTimer.unref?.();
