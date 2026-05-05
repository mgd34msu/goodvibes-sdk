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

### `./events` and explicit event-domain subpaths — `@pellux/goodvibes-sdk/events`

**Status:** beta

Runtime event domain types. Use `./events` for the aggregate event-domain
barrel, or an explicit `./events/<domain>` subpath for a single domain such as
`@pellux/goodvibes-sdk/events/agents`.

Supported event domain subpaths are: `agents`, `automation`, `communication`,
`compaction`, `control-plane`, `deliveries`, `forensics`, `knowledge`, `mcp`,
`ops`, `orchestration`, `permissions`, `planner`, `plugins`, `providers`,
`routes`, `security`, `session`, `surfaces`, `tasks`, `tools`, `transport`,
`turn`, `ui`, `watchers`, `workflows`, and `workspace`. Event implementation
modules are not exported as deep package subpaths.

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

The `platform/...` surface is the canonical way for downstream consumers (e.g., the goodvibes-tui) to access platform subsystems. The package does not export a wildcard `./platform/*` pattern; every public platform path is listed intentionally in `package.json`. Paths not listed below should be considered unsupported.

**Stability contract:** exported names and their TypeScript signatures are the current package contract. Pre-1.0 releases may make breaking changes; current behavior is recorded in `CHANGELOG.md`.

There is no root `@pellux/goodvibes-sdk/platform` entry. Runtime-boundary helpers live at
`@pellux/goodvibes-sdk/platform/node/runtime-boundary`; runtime capability metadata lives at
`@pellux/goodvibes-sdk/platform/node`; the base knowledge system lives at
`@pellux/goodvibes-sdk/platform/knowledge`; Home Assistant Home Graph extends
that base through `@pellux/goodvibes-sdk/platform/knowledge/home-graph`.

#### Platform subpaths — exact export map entries

The following subpaths are the complete list of exported platform paths.
Importing any path not in this table will produce an `ERR_PACKAGE_PATH_NOT_EXPORTED` error.

| Subpath | Description | Status |
|---|---|---|
| `platform/acp` | Agent Control Protocol connection and manager APIs | beta |
| `platform/adapters` | Adapter type contracts | beta |
| `platform/agents` | Agent orchestration, WRFC, session, and messaging APIs | beta |
| `platform/artifacts` | Artifact store and artifact record types | beta |
| `platform/automation` | Automation managers, jobs, schedules, routes, and delivery | beta |
| `platform/batch` | Batch execution manager and types | beta |
| `platform/bookmarks` | Bookmark manager | beta |
| `platform/channels` | Channel runtime, routing, policy, and plugin registry | beta |
| `platform/cloudflare` | Cloudflare worker discovery, config, resources, and status helpers | beta |
| `platform/companion` | Companion chat sessions, routes, and persistence | beta |
| `platform/config` | Config manager, secrets, schema, subscriptions | beta |
| `platform/control-plane` | Control-plane gateway, method catalog, contracts, and session broker | beta |
| `platform/core` | Orchestrator, transcript events, execution plan | beta |
| `platform/daemon` | HTTP server, routes, port-in-use checks | beta |
| `platform/discovery` | Local provider and MCP discovery | beta |
| `platform/export` | Markdown and session export helpers | beta |
| `platform/git` | Git service integration | beta |
| `platform/hooks` | Hook dispatcher, matcher, runner, contracts, and workbench | beta |
| `platform/integrations` | Delivery, Slack, Discord, Ntfy notifiers | beta |
| `platform/intelligence` | LSP, tree-sitter, import graph | beta |
| `platform/knowledge` | Knowledge store and API | beta |
| `platform/knowledge/extensions` | Knowledge system extension contracts | beta |
| `platform/knowledge/home-graph` | Home Assistant Home Graph extension | beta |
| `platform/media` | Media indexing, search, and image-understanding APIs | beta |
| `platform/mcp` | MCP config, registry, client, and sandbox bridge | beta |
| `platform/multimodal` | Multimodal input | beta |
| `platform/node` | Runtime capability metadata plus Node-like runtime-boundary helpers; not a platform aggregate | beta |
| `platform/node/runtime-boundary` | Client-safe runtime boundary detection (no Bun globals) | beta |
| `platform/pairing` | Companion token, QR, pairing index | beta |
| `platform/permissions` | Permission analysis, prompts, briefs, and manager | beta |
| `platform/plugins` | Plugin API, loader, and manager | beta |
| `platform/profiles` | Profile manager and profile shape helpers | beta |
| `platform/providers` | LLM provider registry, catalog, capabilities | beta |
| `platform/runtime` | Curated runtime surface exposing bootstrap, observability, operations, security, shell, state, transport, and UI as namespaces | beta |
| `platform/runtime/observability` | Curated observability re-exports from the runtime surface | beta |
| `platform/runtime/sandbox` | Sandbox host status, presets, reviews, and session registry helpers | beta |
| `platform/runtime/settings` | Managed settings and control-plane settings bundle helpers | beta |
| `platform/runtime/state` | Runtime state primitives | beta |
| `platform/runtime/store` | Runtime store and selectors | beta |
| `platform/runtime/ui` | Curated UI surface (model-picker, provider-health); not a barrel of `runtime/ui/` subdirectory | beta |
| `platform/scheduler` | Scheduler service | beta |
| `platform/security` | User auth, token audit, and security helpers | beta |
| `platform/sessions` | Session manager, change tracking, and orchestration | beta |
| `platform/state` | Project index, mode, file cache, undo, and KV state | beta |
| `platform/templates` | Template manager | beta |
| `platform/tools` | Tool registry, exec, fetch, read, write, edit, agent | beta |
| `platform/types` | Shared platform type contracts | beta |
| `platform/utils` | Shared platform utilities | beta |
| `platform/voice` | Voice provider registry, provider-agnostic TTS/STT/realtime voice types, and streaming TTS primitives | beta |
| `platform/watchers` | Watcher registry | beta |
| `platform/web-search` | Web search provider registry, service, and providers | beta |
| `platform/workflow` | Workflow trigger executor | beta |
| `platform/workspace` | Daemon home and workspace swap manager | beta |

Subsystems without public subpaths are package implementation. They are consumed by exported domain seams rather than through a catch-all platform import.

---

## Sealed paths

The following paths are intentionally NOT exported and will cause a module resolution error if imported:

- Any `@pellux/goodvibes-sdk/platform/...` path not listed in the export map above.
- Any `dist/...` file path reached by bypassing the package export map.

Consumers must use the corresponding documented subpath when one is exported.
