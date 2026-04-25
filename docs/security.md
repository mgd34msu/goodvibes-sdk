# GoodVibes SDK — Security Best Practices

> **Surface scope:** This document describes the security model for the **full surface (Bun runtime)**. Companion consumers (React Native, browser, Hermes) operate through the subset of the security stack exposed via `./react-native`, `./browser`, and related companion-surface barrels. See [Runtime Surfaces](./surfaces.md) for the full surface breakdown.

This guide covers the security model of the GoodVibes daemon and SDK. It is intended for operators embedding the daemon, developers building surfaces, and anyone configuring authentication for production deployments.

For vulnerability reporting, see [`SECURITY.md`](../SECURITY.md) at the repo root.

---

## Authentication Modes

The daemon supports two authentication modes. The active mode is determined by how the daemon is configured at startup.

### Shared Bearer Token

**When to use:** local development, single-user deployments, service-to-service connections where you control both ends.

A single static token is configured. Every request that presents this token is granted full access. Authentication is performed with a constant-time comparison (`timingSafeEqual`) to prevent timing attacks:

```ts
function matchesSharedToken(token: string, sharedToken: string): boolean {
  if (token.length !== sharedToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(sharedToken));
}
```

**Implications:**
- No user concept; all requests are effectively admin
- Token exposure means full daemon compromise
- Suitable only when network access to the daemon is already restricted (localhost, private LAN, VPN)
- Do not use in multi-user environments

### Session Login

**When to use:** multi-user deployments, web UI access, companion apps where individual identity matters.

Users authenticate with a username and password via the login endpoint. On success, the daemon issues a session token (random 32-byte hex string). Subsequent requests present this token as a bearer credential or in the `goodvibes_session` cookie.

`UserAuthManager` (`security/user-auth.ts`) manages the user store and sessions:
- Passwords are hashed with **scrypt** (64-byte key, random salt), stored as `salt:hash` in base64
- Default session TTL is **1 hour** (`DEFAULT_SESSION_TTL_MS = 3_600_000`)
- Sessions are pruned on access; expired sessions are rejected and cleaned up
- On first boot with no user store, the daemon bootstraps a default admin account and writes a plaintext credential file for initial login; this file should be deleted after the first login

Session tokens are carried as:
1. `Authorization: Bearer <token>` header
2. `goodvibes_session` cookie (HTTP-only, SameSite=Lax, Secure when on HTTPS)

The cookie is set with `buildOperatorSessionCookie()` and cleared with `buildExpiredOperatorSessionCookie()`.

**Role model:**
- Users may have any combination of string roles
- `isOperatorAdmin()` returns true for shared-token requests OR for session users with the `admin` role
- Admin-gated routes call `requireElevatedAccess` before proceeding

---

## Token Management

### Spawn Tokens

`SpawnTokenManager` (`security/spawn-tokens.ts`) governs sub-agent spawning. When the orchestrator spawns an agent, it issues a cryptographically signed `SpawnToken`:

```ts
interface SpawnToken {
  type: 'orchestrator' | 'agent';
  sessionId: string;
  issuedTo: string;     // agent ID
  issuedBy: string;     // issuing agent or orchestrator ID
  depth: number;        // current nesting depth
  maxDepth: number;     // configured depth limit
  canGenerate: boolean; // whether this token may generate child tokens
  expiresAt: number;    // epoch ms expiry
  signature: string;    // HMAC-SHA256 over the token fields
}
```

Tokens are signed with a per-session HMAC secret. Before spawning, `canSpawn()` validates:
1. Token signature is valid
2. Token has not expired (default TTL: 1 hour)
3. Nesting depth is within the configured `maxDepth`
4. Total active agent count is within `maxActiveAgents`
5. Recursion is enabled in the `OrchestrationPolicyConfig` (if depth > 0)

Tokens can be revoked by signature via `revoke(tokenSignature)`. Revoked tokens are rejected even if unexpired.

### API Token Auditing

`ApiTokenAuditor` (`security/token-audit.ts`) enforces scope minimization and rotation cadence for registered API tokens (LLM provider keys, integration credentials, etc.).

**Two audit dimensions:**

1. **Scope audit** — each token is evaluated against its `TokenScopePolicy`. Tokens holding scopes outside `allowedScopes` are flagged as violations.
2. **Rotation audit** — tokens are checked against the policy's `rotationCadenceMs` (default: **90 days**). A warning is emitted when `msUntilDue ≤ rotationWarningThresholdMs` (default: **14 days**). When overdue, the token is flagged.

**Managed vs advisory mode:**

| Mode | Behavior |
|---|---|
| `managed: true` | Tokens with scope violations or overdue rotation are **blocked** from use |
| `managed: false` | Violations are reported via `SecurityEvent` emissions but tokens remain usable |

```ts
const auditor = new ApiTokenAuditor({ managed: true });
auditor.registerPolicy({
  id: 'openai',
  name: 'OpenAI API',
  allowedScopes: ['completions:write', 'models:read'],
  rotationCadenceMs: 90 * 24 * 60 * 60 * 1000,
});
auditor.registerToken({
  id: 'tok_main',
  label: 'OPENAI_API_KEY',
  issuedAt: Date.now(),
  grantedScopes: ['completions:write', 'models:read'],
  policyId: 'openai',
});
const report = auditor.auditAll();
```

On rotation: call `deregisterToken(oldId)` then `registerToken(newMetadata)` to update the registry.

### Token Storage Recommendations

- **Companion/operator tokens** are stored at `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`). The file is written at mode `0600`. Consumers should keep the daemon-home directory outside any project tree.
- **Session tokens** are in-memory only; they are not persisted to disk.
- **Spawn tokens** are in-memory per session; they expire automatically.
- **API keys and provider credentials** should be stored via `SecretsManager` in secure (encrypted) mode, not plaintext. See [Secret Management](#secret-management) below.

---

## Companion App Pairing

**Source:** `packages/sdk/src/_internal/platform/pairing/`

The QR pairing flow connects a companion app to the daemon without requiring the user to manually enter credentials.

### Security Properties

1. **Token generation** — companion tokens are generated with `randomBytes(24)` (192 bits of entropy), base64url-encoded, and prefixed with `gv_`. The `gv_` prefix makes tokens machine-identifiable in logs and secret scanners.

2. **Persistence** — tokens are stored on disk at `<daemonHomeDir>/operator-tokens.json` (canonical global location since SDK 0.21.28). The file is created at mode `0600`. The token is stable across daemon restarts.

3. **QR payload** — `encodeConnectionPayload()` serializes the connection info (URL, token, username, version, surface) as JSON. This JSON is what gets encoded into the QR matrix. The QR is displayed in a trusted UI context (TUI screen or authenticated web page); it should not be left visible in shared screen recordings.

4. **No challenge-response** — the pairing is a direct token transfer. Security relies on:
   - The QR being displayed only in a trusted environment
   - The transport using TLS when the daemon is accessed over a network
   - The token being revocable: `regenerateCompanionToken(surface, { daemonHomeDir })` instantly invalidates all existing companion connections

5. **Connection** — after scanning, the companion app connects using `transport-http` with `Authorization: Bearer gv_<token>`. The daemon validates this through the normal `authenticateOperatorToken()` path.

### Token Lifecycle

| Event | Action |
|---|---|
| First QR display | `getOrCreateCompanionToken(surface, { daemonHomeDir })` — generates and persists token |
| Companion connects | Token validated against stored record |
| Companion disconnects | Token remains valid; reconnection requires no re-scan |
| Revocation needed | `regenerateCompanionToken(surface, { daemonHomeDir })` — replaces stored token; all current sessions using old token are rejected on next request |
| Daemon restart | Token is loaded from disk; companion reconnects without re-scan |

---

## Network Security

### TLS

When the daemon is accessed over a network (not localhost), TLS is strongly recommended. The session cookie system sets the `Secure` attribute automatically when the request comes over HTTPS (or via a trusted proxy with `X-Forwarded-Proto: https`):

```ts
function isSecureRequest(req: Request, trustProxy = false): boolean {
  // checks req.url protocol, then x-forwarded-proto if trustProxy
}
```

For reverse proxies (nginx, Caddy, Traefik), set `trustProxy: true` in the daemon config so the `Secure` cookie attribute is applied correctly.

### CORS

CORS policy should be configured at the network edge (reverse proxy) or in the daemon's HTTP server configuration. Do not rely on the browser's same-origin restriction alone when deploying the web UI on a different origin than the daemon.

### Rate Limiting

The daemon does not implement built-in rate limiting. For production deployments, place a rate-limiting reverse proxy (nginx, Traefik middleware, Cloudflare) in front of the daemon to protect against:
- Brute-force attacks on the login endpoint
- Denial-of-service via expensive LLM requests
- Enumeration attacks on the knowledge or session endpoints

### Private Host SSRF Protection

The remote fetch proxy (`remote-routes.ts`) has explicit SSRF protection. When a client requests a fetch to a private/internal host, the daemon checks:
1. `network.remoteFetch.allowPrivateHosts` must be `true` in config (disabled by default)
2. Elevated access must be granted (`requireElevatedAccess` returns null)

If either check fails, the request is rejected with HTTP 403. Do not enable `allowPrivateHosts` unless your deployment specifically requires internal URL resolution.

---

## Secret Management

**Source:** `packages/sdk/src/_internal/platform/config/secrets.ts` and `config/secret-refs.ts`

### SecretsManager

`SecretsManager` provides layered credential storage with three enforced policies:

| Policy | Description | Use Case |
|---|---|---|
| `plaintext_allowed` | Secrets may be written to unencrypted files | Local development only |
| `preferred_secure` | Use encrypted storage when available; fall back to plaintext | Default for most deployments |
| `require_secure` | Reject all plaintext writes; encrypted storage is mandatory | Production / multi-user |

Encrypted stores use AES-256-GCM with a key derived at runtime. Plaintext stores are JSON files — useful for development but not suitable for production.

The read order follows a precedence hierarchy:
1. Environment variables (highest precedence — always checked first)
2. Project-scoped secure store
3. Project-scoped plaintext store
4. User-scoped secure store
5. User-scoped plaintext store (lowest precedence)

Use `inspect()` to audit the current storage state: it reports the active policy, whether secure storage is available, how many keys are in each store, and any warnings about plaintext storage of sensitive keys.

### Secret Refs

Instead of storing secret values directly in config files, use secret references. A secret ref is a URI or structured object pointing to an external secret source:

**URI syntax:**
```
goodvibes://secrets/env/OPENAI_API_KEY
goodvibes://secrets/goodvibes/OPENAI_API_KEY
goodvibes://secrets/file/~/.credentials/key.json?selector=openai.api_key
goodvibes://secrets/exec/op?arg=read&arg=op%3A%2F%2FDevelopment%2FOpenAI%2Fapi_key
goodvibes://secrets/1password?vault=Development&item=OpenAI&field=api_key
goodvibes://secrets/bitwarden?item=openai-prod&field=password
goodvibes://secrets/bws/<secret-id>?field=value
```

**JSON object syntax:**
```json
{ "source": "1password", "vault": "Development", "item": "OpenAI", "field": "api_key" }
```

Supported sources:

| Source | Mechanism | Notes |
|---|---|---|
| `env` | `process.env[id]` | Highest precedence; always available |
| `goodvibes` | Internal `SecretsManager` | Looks up by key name |
| `file` | File read + optional JSON path selector | Path supports `~` expansion |
| `exec` | Runs command; stdout is the secret | Supports custom args, env, stdin, timeout |
| `1password` | `op` CLI | Supports vault, item, field, account, custom CLI path |
| `bitwarden` / `vaultwarden` | `bw` CLI | Supports item, field, custom fields, server validation |
| `bitwarden-secrets-manager` | `bws` CLI | Machine secrets; supports access token, profile, server URL |

`resolveSecretRef()` dispatches to the correct resolver at runtime. External CLI resolvers (`exec`, `1password`, `bitwarden`) run subprocesses with a configurable timeout.
The generic `secret://...` scheme is intentionally not accepted; use
`goodvibes://secrets/...` for URI refs.

Slack setup uses this same URI mechanism. Direct setup writes Slack token values to the GoodVibes secret store and places references such as `goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN` and `goodvibes://secrets/goodvibes/SLACK_APP_TOKEN` in config. Service-registry based Slack setup can use `primary`, `signingSecret`, `webhookUrl`, and `appToken` fields.

**Best practices:**
- Prefer `1password` or `bitwarden-secrets-manager` for production deployments
- Use `env` refs for CI/CD pipelines
- Use `exec` refs sparingly and validate the command does not echo secrets to stderr
- Never commit `goodvibes://secrets/goodvibes/...` refs that point to keys only present in a plaintext local store

---

## Permission System

**Source:** `packages/sdk/src/_internal/platform/permissions/`

Every tool call goes through the `PermissionManager` before execution.

### Categories

| Category | Tools | Examples |
|---|---|---|
| `read` | File reads, information queries | `read_file`, `list_directory`, `search` |
| `write` | File writes, state mutations | `write_file`, `edit_file`, `create_directory` |
| `execute` | Shell execution, process spawning | `bash`, `exec`, `run_script` |
| `delegate` | Agent spawning, ACP tasks | `precision_agent`, delegate tools |

### Risk Levels

`analyzePermissionRequest()` (`permissions/analysis.ts`) classifies each tool call:

| Risk Level | Criteria |
|---|---|
| `low` | Read-only access to project files; no side effects |
| `medium` | Writes within the project directory; bounded blast radius |
| `high` | Writes outside project, shell execution, external network access |
| `critical` | Writes to system paths, secrets exposure detection, destructive operations |

The analyzer detects inline secrets in command arguments using pattern matching (`SECRET_NAME_PATTERN`, `INLINE_SECRET_PATTERN`) and flags them as high risk.

### Decision Sources

Permission decisions flow through a layered policy stack:

| Source | Priority | Behavior |
|---|---|---|
| `config_policy` | Highest | Allow/deny lists in `permissions` config |
| `managed_policy` | High | Programmatic policies registered at runtime |
| `safety_check` | High | Hardcoded safety guardrails (cannot be overridden) |
| `runtime_mode` | Medium | Auto-approve mode (`mode_allow_all`) or restricted mode |
| `session_override` | Medium | Cached allow/deny decisions from this session |
| `user_prompt` | Lowest | Falls through to interactive user prompt |

`checkDetailed()` returns a `PermissionCheckResult` with `approved: boolean`, `persisted: boolean` (whether to cache for session), `sourceLayer`, `reasonCode`, and the full `analysis`.

### Auto-Approve Policies

When `permissions.autoApprove: true` is set in config, all tool calls are approved without prompting (`mode_allow_all`). This is appropriate for headless automation runs. For interactive use, leave this disabled and configure explicit allow lists for frequently-used tools instead:

```yaml
permissions:
  allow:
    - read_file
    - list_directory
    - bash: "npm run *"
  deny:
    - bash: "rm -rf *"
```

---

## Daemon Security Hardening

### Port Binding

By default, the daemon binds to `localhost` only. If you need network access, bind to a specific interface rather than `0.0.0.0` unless you have a firewall or reverse proxy handling ingress. Exposing the daemon port directly to the internet without TLS and rate limiting is not supported.

### Authentication Requirement

Always configure either a shared token or session auth before exposing the daemon to any network beyond localhost. A daemon with no auth configured accepts all requests.

### Admin vs User Roles

- **Admin principals** (shared-token requests, or session users with the `admin` role): full access to all routes including control plane, user management, and config mutation
- **Non-admin principals**: access to conversational and operational routes only; admin-gated routes return 403

When creating user accounts with `UserAuthManager.addUser()`, the default role is `['admin']`. For least-privilege companion or integration accounts, pass a custom role array that excludes `admin`.

### Principal Kinds and Scopes

The `AuthenticatedPrincipal` type carries a `principalKind` (`user` | `bot` | `service` | `token`) and a `scopes` array. Route handlers use `buildMissingScopeBody()` to enforce required scopes before processing a request. Scope violations return a structured error with `requiredScopes`, `grantedScopes`, and `missingScopes` fields.

### Bootstrap Credential File

**Source:** `packages/sdk/src/_internal/platform/security/user-auth.ts` — `writeBootstrapCredentialFile()`, `clearBootstrapCredentialFile()`

#### What it is and when it is created

On first boot, if no persistent user store exists (`auth-users.json` is absent or empty), `UserAuthManager` calls `loadOrBootstrapUsers()`, which:

1. Generates a 16-byte cryptographically random password (`randomBytes(16).toString('hex')`) for the default `admin` account
2. Hashes and stores the password in the user store file (`bootstrapFilePath`, e.g. `.goodvibes/tui/auth-users.json`)
3. Writes the raw plaintext credentials to a second file (`bootstrapCredentialPath`, e.g. `.goodvibes/tui/auth-bootstrap.txt`) and sets its permissions to `0o600` (owner read/write only)

The bootstrap file format is plain key-value text:

```
GoodVibes bootstrap auth
username=admin
password=<32-hex-chars>
purpose=Use these credentials only for local daemon/http listener /login routes when those surfaces are enabled.
note=Normal SDK host usage does not require these credentials.
```

This file is an **output only**. It is not read back by the runtime after bootstrap — edits to it do not change the stored password hash.

#### Drift detection

Every time `UserAuthManager` is constructed (daemon startup), `detectBootstrapCredentialDrift()` runs automatically when operating in file-backed mode. It reads the bootstrap file and verifies that the stored password still matches the hash in `auth-users.json`. If they have drifted — for example because someone manually edited the file — a `warn`-level log is emitted:

```
Bootstrap credential file password does not match the stored hash; /login with this password will fail.
Rotate the password via UserAuthManager.rotatePassword() or regenerate the credential by deleting both files so they are re-created in sync.
```

Drift detection fires only on file-backed instances; test configs that pass explicit `users` are exempt.

#### Recommended lifecycle after first login

1. Log in once using the bootstrap credentials (via the `/login` route)
2. Immediately rotate the admin password to a value you control:
   ```ts
   authManager.rotatePassword('admin', newPassword);
   ```
   `rotatePassword()` updates the user store, revokes all active sessions for that user, and overwrites the bootstrap file with the new password.
3. Delete the bootstrap file:
   ```ts
   authManager.clearBootstrapCredentialFile(); // returns true if the file existed and was removed
   ```
   Alternatively, delete the file manually: `rm .goodvibes/tui/auth-bootstrap.txt`.
4. Verify the file is gone:
   ```ts
   const snap = authManager.inspect();
   console.assert(!snap.bootstrapCredentialPresent, 'Bootstrap file still present!');
   ```

#### Failure modes

| Situation | Outcome |
|---|---|
| Bootstrap file deleted before first login | Re-bootstrap by deleting both `auth-bootstrap.txt` **and** `auth-users.json`; both files are regenerated on next start |
| `auth-users.json` deleted while `auth-bootstrap.txt` still exists | Daemon re-bootstraps with a new password; old bootstrap file becomes stale. Drift detection will warn on next start |
| Both files deleted | Clean re-bootstrap — a new admin account and new bootstrap file are created. All existing sessions are invalidated (sessions are in-memory) |
| Bootstrap file manually edited | Password mismatch; `/login` will reject the edited password. Drift detection warns on next startup. Fix by calling `rotatePassword()` to bring both files back in sync |

There is no recovery path for a forgotten admin password beyond deleting both files to trigger a re-bootstrap.

#### Security implications

- The bootstrap file contains a **plaintext password**. `0o600` limits access to the file owner, but it is not encrypted.
- Keep `bootstrapCredentialPath` outside the project root to prevent accidental inclusion in Docker `COPY` layers, version control, or build artifacts.
- Do not leave the file present after first login. A stale bootstrap file is a standing credential that grants admin access to any process running as the same OS user.
- The bootstrap file path should be added to `.gitignore` and `.dockerignore` as a matter of policy, even though it lives outside the project root by convention.

### Logging Guidance

- Token values, passwords, and secret values must never appear in log output
- The `ApiTokenAuditor` logs token IDs and labels, never the secret value itself
- `UserAuthManager` stores only hashed passwords; plaintext passwords are never retained after hashing
- Structured error responses from the daemon expose route names and scope names but not internal state or credential values
