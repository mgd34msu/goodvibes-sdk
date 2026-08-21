# Platform layer architecture

> **Internal source map:** This document describes the internal source layout under `packages/sdk/src/platform/`. It is an orientation guide for contributors navigating the codebase, **not** a consumer import reference.
>
> Consumers access these modules via explicit `./platform/...` entrypoints as documented in [Public Surface Reference](./public-surface.md). See [Published Surface Matrix](./surfaces.md) for the distinction between the full surface (Bun) and companion surfaces (Hermes/browser/React Native).

This document maps every top-level directory under `packages/sdk/src/platform/`. Each directory is a bounded subsystem with a single responsibility. Use this as an orientation guide when navigating the codebase.

## Directory map

| Directory | Purpose |
|---|---|
| `acp/` | Agent Control Protocol: message envelope types, handshake state machine, per-agent connection lifecycle, and `AcpManager` |
| `adapters/` | Shared adapter helpers and types; concrete platform adapters live under `adapters/<platform>/` (Slack, Discord, Telegram, etc.): see Channel system |
| `agents/` | Sub-agent orchestration: `AgentOrchestrator`, `AgentMessageBus`, the `WrfcController` chain state machine and all WRFC support files, worktree management, agent archetypes |
| `artifacts/` | Ephemeral artifact store: typed blobs (images, files, diffs) produced during agent runs, keyed by artifact ID |
| `automation/` | Scheduled job engine: job definitions, run records, schedule management, delivery, reconcile loop, and the `AutomationManager` runtime |
| `batch/` | Opt-in daemon batch queue manager, provider batch adapters, local queueing, and batch job lifecycle helpers |
| `bookmarks/` | Session bookmark manager: named save-points within a session for quick navigation and branching |
| `browser/` | Browser automation as a platform capability: provisioning, sessions, snapshots, and page operations over an injected Playwright driver, with no product-specific wiring |
| `calendar/` | External-calendar read connectivity: an RFC 5545 (iCalendar) reader and a `SubscriptionStore` for named feeds with per-feed honest status and conditional refresh |
| `channel-profiles/` | Per-channel profile bindings: lets the inbound path attribute an originated session to its sending principal and inherit that channel's model/provider/permission-mode defaults |
| `channels/` | Channel surface registry, delivery router, delivery strategies (core / bridge / enterprise), plugin registry, and builtin channel runtime |
| `channel-sync/` | The two channel tables a daemon mirrors so a surface draws the same screen on a second device: channel-to-profile routing, and the unsent-draft mirror |
| `checkin/` | Proactive check-in ("heartbeat initiative"): on a configured cadence assembles a state briefing and lets the model judge whether to contact the user through channel delivery; off by default, every run leaves a visible receipt |
| `ci-watch/` | CI watching for a repo/PR with an honest per-job verdict (never a rollup); standing watches are polled by the daemon and can offer or auto-start a fix on a red run |
| `cloudflare/` | Optional Cloudflare control plane integration: token creation, account/zone/resource discovery, Workers, Queues, DNS, Tunnel, Access, KV, Durable Objects, R2, Secrets Store, and verification |
| `cluster/` | LAN leader election so exactly one node consumes each inbound surface; elections are held per surface over a LAN-only protocol that never contacts an external service |
| `companion/` | Companion-app chat routes and types: bidirectional messaging between companion mobile/web clients and the daemon |
| `config/` | `ConfigManager`, `SecretsManager`, secret-ref resolution, service registry, API-key management, subscription auth, OAuth local listener, and config schema |
| `control-plane/` | Control-plane gateway and auth snapshot: operator-level commands, approval broker, conversation-message relay, and web-UI gateway bridge |
| `core/` | Orchestrator turn loop, `ConversationManager`, `ToolRegistry`, `PermissionManager`, `CompactionManager`, `SessionLineageTracker`: the core agent engine |
| `daemon/` | HTTP server bootstrap (`DaemonServer`), `api-router`, `http-policy`, and all route-group files (runtime, session, control, channel, knowledge, telemetry, etc.), plus the auto-updater and daemon-receipts modules |
| `devices/` | Paired-device capabilities (camera, screen, location, clipboard, device commands) exposed as agent tools over the existing peer transport, not an MCP server |
| `discovery/` | Workspace and MCP-server scanner: detects available MCP servers, indexes project structure for tool and plugin discovery |
| `email/` | IMAP and SMTP as a platform capability: reading a mailbox and sending plain-text mail directly over the protocols, with no provider API in between |
| `embed/` | SDK Embedding API 1.0: the frozen, curated contract (`createEmbeddedSession`, `bootDaemon`) for hosting a GoodVibes session inside another application |
| `export/` | Session export formatters: JSON, Markdown, and HTML renderers with optional sensitive-data redaction |
| `git/` | Git service: branch, commit, diff, and file-history operations used by tools and the intelligence layer |
| `google/` | Gmail and Google Calendar as a platform capability: connecting an account and reading/writing mail and events, with an app-password fast path and a Google Cloud OAuth path |
| `hooks/` | Lifecycle hook system: `HookDispatcher`, chain engine, event matcher, workbench, and runners for prompt / agent / HTTP / TypeScript / command hook types |
| `hosted-sessions/` | A conversation loop composed inside the daemon process, behind `sessions.hosted.*`, so a session does not depend on the client that opened it staying open |
| `integrations/` | Third-party integration connectors (non-channel services: Linear, Jira, Notion, etc.) |
| `intelligence/` | Code-intelligence facade over tree-sitter and LSP: symbol extraction, outline parsing, language detection, diagnostics, and hover, with graceful degradation when either backend is absent |
| `knowledge/` | Persistent queryable memory store: ingestion pipelines (files, URLs, browser-local history/bookmark metadata, agent output), GraphQL query API, projections for prompt injection, consolidation/deduplication, and scheduling |
| `mcp/` | MCP client (stdio JSON-RPC 2.0 transport), server registry, and per-server configuration; connects external MCP server processes and exposes their tools to the LLM |
| `media/` | Media provider registry: metadata, image-understanding, transform, generate, and attachment-store capability surfaces for images and binary attachments |
| `multimodal/` | Multimodal content service: encodes images and files into provider-specific prompt structures for vision-capable models |
| `node/` | Runtime capability metadata and Node-like runtime-boundary detection helpers (no Bun globals); backs the public `./platform/node` and `./platform/node/runtime-boundary` subpaths |
| `occasions/` | Durable facts about dated things in the owner's life (a birthday, an anniversary) that the daemon raises on its own; exports the shapes and pure render helpers a surface needs, not the service or its store |
| `orchestration/` | Multi-agent workstream engine: phases, gates, work items, budget ceilings, and multi-candidate attempt judging, layered over (not replacing) `agents/wrfc-controller.ts`; see [Runtime orchestration](./runtime-orchestration.md) |
| `owner-profile/` | The platform's read model of the person who owns it, backed by one Markdown file at daemon scope (`~/.goodvibes/daemon/owner-profile.md`) |
| `pairing/` | Companion pairing: token generation, `CompanionConnectionInfo` encoding, QR matrix generation and ASCII rendering, token revocation |
| `payments/` | Payment decision order, budget pools, approval/veto window state machines, taint gate, and prompt rendering |
| `permissions/` | `PermissionManager`, layered policy evaluation (allow/deny/auto-approve), per-call approval prompting, and brief generation for operator review |
| `personal-capture/` | Capture authority (whether a conversational turn may write to the owner profile) and the narrow store/service surface the capture tool calls |
| `plugins/` | Plugin loader, `PluginManager` lifecycle (registration → activation → hook dispatch → deactivation), `PluginApi`, hook dispatcher |
| `power/` | Sleep ownership: automatic work inhibition, sleep-edge handling, and the owner's keep-awake toggle |
| `presentation/` | The shared presentation contract used by both the TUI and the agent renderer: glyphs, tone tokens, thinking-phrase pool, and waiting-state wording |
| `principals/` | Cross-channel principal identity registry: maps channel-specific sender identities (a Slack user id, an email address, a phone number) onto one named principal so attribution survives a channel hop |
| `profiles/` | Named configuration profiles: display, provider model, and behavior overrides that can be switched per session |
| `providers/` | `ProviderRegistry` and per-provider adapters (Anthropic, OpenAI, Gemini, Inception Labs, Ollama, etc.); stop-reason canonical mapper |
| `push/` | Browser push: VAPID custody, subscription store, RFC 8291 encryption, and the delivery path; daemon-side only |
| `relay/` | Daemon-side relay surface: the reachability controller and the WebAuthn step-up policy hook. Node-only; the daemon never mints its own TLS certificates |
| `remote-access/` | Tailscale detection and `tailscale serve` enablement, the recommended path to https without the daemon provisioning its own certificate authority |
| `rewind/` | Unified message-anchored rewind service over the existing workspace-checkpoint, conversation, and file-undo stores; restores files, conversation, or both to a session turn anchor |
| `runtime/` | Runtime subsystems: `RuntimeStore` (Redux-style state), `RuntimeEventBus`, compaction strategies, session memory, diagnostics panels, perf monitor, task adapters |
| `scheduler/` | Cron-based task scheduler: cron expression evaluation, task persistence, missed-run tracking, and prompt dispatch to the agent engine |
| `security/` | Security utilities: input sanitization, CSP helpers, private-host policy enforcement |
| `sessions/` | Session persistence: session-file I/O, last-session pointer, recovery files, session-directory resolution under `surfaceRoot` |
| `skills/` | The canonical skill service: Markdown+frontmatter skill documents, a progressive-disclosure read path, and CRUD, shared by every consumer instead of each carrying its own copy |
| `state/` | Cross-cutting persistence layer: SQLite and KV stores, file cache, file-undo log, file watcher, memory vector store, project index, mode manager, and telemetry recorder |
| `templates/` | Agent template manager: stores and resolves named agent archetypes (engineer, reviewer, etc.) referenced by the scheduler and sub-agent orchestrator |
| `tools/` | Built-in platform tools (exec, file, search, etc.) and shared tool helpers; the tool list surfaced to the LLM per session |
| `triggers/` | Stream watchers, model-free condition checks, and one-shot on-exit process-lifecycle triggers over one supervision spine; gated off by default |
| `types/` | Shared internal TypeScript types that cross multiple platform subsystems and cannot live in a single owner directory |
| `utils/` | General internal utilities (logging, async helpers, string manipulation) with no platform-subsystem affiliation |
| `voice/` | Voice provider registry: TTS, streaming TTS, STT, realtime voice adapters, service facade, and builtin provider registrations |
| `watchers/` | File system watcher registry and persistent store: tracks active watch subscriptions across sessions |
| `web-search/` | Web search provider registry and service: supports Tavily, Exa, Brave, DuckDuckGo, SearXNG, Perplexity, and Firecrawl |
| `workflow/` | Trigger executor: evaluates hook-event conditions against registered `TriggerDefinition`s and dispatches shell or agent actions on match |
| `workspace/` | Workspace-level helpers for project roots, worktree context, and runtime workspace metadata |

> **Note:** There is no `platform/auth/` directory. The client auth classes live outside `platform/`: `TokenStore`, `SessionManager`, and `PermissionResolver` in `src/client-auth/`, and `OAuthClient` in `platform/runtime/auth/oauth-client.ts`, with the `GoodVibesAuthClient` facade in `src/auth.ts`. Server-side user authentication is the separate `security/` subsystem (see the `security/` row), not a `platform/auth/` module.

---

## Dependency sketch

The diagram below shows the major dependency directions. Arrows point from **consumer** to **dependency**. All dependencies are intra-`platform/` unless otherwise noted.

```
core ──────────────────────────────────────────► providers
core ──────────────────────────────────────────► config
core ──────────────────────────────────────────► types
agents ─────────────────────────────────────────► core
agents ─────────────────────────────────────────► acp
agents ─────────────────────────────────────────► runtime (store, bus)
agents ─────────────────────────────────────────► orchestration (WRFC fix-phase execution)
daemon ─────────────────────────────────────────► core, agents, channels, automation, plugins
daemon ─────────────────────────────────────────► control-plane, sessions, security
daemon ─────────────────────────────────────────► knowledge, mcp, media, voice, web-search, cloudflare
automation ─────────────────────────────────────► core, runtime
batch ──────────────────────────────────────────► providers, runtime
channels ───────────────────────────────────────► adapters, config, runtime
cloudflare ─────────────────────────────────────► config, batch
pairing ────────────────────────────────────────► config (surface-root resolution)
runtime ────────────────────────────────────────► types, utils
providers ──────────────────────────────────────► config (API keys, model routing)
integrations ───────────────────────────────────► config, runtime
companion ──────────────────────────────────────► core
artifacts ──────────────────────────────────────► types, utils
bookmarks ──────────────────────────────────────► sessions, runtime
security ───────────────────────────────────────► utils
hooks ──────────────────────────────────────────► types, utils
permissions ────────────────────────────────────► config, hooks, runtime
knowledge ──────────────────────────────────────► state, config (persistence paths)
state ──────────────────────────────────────────► types, utils
scheduler ──────────────────────────────────────► state, core
workflow ───────────────────────────────────────► hooks (trigger matching)
intelligence ───────────────────────────────────► utils (language detection, recovery paths)
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
- `types/` and `utils/` have no intra-platform dependencies. They are leaf nodes.
- `core/` depends on `providers/` and `config/` but not on `daemon/`, `channels/`, or `agents/`.
- `runtime/` is a shared service consumed broadly; it does not depend on `core/` or `agents/`.

---

## Package facade pattern

The main SDK package is a facade over the monorepo packages. Implementation source for `contracts`, `errors`, `transport-*`, `daemon-sdk`, `operator-sdk`, and `peer-sdk` lives in those packages. SDK-owned runtime, platform, and knowledge implementation lives under `packages/sdk/src/platform`.

### How artifact sync works

- `scripts/prepare-sdk-package.ts` copies contract JSON artifacts from `packages/contracts/artifacts` into the SDK package dist.
- `bun run contracts:check` checks that generated contract artifacts are current without writing.

### When sync drift matters

Implementation drift is no longer possible because there is one implementation source. If behavior needs to change, edit the canonical package source. If generated contract JSON changes, run `bun run refresh:contracts`.

---

## Extraction candidates vs. internal-only

Not all directories are equal candidates for eventual extraction to their own npm package. The following table captures current thinking:

| Directory | Extraction candidate? | Rationale |
|---|---|---|
| `acp/` | Possibly | Protocol is stable and could be useful to third-party agent runtimes |
| `adapters/` | Yes (per-adapter) | Each adapter is already isolated; natural package boundary |
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
