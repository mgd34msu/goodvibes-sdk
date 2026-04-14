# React Native Integration

Use `@goodvibes/sdk/react-native` for Android and iOS apps.

```ts
import { createReactNativeGoodVibesSdk } from '@goodvibes/sdk/react-native';

const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Realtime

React Native should use WebSocket for realtime:

```ts
const events = sdk.realtime.runtime();
const unsubscribe = events.agents.on('AGENT_COMPLETED', (event) => {
  console.log(event);
});
```

## Notes

- `fetch` can come from the React Native runtime or be injected explicitly.
- `WebSocket` can come from the runtime or be passed through `WebSocketImpl`.
- The default React Native entrypoint prefers WebSocket over SSE because fetch streaming support varies across mobile stacks.
- Provide a token store or `getAuthToken` when token state can rotate during the app session.
- Reconnect after foreground/resume and network transitions.
- Use HTTP for snapshots/mutations and WebSocket for live updates.
- For Expo-managed apps, use [expo-integration.md](./expo-integration.md).
- For native Kotlin or Swift apps, use [android-integration.md](./android-integration.md) and [ios-integration.md](./ios-integration.md).
