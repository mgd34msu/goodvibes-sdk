# Config sharing across surfaces (E7): the daemon-served shared tier + an admin-scoped credential-status read

- **Date:** 2026-07-06
- **Wave / work order:** Wave 6, W6-C1
- **Status:** Accepted (ratifies the W6-C1 brief's OPEN CALL on secret-read granularity)
- **Scope:** SDK enabler only. Consumer rewires (TUI/agent/webui) adopt this over the dev
  overlay and land after the SDK lands.

## Context (reality, verified)

Config is one SDK engine (`platform/config/manager.ts` `ConfigManager`) fanned into per-surface
silos by a `surfaceRoot` string. Each surface writes `~/.goodvibes/<surface>/settings.json`
and channel secrets to `~/.goodvibes/<surface>/secrets.enc` (`platform/config/secrets.ts`
`SecretsManager`). API keys are **env-var only, never persisted** (`platform/config/api-keys.ts`).
`resolveSharedDirectory()` (`platform/runtime/surface-root.ts:19`) is a surface-neutral path
helper that was already written but unused; `ConfigManager` has a `~/.goodvibes/<surface>.json`
placeholder "reserved for future cross-app use".

A daemon-served config surface already exists: `config.get` / `config.set`
(`control-plane/method-catalog-admin.ts`, `access: admin`, `scopes: [read:config]`) returning
`CONFIG_SNAPSHOT_SCHEMA` (`control-plane/operator-contract-schemas-admin.ts:67`) which carries
`providers` / `channels` / `memory` categories but **no `secrets` / `apiKeys` field by
construction**; plus `providers.list` / `providers.get` / `providers.usage.get`. There is **no**
`secrets.*` / `credentials.*` operator method — stored secrets are daemon-internal only
(TUI `createDaemonCredentialStore`, backed by the SDK `SecretsManager`).

The webui is a browser and physically cannot read `~/.goodvibes`, so any pure on-disk shared
tier structurally excludes it. The honest shared tier is therefore **daemon-served** config plus
**one new admin-scoped credential-status read** over a single neutral store the daemon owns.

## Decision

### 1. Neutral shared store = the daemon's own store, read cross-surface over the wire

The daemon is the only seam that reaches all four surfaces (including the browser). The "single
neutral daemon-owned store" is realized as **the daemon's own `ConfigManager` + `SecretsManager`,
read cross-surface through the existing `config.get` / `providers.*` and the new
credential-status method**. A daemon is not `tui`/`agent`/`webui` — it runs under its own
neutral surface identity, so its store *is* the shared tier. Consumers acting as clients read
provider/model config and credential *status* from the daemon rather than from their own
`surfaceRoot`. Surface roots keep surface-**local** prefs only.

The `resolveSharedDirectory()` helper and a literal `surfaceRoot: 'shared'`
(`~/.goodvibes/shared/{settings.json,secrets.enc}` — `'shared'` is a valid single path segment
that reuses every existing path/crypto codepath unchanged) remain available for a daemon host
that wants an explicitly-named neutral store on disk; the wire contract is identical either way.

### 2. The read contract: config.get provider guarantee + ONE new credential-status method

- **`config.get`** already carries the `providers` category (secret-free) — kept as the
  cross-surface provider/model visibility path. No secret ever enters `CONFIG_SNAPSHOT_SCHEMA`.
- **New method `credentials.get`** (`GET /config/credentials`, `access: admin`,
  `scopes: [read:config]`). It promotes the internal credential store to the wire as
  **status metadata only**:
  `{ available, credentials: [{ key, configured, usable, source, scope, secure, overriddenByEnv, refSource? }] }`.

### 3. Granularity ruling (the brief's OPEN CALL) — **metadata only, never raw bytes**

`credentials.get` returns **configured / usable + the resolvable ref source**, and **never the
secret value**. There is no scope, and no parameter, that makes this method return raw key bytes
over the wire. Rationale: a wire client (webui, a remote TUI/agent) needs to render
"configured / usable / unavailable", not to hold the secret; the only component that needs the
plaintext is the daemon itself, which already resolves it in-process via
`createDaemonCredentialStore` / `SecretsManager.get`. Keeping raw bytes off the wire makes this
first secret-derived wire path safe by construction.

- **Enumeration is over stored keys only** (`SecretsManager.list()`), **never**
  `process.env`. Dumping `listDetailed()` would leak the *names* of every environment variable;
  we enumerate only keys actually held in the shared store, plus a caller-named single key probe
  (`?key=FOO`) that may consult env for that one named key.
- **`usable`** is computed by resolving the ref/value in-process and reporting only the boolean —
  so an `op://` / `bw://` / `env://` reference that fails to resolve reports `configured: true,
  usable: false` (honest degraded state), distinct from "not configured" (`configured: false`).
- **External refs** (`secret-refs.ts`: `op://`, `bw://`, `env://`, `file://`, `exec://`) are
  honored: `refSource` names the provider and `usable` reflects a real resolution attempt.

### 4. Honest degraded state

A cross-surface read whose provider is momentarily unavailable says so
(`available: false` / `usable: false` with the reason implicit in the flags), never a stale
confident value. Consumers render "config unavailable — retrying" / "credential unconfigured",
mirroring the Wave-5 provider-freshness honesty bar.

### 5. Env-only API-key posture preserved

API keys stay env-var only and are **never** persisted into the shared store. The shared store is
for channel secrets + provider/model *config* + secret *references*. `credentials.get` reports
env-backed provider keys only as `configured` status (via the caller-named probe / the existing
`providers.*` env scan), never as stored, retrievable bytes.

## Alternatives rejected

- **A pure on-disk shared file as the whole answer.** The browser cannot read `~/.goodvibes`, so
  it would still need daemon methods — you would build both. The daemon-served tier is the honest
  single answer; the on-disk `shared` root is an optional daemon-host detail, not the contract.
- **Putting secrets into `CONFIG_SNAPSHOT_SCHEMA`.** The snapshot is deliberately secret-free;
  a regression test locks that it carries no `secrets` / `apiKeys` field.
- **Returning raw key bytes under an explicit scope.** No wire client needs plaintext; the daemon
  resolves in-process. Raw bytes never cross the wire.
- **Per-surface sync / import of the two encrypted stores.** It institutionalizes the
  divergence and does nothing for the browser.

## Admin-scoping proof

`credentials.get` declares `access: admin, scopes: [read:config]` in its descriptor (the wire
contract) and enforces it at runtime with `context.requireAdmin(req)` — the same gate `config.get`
uses. The bootDaemon proof asserts: no token → 401; a valid admin/daemon token → 200 with a
secret-free metadata body; the body carries no `value` / raw-bytes field on any path; and
`CONFIG_SNAPSHOT_SCHEMA` still has no `secrets` / `apiKeys` field.
