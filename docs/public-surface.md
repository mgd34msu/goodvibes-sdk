# Public Surface — @pellux/goodvibes-sdk

> **Runtime surfaces**: See [`docs/surfaces.md`](./surfaces.md) for the full/companion surface split, supported runtimes, and CI enforcement details.

This document lists every stable subpath exported by `@pellux/goodvibes-sdk`. Consumers should only import from paths listed here. Private repository source layout is not a package contract.

## Stability levels

- **stable** — Semver-guaranteed. Breaking changes require a major bump.
- **beta** — API is settled but may have minor adjustments between minor releases.
- **preview** — Under active development. May change without notice in any release.

---

## Root entry point

### `.` — `@pellux/goodvibes-sdk`

**Status:** stable

Main entry point. Exports `createGoodVibesSdk`, client types, and re-exports all top-level subsystem barrels.

Use this for general SDK consumption when you don't need a subsystem-specific entry.

---

## Subsystem entry points

### `./auth` — `@pellux/goodvibes-sdk/auth`

**Status:** stable

Authentication client, token stores, and auth types. Exports `createGoodVibesAuthClient`, `createBrowserTokenStore`, `createMemoryTokenStore`, and associated types.

**Stability contract:** public method signatures are stable. Internal token format may change between major versions.

### `./client-auth` — `@pellux/goodvibes-sdk/client-auth`

**Status:** beta

Low-level authentication primitives, including `AutoRefreshCoordinator`, platform-specific token stores (browser, iOS keystore, Android keychain, Expo secure store), and auto-refresh options. Use `./auth` for the recommended public authentication surface; import from `./client-auth` only when you need direct access to platform-specific token store implementations or the coordinator.

### `./contracts` — `@pellux/goodvibes-sdk/contracts`

**Status:** stable

ACP operator/peer contract types, runtime event domains, and method IDs. Used by both operator and peer clients.

### `./contracts/node` — `@pellux/goodvibes-sdk/contracts/node`

**Status:** stable

Contract extensions for file-based artifact types. Used on the full (Bun) surface.

### `./contracts/operator-contract.json` — `@pellux/goodvibes-sdk/contracts/operator-contract.json`

**Status:** stable

Raw JSON schema for the operator ACP contract. Suitable for tooling and validators.

> **Bundle-budget note:** JSON artifacts are static and excluded from gzip bundle-budget tracking. See `bundle-budgets.json` comments.

### `./contracts/peer-contract.json` — `@pellux/goodvibes-sdk/contracts/peer-contract.json`

**Status:** stable

Raw JSON schema for the peer ACP contract.

> **Bundle-budget note:** JSON artifacts are static and excluded from gzip bundle-budget tracking.

### `./daemon` — `@pellux/goodvibes-sdk/daemon`

**Status:** stable

Daemon HTTP API types, route helpers, and server bootstrap utilities.

### `./observer` — `@pellux/goodvibes-sdk/observer`

**Status:** beta

Observability helpers: `createConsoleObserver`, `createOpenTelemetryObserver`, and associated observer types. The root `@pellux/goodvibes-sdk` entry also re-exports this surface via `export *`; either import path is valid. Prefer `./observer` when you need tree-shaking control.

### `./operator` — `@pellux/goodvibes-sdk/operator`

**Status:** stable

Operator ACP client. Use `createOperatorSdk` to connect to a running daemon.
The operator surface is intentionally resource-oriented (`sessions`,
`tasks`, `approvals`) because it is used by human/operator UIs that browse and
act on daemon resources.

### `./peer` — `@pellux/goodvibes-sdk/peer`

**Status:** stable

Peer ACP client. Use `createPeerSdk` for peer-to-peer connections.
The peer surface is intentionally capability-oriented (`pairing`, `peer`,
`work`, `operator`) because peer nodes negotiate capabilities before work is
available. This differs from the operator client by design; both clients share
the same generated contract ids underneath.

### `./errors` — `@pellux/goodvibes-sdk/errors`

**Status:** stable

Shared error types and error-contract helpers.

### `./events` and `./events/*` — `@pellux/goodvibes-sdk/events`

**Status:** beta

Runtime event domain types. Use `./events` for the aggregate event-domain
barrel, or `./events/<domain>` for a single domain such as
`@pellux/goodvibes-sdk/events/agents`.

> **Contract note:** `./events/*` is a wildcard subpath resolving per-domain files from `dist/events/`. The supported domain identifiers are: `agents`, `automation`, `communication`, `compaction`, `control-plane`, `deliveries`, `forensics`, `knowledge`, `mcp`, `ops`, `orchestration`, `permissions`, `planner`, `plugins`, `providers`, `routes`, `security`, `session`, `surfaces`, `tasks`, `tools`, `transport`, `turn`, `ui`, `watchers`, `workflows`, `workspace`. Internal modules (`domain-map`, `contracts`) are reachable via the wildcard but are considered implementation details; prefer the aggregate `./events` barrel.

### `./transport-core` — `@pellux/goodvibes-sdk/transport-core`

**Status:** stable

Abstract transport interfaces, base classes, and shared transport types.

### `./transport-direct` — `@pellux/goodvibes-sdk/transport-direct`

**Status:** stable

In-process direct transport (zero-latency, same-process communication). See
[Transports](./transports.md) for the canonical facade description.

### `./transport-http` — `@pellux/goodvibes-sdk/transport-http`

**Status:** stable

HTTP/REST transport implementation.

### `./transport-realtime` — `@pellux/goodvibes-sdk/transport-realtime`

**Status:** stable

SSE/WebSocket realtime transport implementation.

### `./browser` — `@pellux/goodvibes-sdk/browser`

**Status:** stable

Browser-optimized SDK entry. Browser-safe entry with browser-appropriate reconnect/retry defaults.

### `./web` — `@pellux/goodvibes-sdk/web`

**Status:** stable

Web (browser + service workers) SDK entry.

### `./workers` — `@pellux/goodvibes-sdk/workers`

**Status:** preview

Cloudflare Worker bridge for optional daemon batch integration. Exports `createGoodVibesCloudflareWorker` and structural Worker/Queue types. Use this when manually deploying a Worker that proxies `/batch/*` to the daemon, enqueues batch tick signals, consumes Cloudflare Queue messages, or runs scheduled ticks. Normal Worker-hosted clients that only need operator HTTP calls should keep using `./web`. SDK-owned Cloudflare provisioning is exposed through daemon `/api/cloudflare/*` routes rather than this Worker entry point, including token bootstrap, discovery, Workers, Queues, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2.

### `./react-native` — `@pellux/goodvibes-sdk/react-native`

**Status:** stable

React Native SDK entry. Excludes Node.js-only transports.

### `./expo` — `@pellux/goodvibes-sdk/expo`

**Status:** stable

Expo-specific SDK entry built on top of `react-native`.

---

## Platform surface (`./platform/...`)

### Explicit platform entrypoints — `@pellux/goodvibes-sdk/platform...`

**Status:** beta

Granular platform modules exposed through explicit public subpaths. Each path is listed intentionally rather than exposed by a wildcard.

The `platform/...` surface is the canonical way for downstream consumers (e.g., the goodvibes-tui) to access platform subsystems. The package does not export a wildcard `./platform/*` pattern; every public platform path is listed intentionally in `package.json`. Paths not listed below should be considered unsupported; new paths are added on an as-needed basis.

**Stability contract:** the module shape (exported names and their TypeScript signatures) is stable within a minor version. Pre-1.0 releases may still make breaking changes; current behavior is recorded in `CHANGELOG.md`.

The root `@pellux/goodvibes-sdk/platform` entry is a full platform hub for
Bun/server embedders. Runtime-boundary helpers live at
`@pellux/goodvibes-sdk/platform/node`; the base knowledge system lives at
`@pellux/goodvibes-sdk/platform/knowledge`; Home Assistant Home Graph extends
that base through `@pellux/goodvibes-sdk/platform/knowledge/home-graph`.

#### Platform subpaths — exact export map entries

The following subpaths are the complete list of exported platform paths.
Importing any path not in this table will produce an `ERR_PACKAGE_PATH_NOT_EXPORTED` error.

| Subpath | Description | Status |
|---|---|---|
| `platform` | Full platform hub for Bun/server embedders | beta |
| `platform/config` | Config manager, secrets, schema, subscriptions | beta |
| `platform/core` | Orchestrator, transcript events, execution plan | beta |
| `platform/daemon` | HTTP server, routes, port-in-use checks | beta |
| `platform/git` | Git service integration | beta |
| `platform/integrations` | Delivery, Slack, Discord, Ntfy notifiers | beta |
| `platform/intelligence` | LSP, tree-sitter, import graph | beta |
| `platform/knowledge` | Knowledge store and API | beta |
| `platform/knowledge/extensions` | Knowledge system extension contracts | beta |
| `platform/knowledge/home-graph` | Home Assistant Home Graph extension | beta |
| `platform/multimodal` | Multimodal input | beta |
| `platform/node` | Node-like runtime boundary and capability metadata | beta |
| `platform/node/runtime-boundary` | Client-safe runtime boundary detection (no Bun globals) | beta |
| `platform/pairing` | Companion token, QR, pairing index | beta |
| `platform/providers` | LLM provider registry, catalog, capabilities | beta |
| `platform/runtime` | Full runtime surface exposing bootstrap, observability, operations, security, shell, state, transport, ui as namespaces. Lower-level subsystems (events, store, lifecycle, tasks, sandbox) are reachable through dedicated subpaths or through ./platform/runtime/state and ./platform/runtime/store. | beta |
| `platform/runtime/observability` | Curated observability re-exports from the runtime surface | beta |
| `platform/runtime/state` | Runtime state primitives | beta |
| `platform/runtime/store` | Runtime store and selectors | beta |
| `platform/runtime/ui` | Curated UI surface (model-picker, provider-health); not a barrel of `runtime/ui/` subdirectory | beta |
| `platform/tools` | Tool registry, exec, fetch, read, write, edit, agent | beta |
| `platform/utils` | Shared platform utilities | beta |
| `platform/voice` | Voice provider registry, provider-agnostic TTS/STT/realtime voice types, and streaming TTS primitives | beta |

> **Subsystems available internally via `./platform` and `./platform/node`:** The following subsystems are accessible as namespaces through the aggregate `./platform` or `./platform/node` entry points, but do not have their own dedicated public subpaths: `acp`, `adapters`, `artifacts`, `automation`, `batch`, `channels`, `cloudflare`, `companion`, `control-plane`, `discovery`, `hooks`, `mcp`, `media`, `security`, `state`, `watchers`, `web-search`. Import them via `@pellux/goodvibes-sdk/platform` if you are embedding the full platform surface.

---

## Sealed paths

The following paths are intentionally NOT exported and will cause a module resolution error if imported:

- Any `@pellux/goodvibes-sdk/platform/...` path not listed in the export map above.
- Any `dist/...` file path reached by bypassing the package export map.

Consumers must use the corresponding documented subpath when one is exported.
