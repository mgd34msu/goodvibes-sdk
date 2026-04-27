# Public Surface — @pellux/goodvibes-sdk

> **Runtime surfaces**: See [`docs/surfaces.md`](./surfaces.md) for the full/companion surface split, supported runtimes, and CI enforcement details.

This document lists every stable subpath exported by `@pellux/goodvibes-sdk`. Consumers should only import from paths listed here. Importing from `_internal/**` directly is not supported and will break on any release.

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

Stability contract: public method signatures are stable. Internal token format may change between major versions.

### `./contracts` — `@pellux/goodvibes-sdk/contracts`

**Status:** stable

ACP operator/peer contract types, runtime event domains, and method IDs. Used by both operator and peer clients.

### `./contracts/node` — `@pellux/goodvibes-sdk/contracts/node`

**Status:** stable

Contract extensions for file-based artifact types. Used on the full (Bun) surface.

### `./contracts/operator-contract.json` — `@pellux/goodvibes-sdk/contracts/operator-contract.json`

**Status:** stable

Raw JSON schema for the operator ACP contract. Suitable for tooling and validators.

### `./contracts/peer-contract.json` — `@pellux/goodvibes-sdk/contracts/peer-contract.json`

**Status:** stable

Raw JSON schema for the peer ACP contract.

### `./daemon` — `@pellux/goodvibes-sdk/daemon`

**Status:** stable

Daemon HTTP API types, route helpers, and server bootstrap utilities.

### `./operator` — `@pellux/goodvibes-sdk/operator`

**Status:** stable

Operator ACP client. Use `createOperatorSdk` to connect to a running daemon.

### `./peer` — `@pellux/goodvibes-sdk/peer`

**Status:** stable

Peer ACP client. Use `createPeerSdk` for peer-to-peer connections.

### `./errors` — `@pellux/goodvibes-sdk/errors`

**Status:** stable

Shared error types and error-contract helpers.

### `./transport-core` — `@pellux/goodvibes-sdk/transport-core`

**Status:** stable

Abstract transport interfaces, base classes, and shared transport types.

### `./transport-direct` — `@pellux/goodvibes-sdk/transport-direct`

**Status:** stable

In-process direct transport (zero-latency, same-process communication).

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

## Platform surface (`./platform/*`)

### `./platform/*` — `@pellux/goodvibes-sdk/platform/<subsystem>/<module>`

**Status:** beta

Granular platform modules exposed through stable public subpaths. Each path re-exports the corresponding implementation module through a public path that does not expose `_internal`.

The `platform/*` surface is the canonical way for downstream consumers (e.g., the goodvibes-tui) to access platform subsystems. Paths not listed below should be considered unsupported; new paths are added on an as-needed basis.

Stability contract: the module shape (exported names and their TypeScript signatures) is stable within a minor version. Pre-1.0 releases may still make breaking changes; current behavior is recorded in `CHANGELOG.md`.

#### Subsystems included in the platform surface

| Subpath prefix | Description | Status |
|---|---|---|
| `platform/acp/*` | ACP connection, manager, protocol | beta |
| `platform/adapters/*` | Channel adapter helpers | beta |
| `platform/agents/*` | Agent orchestration, WRFC, message bus | beta |
| `platform/artifacts/*` | Artifact store and types | beta |
| `platform/automation/*` | Automation jobs, scheduling, delivery | beta |
| `platform/bookmarks/*` | Bookmark manager | beta |
| `platform/channels/*` | Channel policy and route managers | beta |
| `platform/config/*` | Config manager, secrets, schema, subscriptions | beta |
| `platform/control-plane/*` | Session broker, gateway, method catalog | beta |
| `platform/core/*` | Conversation engine, orchestrator, tokenizer | beta |
| `platform/daemon/*` | HTTP server, routes, policy | beta |
| `platform/discovery/*` | Codebase discovery and scanner | beta |
| `platform/export/*` | Session and markdown export | beta |
| `platform/git/*` | Git service integration | beta |
| `platform/hooks/*` | Hook dispatcher, workbench, runners | beta |
| `platform/integrations/*` | Delivery, Slack, Discord, Ntfy notifiers | beta |
| `platform/intelligence/*` | LSP, tree-sitter, import graph | beta |
| `platform/knowledge/*` | Knowledge store and API | beta |
| `platform/mcp/*` | MCP client, registry, config | beta |
| `platform/media/*` | Media provider registry | beta |
| `platform/multimodal/*` | Multimodal input | beta |
| `platform/pairing/*` | Companion token, QR, pairing index | beta |
| `platform/permissions/*` | Permission analysis, policy, briefs | beta |
| `platform/plugins/*` | Plugin manager, loader, API | beta |
| `platform/profiles/*` | Profile manager and shape | beta |
| `platform/providers/*` | LLM provider registry, catalog, capabilities | beta |
| `platform/runtime/*` | Full runtime surface (events, store, lifecycle, tasks, sandbox, etc.) | beta |
| `platform/scheduler/*` | Cron-style scheduler | beta |
| `platform/security/*` | Token audit, spawn tokens, HTTP auth | beta |
| `platform/sessions/*` | Session manager and orchestration | beta |
| `platform/state/*` | File state, KV store, memory, vector store | beta |
| `platform/templates/*` | Template manager | beta |
| `platform/tools/*` | Tool registry, exec, fetch, read, write, edit, agent | beta |
| `platform/types/*` | Shared type definitions (errors, tools) | beta |
| `platform/utils/*` | Logger, path-safety, clipboard, retry | beta |
| `platform/voice/*` | Voice provider registry, provider-agnostic TTS/STT/realtime voice types, and streaming TTS primitives | beta |
| `platform/watchers/*` | File watcher store | beta |
| `platform/web-search/*` | Web search providers | beta |
| `platform/workflow/*` | Workflow trigger executor | beta |

---

## Sealed paths

The following paths are intentionally NOT exported and will cause a module resolution error if imported:

- `@pellux/goodvibes-sdk/_internal/**` — implementation internals.

Consumers must not import `_internal` paths directly. Use the corresponding `platform/*` subpath when one is exported.
