# Expo Integration

Use `@goodvibes/sdk/expo` for Expo-managed React Native apps.

```ts
import { createExpoGoodVibesSdk } from '@goodvibes/sdk/expo';

const sdk = createExpoGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
});
```

## Guidance

- prefer bearer tokens for Expo apps
- store tokens in `expo-secure-store` or equivalent secure storage
- prefer `sdk.realtime.runtime()` / WebSocket-backed realtime over SSE
- reconnect on foreground/resume transitions
- wrap token access in a `tokenStore` or `getAuthToken` so reconnects do not keep stale tokens

## Typical Expo shape

- login or bootstrap the token once
- hydrate the SDK from secure storage on app start
- load initial operator snapshots over HTTP
- subscribe to WebSocket runtime events for companion-app updates
- refresh read models after important events or foreground resumes

## Example

See [expo-quickstart.tsx](../examples/expo-quickstart.tsx).
