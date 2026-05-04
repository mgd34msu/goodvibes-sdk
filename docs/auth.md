# Auth Architecture

> Internal source map. For consumer guidance see [Authentication](./authentication.md).

Auth is split between client token handling and daemon route enforcement.

Client-facing code uses token stores and transport middleware
(`packages/sdk/src/platform/auth/token-store.ts`). Daemon-facing
code resolves principals, scopes, sessions, and admin requirements. Transport
helpers do not read process-wide config or environment state implicitly; callers
provide tokens, token stores, or resolvers.

## Principal Kinds

The daemon recognizes three principal kinds:

- **Operator** — the human user running the daemon. Holds full admin rights and
  is identified by the bootstrap token or a long-lived operator session cookie.
- **Companion** — a paired companion app or remote surface. Identified by a
  companion bearer token stored in `daemonHomeDir/operator-tokens.json`.
- **Admin** — an internal elevation scope required for destructive routes
  (workspace swap, session delete, config reset). Both operators and companions
  may be granted admin via `requireAdmin`; the daemon can restrict admin to
  operator-only via policy.

## Auth Flow

```
Request → extractAuthToken() → resolveAuthenticatedPrincipal()
       → [requireAdmin()?] → route handler
```

`extractAuthToken` reads the `Authorization: Bearer` header or the operator
session cookie. `resolveAuthenticatedPrincipal` resolves the token against
the in-memory token registry and returns the principal or `null`. Routes that
need admin call `requireAdmin(principal)` before proceeding.

## Session Manager and Token Store Relationship

The `SessionManager` persists session files under `surfaceRoot`. It does not
own tokens — token stores are a transport-layer concern. The token store
(`TokenStore`) holds companion bearer tokens and operator session tokens;
it lives under `daemonHomeDir` (default `~/.goodvibes/daemon/`) so tokens
survive workspace swaps. The `SessionManager` and `TokenStore` are composed
at daemon startup and share no file path.

## Scope Flow

Every route handler receives a resolved principal. Scopes are checked at the
handler boundary, not inside business logic. The three scope checks are:

1. `resolveAuthenticatedPrincipal` — authentication gate (unauthenticated → 401)
2. `requireAuthenticatedSession` — session existence gate (no active session → 401)
3. `requireAdmin` — elevation gate (insufficient rights → 403)

Examples must not print tokens or hardcode real credentials. Test credentials
should be local placeholders or environment-driven.
