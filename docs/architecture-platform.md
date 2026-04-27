# Platform Layer Architecture

> **Internal source map:** This document describes the internal source layout under `packages/sdk/src/_internal/platform/`. It is an orientation guide for contributors navigating the codebase — **not** a consumer import reference.
>
> Consumers access these modules via `./platform/*` barrel exports as documented in [Public Surface Reference](./public-surface.md). See [Runtime Surfaces](./surfaces.md) for the distinction between the full surface (Bun) and companion surfaces (Hermes/browser/React Native).

This document maps every top-level directory under `packages/sdk/src/_internal/platform/`. Each directory is a bounded subsystem with a single responsibility. Use this as an orientation guide when navigating the codebase.

> **Note:** `packages/sdk/src/_internal/` also contains non-platform directories (`contracts/`, `transport-*/`) that are covered in [architecture.md](./architecture.md). This document focuses solely on the `platform/` subtree.

---

## Directory Map

| Directory | Purpose |
|---|---|
| `acp/` | Agent Communication Protocol — message envelope types, handshake state machine, per-agent connection lifecycle, and `AcpManager` |
| `adapters/` | Shared adapter helpers and types; concrete platform adapters live under `adapters/<platform>/` (Slack, Discord, Telegram, etc.) — see Channel System |
| `agents/` | Sub-agent orchestration: `AgentOrchestrator`, `AgentMessageBus`, WRFC controller and all WRFC support files, worktree management, agent archetypes |
| `artifacts/` | Ephemeral artifact store — typed blobs (images, files, diffs) produced during agent runs, keyed by artifact ID |
| `auth/` | Focused auth classes: `TokenStore`, `SessionManager`, `OAuthClient`, `PermissionResolver`; thin `GoodVibesAuthClient` facade re-exported here |
| `automation/` | Scheduled job engine: job definitions, run records, schedule management, delivery, reconcile loop, and the `AutomationManager` runtime |
| `batch/` | Opt-in daemon batch queue manager, provider batch adapters, local queueing, and batch job lifecycle helpers |
| `bookmarks/` | Session bookmark manager — named save-points within a session for quick navigation and branching |
| `channels/` | Channel surface registry, delivery router, delivery strategies (core / bridge / enterprise), plugin registry, and builtin channel runtime |
| `cloudflare/` | Optional Cloudflare control plane integration: token creation, account/zone/resource discovery, Workers, Queues, DNS, Tunnel, Access, KV, Durable Objects, R2, Secrets Store, and verification |
| `companion/` | Companion-app chat routes and types: bidirectional messaging between companion mobile/web clients and the daemon |
| `config/` | `ConfigManager`, `SecretsManager`, secret-ref resolution, service registry, API-key management, subscription auth, OAuth local listener, and config schema |
| `control-plane/` | Control-plane gateway and auth snapshot: operator-level commands, approval broker, conversation-message relay, and web-UI gateway bridge |
| `core/` | Orchestrator turn loop, `ConversationManager`, `ToolRegistry`, `PermissionManager`, `CompactionManager`, `SessionLineageTracker` — the core agent engine |
| `daemon/` | HTTP server bootstrap (`DaemonServer`), `api-router`, `http-policy`, and all route-group files (runtime, session, control, channel, knowledge, telemetry, etc.) |
| `discovery/` | Workspace and MCP-server scanner — detects available MCP servers, indexes project structure for tool and plugin discovery |
| `export/` | Session export formatters: JSON, Markdown, and HTML renderers with optional sensitive-data redaction |
| `git/` | Git service — branch, commit, diff, and file-history operations used by tools and the intelligence layer |
| `hooks/` | Lifecycle hook system: `HookDispatcher`, chain engine, event matcher, workbench, and runners for prompt / agent / HTTP / TypeScript / command hook types |
| `integrations/` | Third-party integration connectors (non-channel services: Linear, Jira, Notion, etc.) |
| `intelligence/` | Code-intelligence facade over tree-sitter and LSP: symbol extraction, outline parsing, language detection, diagnostics, and hover — with graceful degradation when either backend is absent |
| `knowledge/` | Persistent queryable memory store: ingestion pipelines (files, URLs, browser-local history/bookmark metadata, agent output), GraphQL query API, projections for prompt injection, consolidation/deduplication, and scheduling |
| `mcp/` | MCP client (stdio JSON-RPC 2.0 transport), server registry, and per-server configuration; connects external MCP server processes and exposes their tools to the LLM |
| `media/` | Media provider registry: metadata, image-understanding, transform, generate, and attachment-store capability surfaces for images and binary attachments |
| `multimodal/` | Multimodal content service — encodes images and files into provider-specific prompt structures for vision-capable models |
| `pairing/` | Companion pairing: token generation, `CompanionConnectionInfo` encoding, QR matrix generation and ASCII rendering, token revocation |
| `permissions/` | `PermissionManager`, layered policy evaluation (allow/deny/auto-approve), per-call approval prompting, and brief generation for operator review |
| `plugins/` | Plugin loader, `PluginManager` lifecycle (registration → activation → hook dispatch → deactivation), `PluginApi`, hook dispatcher |
| `profiles/` | Named configuration profiles — display, provider model, and behavior overrides that can be switched per session |
| `providers/` | `ProviderRegistry` and per-provider adapters (Anthropic, OpenAI, Gemini, InceptionLabs, Ollama, etc.); stop-reason canonical mapper |
| `runtime/` | Runtime subsystems: `RuntimeStore` (Redux-style state), `RuntimeEventBus`, compaction strategies, session memory, diagnostics panels, perf monitor, task adapters |
| `scheduler/` | Cron-based task scheduler: cron expression evaluation, task persistence, missed-run tracking, and prompt dispatch to the agent engine |
| `security/` | Security utilities: input sanitization, CSP helpers, private-host policy enforcement |
| `sessions/` | Session persistence: session-file I/O, last-session pointer, recovery files, session-directory resolution under `surfaceRoot` |
| `state/` | Cross-cutting persistence layer: SQLite and KV stores, file cache, file-undo log, file watcher, memory vector store, project index, mode manager, and telemetry recorder |
| `templates/` | Agent template manager — stores and resolves named agent archetypes (engineer, reviewer, etc.) referenced by the scheduler and sub-agent orchestrator |
| `tools/` | Built-in platform tools (exec, file, search, etc.) and shared tool helpers; the tool list surfaced to the LLM per session |
| `types/` | Shared internal TypeScript types that cross multiple platform subsystems and cannot live in a single owner directory |
| `utils/` | General internal utilities (logging, async helpers, string manipulation) with no platform-subsystem affiliation |
| `voice/` | Voice provider registry: TTS, streaming TTS, STT, realtime voice adapters, service facade, and builtin provider registrations |
| `watchers/` | File system watcher registry and persistent store — tracks active watch subscriptions across sessions |
| `web-search/` | Web search provider registry and service: supports Tavily, Exa, Brave, DuckDuckGo, SearXNG, Perplexity, and Firecrawl |
| `workflow/` | Trigger executor — evaluates hook-event conditions against registered `TriggerDefinition`s and dispatches shell or agent actions on match |
| `workspace/` | Workspace-level helpers for project roots, worktree context, and runtime workspace metadata |

---

## Dependency Sketch

The diagram below shows the major dependency directions. Arrows point from **consumer** to **dependency**. All dependencies are intra-`_internal/platform/` unless otherwise noted.

```
core ──────────────────────────────────────────► providers
core ──────────────────────────────────────────► config
core ──────────────────────────────────────────► types
agents ─────────────────────────────────────────► core
agents ─────────────────────────────────────────► acp
agents ─────────────────────────────────────────► runtime (store, bus)
daemon ─────────────────────────────────────────► core, agents, channels, automation, plugins
daemon ─────────────────────────────────────────► control-plane, sessions, security
daemon ─────────────────────────────────────────► knowledge, mcp, media, voice, web-search, cloudflare
automation ─────────────────────────────────────► core, runtime
batch ──────────────────────────────────────────► providers, runtime
channels ───────────────────────────────────────► adapters, config, runtime
cloudflare ─────────────────────────────────────► config, batch
auth ───────────────────────────────────────────► config (token storage paths)
pairing ────────────────────────────────────────► config (surface-root resolution)
runtime ────────────────────────────────────────► types, utils
providers ──────────────────────────────────────► config (API keys, model routing)
integrations ───────────────────────────────────► config, runtime
companion ──────────────────────────────────────► core, auth
artifacts ──────────────────────────────────────► types, utils
bookmarks ──────────────────────────────────────► sessions, runtime
security ───────────────────────────────────────► utils
hooks ──────────────────────────────────────────► types, utils
permissions ────────────────────────────────────► config, hooks, runtime
knowledge ──────────────────────────────────────► state, config (persistence paths)
state ──────────────────────────────────────────► types, utils
scheduler ──────────────────────────────────────► state, core
workflow ───────────────────────────────────────► hooks (trigger matching)
intelligence ───────────────────────────────────► utils (language detection, graceful fallback)
discovery ──────────────────────────────────────► config, mcp
watchers ───────────────────────────────────────► state, runtime
export ─────────────────────────────────────────► sessions, types
git ────────────────────────────────────────────► utils
web-search ─────────────────────────────────────► config (provider API keys)
media ──────────────────────────────────────────► config, runtime
voice ──────────────────────────────────────────► config, runtime
profiles ───────────────────────────────────────► config, state
templates ──────────────────────────────────────► state
multimodal ─────────────────────────────────────► types, providers
mcp ────────────────────────────────────────────► config (server definitions)
```

**Key rules:**
- `types/` and `utils/` have no intra-platform dependencies — they are leaf nodes.
- `core/` depends on `providers/` and `config/` but not on `daemon/`, `channels/`, or `agents/`.
- `runtime/` is a shared service consumed broadly; it does not depend on `core/` or `agents/`.

---

## Sync-from-Packages Pattern

Some files in `_internal/` are **synced copies** of upstream sources in `packages/transport-*` or `packages/contracts`. The sync is managed by `scripts/sync-sdk-internals.ts` (`bun run sync:internal`).

### How the sync works

- `PACKAGE_SPECS` in the script defines which source packages and source directories are synced, and where their contents land under `packages/sdk/src/_internal/`.
- Each synced file receives a header comment identifying its upstream source and warning that manual edits will be overwritten on the next sync.
- Package import specifiers (`@pellux/goodvibes-contracts`, `@pellux/transport-*`, etc.) are rewritten to relative paths so the copied files resolve correctly from inside the `_internal/` tree.
- `SPECIFIER_TARGETS` maps package names to their corresponding `_internal/` entry-point files for import rewriting.
- A `--check` mode is available (`bun run sync:internal --check`) for CI drift detection — it reports files that differ without writing them.

### When sync drift matters

Drift between an upstream package and its synced copy is not expected in normal development. If you edit a synced file directly, re-running `sync:internal` will revert your change; update the upstream package source first whenever possible.

---

## Extraction Candidates vs. Internal-Only

Not all directories are equal candidates for eventual extraction to their own npm package. The following table captures current thinking:

| Directory | Extraction candidate? | Rationale |
|---|---|---|
| `acp/` | Possibly | Protocol is stable and could be useful to third-party agent runtimes |
| `adapters/` | Yes (per-adapter) | Each adapter is already isolated; natural package boundary |
| `auth/` | Possibly | Auth logic is self-contained but depends on `config/` path resolution |
| `automation/` | Yes | The job-scheduling engine is generic and useful outside GoodVibes |
| `batch/` | Possibly | Batch job records and provider adapters are generic, but daemon routing and provider policy are GoodVibes-specific |
| `channels/` | Possibly | Delivery routing is generic, but `builtin-runtime.ts` is GoodVibes-specific |
| `cloudflare/` | No | Closely tied to GoodVibes config keys, onboarding shape, Worker script generation, and daemon batch wiring |
| `companion/` | No | Tightly coupled to daemon routes and GoodVibes session model |
| `config/` | No | Uses GoodVibes-specific schema domains and secret-ref conventions |
| `control-plane/` | No | Tightly coupled to GoodVibes operator contract types |
| `core/` | No | The orchestrator is the product; not extractable without the whole SDK |
| `daemon/` | No | Entry point for the daemon binary; too coupled to surface routing |
| `integrations/` | Yes (per-integration) | Each integration is isolated; natural package boundary |
| `pairing/` | Possibly | QR-code pairing logic is self-contained |
| `plugins/` | Possibly | The hook dispatcher and lifecycle manager are generic |
| `providers/` | Possibly | Provider adapters follow a uniform interface; could form a provider package |
| `runtime/` | No | The store and event bus are tightly coupled to the daemon lifecycle |
| `security/` | No | Thin utility layer; not enough surface to warrant a package |
| `sessions/` | No | Storage paths are GoodVibes-specific (`surfaceRoot` convention) |
| `tools/` | No | Tool behavior is tied to the GoodVibes permission and config model |
| `types/` | No | Cross-cutting internal types; no external consumer would import these |
| `utils/` | No | Internal utilities only |
| `workspace/` | No | Carries GoodVibes workspace conventions and host runtime metadata |

**Bottom line:** adapters, integrations, and the automation engine are the strongest extraction candidates. Everything in `core/`, `daemon/`, `runtime/`, and `sessions/` is tightly coupled to the GoodVibes product model and should remain internal.
