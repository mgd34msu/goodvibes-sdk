# Auth architecture

> Internal source map. For consumer guidance see [Authentication](./authentication.md).

Auth is split between client token handling and daemon route enforcement.

Client-facing code uses token stores and transport middleware. Two public subpaths are available:
- `@pellux/goodvibes-sdk/auth`: token storage helpers, auth flows, and the `GoodVibesTokenStore` interface. Use this for most application code. It also re-exports the OAuth payload types (`OAuthStartState`, `OAuthTokenPayload`) for typing acquired tokens.
- `@pellux/goodvibes-sdk/client-auth`: low-level authentication primitives (`AutoRefreshCoordinator`, `PermissionResolver`, `SessionManager`, `TokenStore`, auto-refresh options). Use this only when you need fine-grained control over refresh timing, permission resolution, or session handling. Platform-specific secure token stores are not exposed here. They are available via `@pellux/goodvibes-sdk/expo` (`createExpoSecureTokenStore`) and `@pellux/goodvibes-sdk/react-native` (`createIOSKeychainTokenStore`, `createAndroidKeystoreTokenStore`).

Daemon-facing code resolves principals, scopes, sessions, and admin requirements. Transport
helpers do not read process-wide config or environment state implicitly; callers
provide tokens, token stores, or resolvers.

## Principal kinds

The daemon recognizes three principal kinds:

- **Operator.** The human user running the daemon. Holds full admin rights and
  is identified by the bootstrap token or a long-lived operator session cookie.
- **Companion.** A paired companion app or remote surface. Identified by a
  companion bearer token stored in `daemonHomeDir/operator-tokens.json`.
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
the in-memory token registry and returns the principal or `null`. Routes that
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
owns tokens. Token storage is a transport-layer concern. The daemon token
file `operator-tokens.json` (managed by the `companion-token.ts` helpers)
holds the companion/operator bearer-token record (`{ token, peerId, createdAt }`)
only; session tokens are in-memory and are not persisted to disk. This token
file lives under `daemonHomeDir` (default `~/.goodvibes/daemon/`) so the
bearer token survives workspace swaps.

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
