# Authentication

Auth is available on both full and companion surfaces. See [Runtime Surfaces](./surfaces.md).

GoodVibes currently exposes two auth modes through the operator contract:
- `shared-bearer`
- `session-login`

## Shared bearer token

Use a bearer token when:
- you are building a server-side integration
- you are calling the daemon/operator API cross-origin
- you are embedding the SDK in automation or service processes
- you are building native mobile clients
- you are building React Native or Expo companion apps

Header shape:

```http
Authorization: Bearer <token>
```

## Session login

Login route from the current contract:

```http
POST /login
```

Request body:

```json
{
  "username": "alice",
  "password": "secret"
}
```

Current-auth route:

```http
GET /api/control-plane/auth
```

Alias:

```http
GET /api/control-plane/whoami
```

Session cookie:
- name: `goodvibes_session`
- `HttpOnly`
- `SameSite=Lax`
- path: `/`

## SDK auth helpers

The umbrella SDK exposes an auth client plus token-store helpers:

```ts
import {
  createGoodVibesSdk,
  createMemoryTokenStore,
} from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(),
});

await sdk.auth.login({
  username: 'alice',
  password: 'secret',
});

console.log(await sdk.auth.current());
```

Useful auth helpers:
- `createMemoryTokenStore()`
- `createBrowserTokenStore()`
- `sdk.auth.login(...)`
- `sdk.auth.current()`
- `sdk.auth.getToken()`
- `sdk.auth.setToken(...)`
- `sdk.auth.clearToken()`

## Recommended auth by environment

- Bun services: bearer token
- Browser web UI on same origin: session cookie or bearer token
- React Native / Expo: bearer token
- Native Android / iOS: bearer token

## Browser token persistence

Use `createBrowserTokenStore()` when you want local-storage-backed bearer token persistence in a browser app:

```ts
import {
  createBrowserGoodVibesSdk,
  createBrowserTokenStore,
} from '@pellux/goodvibes-sdk/browser';

const sdk = createBrowserGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  tokenStore: createBrowserTokenStore(),
});
```

For same-origin web UIs, cookie-backed session auth is often simpler than token persistence.

## Read-only token resolvers

If you pass `getAuthToken`, the SDK can read tokens dynamically for requests and reconnects, but it cannot persist or mutate them unless you also pass `tokenStore`.

That matters for:
- refreshing tokens from an external auth system
- React Native secure storage adapters
- browser apps where another layer owns token persistence

## Scope handling

The SDK preserves structured authorization failures. When a token is missing required scopes, you will receive a structured SDK error with:
- `status`
- `category`
- `source`
- `hint`

For the typed `err.kind` values returned on auth failures (invalid session, expired token, permission denied), see [Error kinds](./error-kinds.md).

Do not rely on message parsing to detect authorization problems.

## Session vs bearer tradeoff

Use session login when:
- the app is same-origin with the daemon
- you want browser cookie/session semantics
- you do not want token persistence logic in the UI

Use bearer auth when:
- the client is cross-origin
- the client is mobile
- the client is a server-side integration
- you need explicit token rotation/storage control
