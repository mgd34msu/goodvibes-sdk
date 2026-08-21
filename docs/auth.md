# Auth architecture

> Internal source map. For consumer guidance see [Authentication](./authentication.md).

Auth is split between client token handling and daemon route enforcement.

Client-facing code uses token stores and transport middleware. Two public subpaths are available:
- `@pellux/goodvibes-sdk/auth`: token storage helpers, auth flows, and the `GoodVibesTokenStore` interface. Use this for most application code. It also re-exports the OAuth payload types (`OAuthStartState`, `OAuthTokenPayload`) for typing acquired tokens.
- `@pellux/goodvibes-sdk/client-auth`: low-level authentication primitives. Use this only when you need fine-grained control over refresh timing, permission resolution, or session handling. Platform-specific secure token stores are not exposed here. They are available via `@pellux/goodvibes-sdk/expo` (`createExpoSecureTokenStore`) and `@pellux/goodvibes-sdk/react-native` (`createIOSKeychainTokenStore`, `createAndroidKeystoreTokenStore`).

The client-auth primitives each own one slice of the auth lifecycle.

| Primitive | What it does |
| --- | --- |
| `TokenStore` | The persistence contract for tokens: `getToken`, `setToken`, `clearToken` |
| `SessionManager` | Login, current-principal reads, and logout against the daemon auth routes |
| `PermissionResolver` | Resolves the control-plane auth snapshot, including the principal id and granted scopes |
| `AutoRefreshCoordinator` | Schedules token refresh ahead of expiry, with configurable leeway, and feeds the refresh middleware |

Daemon-facing code resolves principals, scopes, sessions, and admin requirements. Transport
helpers do not read process-wide config or environment state implicitly; callers
provide tokens, token stores, or resolvers.

## Principal kinds

The daemon recognizes three conceptual principal kinds:

- **Operator.** The human user running the daemon. Holds full admin rights and
  is identified by the bootstrap token or a long-lived operator session cookie.
- **Companion.** A paired companion app or remote surface. A companion
  authenticates with one of two token shapes, checked in this order by
  `authenticateOperatorToken`:
  1. A **per-pairing token**, a named, individually-revocable token minted for
     one device (`PairingTokenManager`, stored hashed under
     `<surfaceRoot>/control-plane/pairing-tokens.json`). This is the current
     pairing mechanism; see [Companion app pairing](./pairing.md).
  2. The **legacy shared token**, one bearer token every companion held before
     per-device pairing existed, stored in `daemonHomeDir/operator-tokens.json`.
     It keeps authenticating until an operator explicitly revokes it
     (`pairing.tokens.revokeShared`).
  Both shapes carry full operator authority, identically to the bootstrap
  token; `isOperatorAdmin()` returns true for either.
- **Admin.** An internal elevation scope required for destructive routes
  (workspace swap, session delete, config reset). Both operators and companions
  may be granted admin via `requireAdmin`; the daemon can restrict admin to
  operator-only via policy.

> **Conceptual vs typed:** Operator, Companion, and Admin above are *conceptual* principal categories used by route enforcement. They describe who is calling and what rights they hold. They are distinct from the typed `principalKind` enum on `AuthenticatedPrincipal` (`'user' | 'bot' | 'service' | 'token'`, defined in the contracts as `ControlAuthCurrentResponse.principalKind`), which classifies the credential's principal type rather than its privilege tier.

## Auth flow

```
Request → extractAuthToken() → resolveAuthenticatedPrincipal()
       → [requireAdmin()?] → route handler
```

`extractAuthToken` (internal helper) reads the `Authorization: Bearer` header or the operator
session cookie. `resolveAuthenticatedPrincipal` resolves the token against
the in-memory token registry and returns the principal or `null`. The registry checks a
presented token in this order, a per-pairing token first, then the legacy shared token
(unless it has been revoked), then a user session. Routes that
need admin call `requireAdmin(principal)` before proceeding.

## Session manager and token store relationship

This `SessionManager` is the daemon/runtime conversation session manager
(`packages/sdk/src/platform/sessions/manager.ts`); its constructor accepts a
`surfaceRoot` option and persists session files under that scoped directory. It is
*distinct* from the client-auth `SessionManager` primitive listed under the
client-facing subpaths above (`packages/sdk/src/client-auth/session-manager.ts`),
which only drives the login/current/logout lifecycle and never touches
`surfaceRoot` or persists session files.

Neither `SessionManager`
owns tokens. Token storage is a transport-layer concern. The legacy shared token
file `operator-tokens.json` (managed by the `companion-token.ts` helpers)
holds the companion/operator bearer-token record (`{ token, peerId, createdAt }`)
only; a separate `pairing-tokens.json` (managed by `pairing-token-store.ts`) holds the
current per-device pairing tokens, hashed. Session tokens are in-memory and are not
persisted to disk. The legacy token file lives under `daemonHomeDir` (default
`~/.goodvibes/daemon/`) so the bearer token survives workspace swaps.

The daemon/runtime conversation
`SessionManager` and the daemon token file are composed at daemon startup and
share no file path.

## Scope flow

Every route handler receives a resolved principal. Scopes are checked at the
handler boundary, not inside business logic. The three scope checks are:

1. `resolveAuthenticatedPrincipal`: authentication gate (unauthenticated → 401) *(public via `@pellux/goodvibes-sdk/daemon`)*
2. `requireAuthenticatedSession`: session existence gate (no active session → 401) *(internal)*
3. `requireAdmin`: elevation gate (insufficient rights → 403) *(internal)*

For the typed `err.kind` values surfaced on auth and scope failures (invalid session, expired token, permission denied), see [Error kinds](./error-kinds.md).

Examples must not print tokens or hardcode real credentials. Test credentials
should be local placeholders or environment-driven.
