# GoodVibes SDK — Architecture Overview

> **Surface scope:** The SDK exposes two consumer-visible surfaces — the full surface (Bun runtime) and the companion surface (Hermes/browser/React Native). This document describes the **internal source organization** that backs the full surface. For the distinction between surfaces and their public barrel exports, see [Runtime Surfaces](./surfaces.md) and [Public Surface Reference](./public-surface.md).
>
> Consumers import via `./platform/*` public barrels (e.g. `@pellux/goodvibes-sdk/platform/core/adaptive-planner`), **not** the `_internal/platform/*` paths shown in this document. The `_internal/platform/*` paths are the underlying source layout — accurate descriptions of where things live, but not the import surface exposed to SDK consumers.

This document describes the internal architecture of the GoodVibes SDK: how its packages, subsystems, and runtime components relate to each other, and how you use them to build AI agent products.

## What the SDK Enables

The GoodVibes SDK is the shared substrate for every surface that hosts a GoodVibes AI agent. A single daemon process can serve multiple client surfaces simultaneously:

- **TUI applications** — terminal-resident coding and chat agents (e.g. goodvibes-tui)
- **Web UIs** — browser-based operator dashboards and companion interfaces
- **Mobile apps** — iOS, Android, and React Native companion apps
- **Automation** — headless background agents, scheduled jobs, webhook-driven tasks
- **Embedded** — third-party apps that embed the daemon via the operator or peer SDKs

All of these share the same orchestration core, permission system, knowledge store, and transport layer. Client surfaces connect via typed contracts; the daemon handles everything else.

---

## Layer Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│                        LLM PROVIDERS                                   │
│   Anthropic · OpenAI · Gemini · InceptionLabs · Ollama · …            │
└───────────────────────┬───────────────────────────────────────────────┘
                        │  ProviderRegistry (chat, stream, model list)
┌───────────────────────▼───────────────────────────────────────────────┐
│                        ORCHESTRATOR CORE                               │
│   Orchestrator (turn loop) · ConversationManager · ToolRegistry        │
│   PermissionManager · CompactionManager · SessionLineageTracker        │
└──────┬────────────────────────────────────┬────────────────────────────┘
       │ tool calls                          │ agent spawns
┌──────▼────────────┐              ┌────────▼─────────────────────────┐
│   TOOL LAYER      │              │   AGENT SYSTEM (ACP)              │
│  ToolRegistry     │              │  AgentOrchestrator · AgentManager │
│  MCP tools        │              │  WRFC Controller · MessageBus     │
│  platform tools   │              │  Worktree Manager                 │
└──────┬────────────┘              └────────┬─────────────────────────┘
       │                                    │
┌──────▼────────────────────────────────────▼────────────────────────────┐
│                     DAEMON / CONTROL PLANE                              │
│  DaemonServer (Bun HTTP) · api-router · http-policy                     │
│  Runtime routes · Control routes · Channel routes · Knowledge routes   │
│  System routes · Telemetry routes · Media routes · Session routes      │
└──────┬──────────────────────────────────────────────────────────────────┘
       │  HTTP + SSE / WebSocket
┌──────▼──────────────────────────────────────────────────────────────────┐
│                       TRANSPORT LAYER                                    │
│  transport-core (ClientTransport interface, EventEnvelope)              │
│  transport-http  (HTTP + SSE, auth, retry, reconnect, backoff)          │
│  transport-realtime (domain events, runtime events)                     │
│  transport-direct  (in-process, no network hop)                         │
└──────┬──────────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────────────┐
│                        CLIENT PACKAGES                                   │
│  operator-sdk  — full-access client (TUI, web UI, desktop)              │
│  peer-sdk      — companion / limited-access client (mobile, 3rd-party)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Monorepo Package Structure

| Package | Role |
|---|---|
| `packages/sdk` | Core SDK. All platform logic lives here under `src/_internal/platform/`. |
| `packages/contracts` | Generated TypeScript types for the operator and peer wire contracts. Shared by all packages. |
| `packages/daemon-sdk` | Types and helpers for embedding the daemon HTTP layer into a host process. |
| `packages/operator-sdk` | High-level operator client with full-access API surface. |
| `packages/peer-sdk` | Companion/peer client with limited API surface (companion apps, 3rd-party integrators). |
| `packages/transport-core` | `ClientTransport` interface and `EventEnvelope` types. |
| `packages/transport-http` | HTTP + SSE transport implementation with auth, retry, backoff, and reconnect. |
| `packages/transport-realtime` | Real-time domain and runtime event subscriptions over SSE. |
| `packages/transport-direct` | In-process transport for embedding the daemon with zero network overhead. |
| `packages/errors` | Structured error types shared across the SDK. |

---

## Orchestrator Core

**Source:** `packages/sdk/src/_internal/platform/core/`

The `Orchestrator` class is the central engine of every agent session. It owns the turn loop: receiving user input, sending it to the LLM via `ProviderRegistry`, streaming responses back, executing tool calls, and looping until the model stops requesting tools.

### Key Classes

**`Orchestrator`** (`core/orchestrator.ts`)
- Owns the `ConversationManager` reference and the `ToolRegistry`
- Drives `executeOrchestratorTurnLoop()` on each user input
- Manages abort signals, thinking state, streaming token counts, and compaction preflight checks
- Delegates tool call execution to `PermissionManager` before running each tool
- Tracks session lineage via `SessionLineageTracker` and idempotency via `IdempotencyStore`
- Wires into `AcpManager` to expose the delegate tool for spawning sub-agents

**`ConversationManager`** (`core/conversation.ts`)
- The canonical message store for the active session
- Maintains the ordered list of messages (user, assistant, tool calls, tool results)
- Exposes diff/compaction utilities used by the compaction system
- Tracks follow-up items queued during a turn

**`ToolRegistry`** (`core/` / platform types)
- Registers all available tools for the current session
- Provides the tool list forwarded to the LLM on each turn
- Allows scoped sub-registries for agent runs with restricted tool access

**`ProviderRegistry`** (`config/`)
- Manages configured LLM providers and their models
- Resolves the active model, token limits, and per-request provider routing
- Tracks provider health state in the runtime store

---

## Daemon Architecture

**Source:** `packages/sdk/src/_internal/daemon/` and `packages/daemon-sdk/src/`

The daemon is an HTTP server (built on Bun) that exposes the agent runtime to external clients over HTTP and SSE. It is the single point of access for operator and peer clients.

### Components

**`api-router.ts`** — Central route dispatcher. All incoming requests are matched to a route group and dispatched with an `AuthenticatedPrincipal` context.

**`http-policy.ts`** — Authentication and scope enforcement utilities:
- `resolveAuthenticatedPrincipal()` — extracts and validates the bearer token or session cookie from the request
- `buildMissingScopeBody()` — scope enforcement; returns a structured error when required scopes are absent
- `resolvePrivateHostFetchOptions()` — controls whether a remote fetch is allowed to target private/internal hosts
- Principal kinds: `user` | `bot` | `service` | `token`; each carries `admin: boolean` and a `scopes` array

**Route Groups:**

| Route file | Handles |
|---|---|
| `runtime-routes.ts` | Agent runtime state, model selection, feature flags |
| `runtime-session-routes.ts` | Session creation, branching, history, compaction |
| `control-routes.ts` | Control plane gateway — admin/operator-level operations |
| `channel-routes.ts` | Channel surface management and message delivery |
| `knowledge-routes.ts` | Knowledge graph queries, ingestion, memory sync |
| `system-routes.ts` | Daemon health, capability advertisement, version info |
| `telemetry-routes.ts` | Telemetry streaming and diagnostics |
| `media-routes.ts` | Media upload and retrieval |
| `integration-routes.ts` | Third-party integration management |
| `remote-routes.ts` | Remote fetch proxy with private-host policy enforcement |
| `runtime-automation-routes.ts` | Automation job scheduling and execution |

**WebSocket / SSE Upgrade:** The daemon upgrades HTTP connections to SSE streams for real-time event delivery. `transport-realtime` subscribes to domain events and runtime events over these streams.

---

## Agent System

**Source:** `packages/sdk/src/_internal/platform/agents/`

The agent system enables the orchestrator to spawn parallel sub-agents and coordinate multi-agent workflows.

### ACP Protocol

**Source:** `platform/acp/`

The Agent Communication Protocol (ACP) governs how the orchestrator and sub-agents exchange messages and handshakes. Key files:
- `protocol.ts` — message envelope types and handshake state machine
- `connection.ts` — per-agent connection lifecycle
- `manager.ts` — `AcpManager` tracks all active ACP connections; the orchestrator registers the delegate tool through it

### AgentOrchestrator

`AgentOrchestrator` (`agents/orchestrator.ts`) runs each sub-agent as an independent LLM turn loop:
- Receives an `AgentRecord` describing the task, model routing policy, allowed tools, and context dossier
- Builds a scoped `ToolRegistry` from the parent registry using the agent's allowed tool list
- Resolves the correct LLM provider via `resolveProviderForRecord()`, with optional fallback routes
- Emits structured events on the `RuntimeEventBus` throughout the lifecycle (started, progress, stream delta, completed, failed, cancelled)

### WRFC Workflow

The Write-Review-Fix-Commit (WRFC) controller (`agents/wrfc-controller.ts`) orchestrates multi-agent quality loops:

```
pending → engineering → reviewing → fixing → awaiting_gates → gating → passed
                                    ↑___________↓ (fix cycles)
                                                              ↓ (gate failure)
                                                           failed
```

- **Engineering phase:** engineer agent performs the task and emits a `CompletionReport`
- **Reviewing phase:** reviewer agent scores the output; score history is tracked to detect regressions
- **Fixing phase:** fixer agent addresses reviewer feedback; bounded by `fixAttempts` and `reviewCycles` limits
- **Gating phase:** configured quality gates (e.g. `npm run typecheck`, `npm run lint`) are run; failures trigger a gate-retry chain
- `WrfcChain` tracks the full lifecycle: all agent IDs, gate results, review scores, parent chain ID, gate failure fingerprint, and retry depth

### AgentMessageBus

`AgentMessageBus` (`agents/message-bus-core.ts`) is the pub-sub backbone connecting orchestrator and agents. It routes completion reports, progress updates, and control signals between concurrent agent runs without shared mutable state.

---

## Channel System

**Source:** `packages/sdk/src/_internal/platform/channels/`

The channel system lets agents send and receive messages through external communication platforms.

### Surface Registry

`SurfaceRegistry` is the central registry of configured channel surfaces. Each surface maps a named identifier to a platform adapter and its configuration. On `syncConfiguredSurfaces()`, the registry reads the config, instantiates adapters, and returns a list of active `SurfaceRecord` entries.

### Adapters

**Source:** `platform/adapters/`

Adapters bridge GoodVibes messages to platform-specific APIs:

| Adapter | Platform |
|---|---|
| `slack` | Slack (via Web API) |
| `discord` | Discord |
| `telegram` | Telegram Bot API |
| `msteams` | Microsoft Teams |
| `matrix` | Matrix protocol |
| `mattermost` | Mattermost |
| `signal` | Signal |
| `whatsapp` | WhatsApp |
| `imessage` | iMessage (via BlueBubbles) |
| `bluebubbles` | BlueBubbles server |
| `github` | GitHub (issues, PRs, comments) |
| `google-chat` | Google Chat |
| `ntfy` | ntfy push notifications |
| `webhook` | Generic outbound webhook |

### Delivery Strategies

`platform/channels/delivery/` contains three strategy tiers:
- `strategies-core.ts` — basic delivery: direct send, reply-in-thread
- `strategies-bridge.ts` — bridge delivery: fan-out across surfaces
- `strategies-enterprise.ts` — enterprise delivery: approval gates, audit trails, conditional routing

`DeliveryRouter` selects the appropriate strategy based on the surface configuration and message type. The `ReplyPipeline` handles reply routing for inbound messages.

### ntfy Runtime Topics

When `surfaces.ntfy.enabled` is true, the daemon subscribes to three SDK-owned ntfy topics:

| Topic | Runtime path |
|---|---|
| `goodvibes-chat` | Appends the message to the currently active terminal TUI session and emits it as a normal operator chat message. The assistant response is published back to the same ntfy topic. |
| `goodvibes-agent` | Submits agent work through the active TUI shared session when one exists, preserving the existing agent reply pipeline. Child-agent final outputs inherit the parent ntfy reply target. |
| `goodvibes-ntfy` | Starts or reuses a daemon-owned remote chat session through `CompanionChatManager`. This path does not touch the TUI session. |

`surfaces.ntfy.topic` remains an optional default outbound delivery topic and an additional subscribed topic, but arbitrary ntfy topics are ignored by inbound routing unless the adapter explicitly handles them. Outbound GoodVibes ntfy deliveries carry the SDK-owned self-echo marker and are filtered on ingress.

---

## Knowledge System

**Source:** `packages/sdk/src/_internal/platform/knowledge/`

The knowledge system provides persistent, queryable memory that agents can read and write during sessions.

### Components

- **Store** (`store.ts`, `store-schema.ts`, `store-read.ts`, `store-load.ts`) — SQLite-backed storage layer; manages the graph schema, reads, and loads
- **Ingestion** (`ingest.ts`, `ingest-compile.ts`, `ingest-inputs.ts`, `ingest-context.ts`) — pipelines for ingesting new knowledge from files, URLs, and agent outputs
- **GraphQL** (`graphql.ts`, `graphql-schema.ts`) — query interface for knowledge retrieval; exposes the knowledge graph over a GraphQL API consumed by route handlers
- **Memory Sync** (`memory-sync.ts`) — keeps the in-memory projection synchronized with persisted store state
- **Projections** (`projections.ts`) — derived views of the knowledge graph (e.g. context-window projections for injection into prompts)
- **Consolidation** (`consolidation.ts`) — deduplication and merging of overlapping knowledge records
- **Scheduling** (`scheduling.ts`) — periodic background ingestion and refresh jobs
- **Service** (`service.ts`) — the top-level `KnowledgeService` that wires all components together and exposes the public API

---

## Config System

**Source:** `packages/sdk/src/_internal/platform/config/`

### ConfigManager

`ConfigManager` (`config/manager.ts`) is the authoritative source for all runtime configuration. It:
- Reads from layered sources: project config, user config, environment variables, and defaults
- Exposes `get(key)` for typed config access and `getRaw()` for unresolved values
- Provides `getWorkingDirectory()` for path resolution
- Tracks `surfaceRoot` — the `.goodvibes/<surface>/` directory scoped to the active surface

### Secrets

`SecretsManager` (`config/secrets.ts`) manages credential storage with a three-tier security policy:

| Policy | Behavior |
|---|---|
| `plaintext_allowed` | Secrets may be stored in plaintext files (development mode) |
| `preferred_secure` | Prefer encrypted storage; fall back to plaintext if unavailable |
| `require_secure` | Reject all plaintext writes; encrypted storage is mandatory |

Secrets are stored across four candidate stores: project-secure, project-plaintext, user-secure, user-plaintext. The read order follows scope (project takes precedence over user) and medium (secure before plaintext).

### Secret Refs

`secret-refs.ts` implements the secret reference resolution system. A secret value in config may be a direct value or a reference to an external source:

| Ref Type | Source |
|---|---|
| `env` | Environment variable (`$VAR_NAME`) |
| `goodvibes` | Internal GoodVibes secret store |
| `file` | File path with optional JSON selector |
| `exec` | Command execution — stdout is the secret |
| `1password` / `onepassword` | 1Password CLI (`op`) |
| `bitwarden` / `vaultwarden` | Bitwarden CLI (`bw`) |
| `bitwarden-secrets-manager` / `bws` | Bitwarden Secrets Manager CLI |

References are expressed as `goodvibes://secrets/source/...` URIs or `secretref:` JSON objects. `resolveSecretRef()` dispatches to the appropriate resolver at runtime.

### Service Registry

`service-registry.ts` registers named external services (API endpoints, auth schemes) that tools and adapters can look up by name.

---

## State Management

**Source:** `packages/sdk/src/_internal/platform/runtime/store/`

### RuntimeStore

The `RuntimeStore` is a Redux-style store (using a custom reducer + dispatch pattern) that holds all runtime state for the daemon process. State is divided into named domains:

| Domain | Tracks |
|---|---|
| `session` | Active session ID, history, branching state |
| `model` | Active model selection, token usage |
| `conversation` | Message history, turn state, compaction markers |
| `agents` | Active agents, their status and progress |
| `orchestration` | Orchestration chains, plan items |
| `permissions` | Permission decisions, session approvals, policy registry |
| `communication` | Inbound/outbound channel message state |
| `plugins` | Loaded plugins and their manifest state |
| `daemon` | Daemon connectivity and health |
| `automation` | Scheduled job state and run history |
| `routes` | Dynamic route registration |
| `controlPlane` | Control plane connection and command state |
| `deliveries` | Outbound delivery status |
| `surfaces` | Active surface records and their config |
| `acp` | ACP connection registry |
| `mcp` | MCP server connections and tool manifests |
| `integrations` | Third-party integration state |
| `telemetry` | Telemetry collection state |
| `git` | Git repository state for the working directory |
| `discovery` | Plugin and capability discovery results |
| `intelligence` | Model intelligence / feature flag state |
| `surfacePerf` | Per-surface rendering performance metrics |

### Selectors

`store/selectors/` contains memoized selector functions for reading derived state without triggering unnecessary re-renders.

### RuntimeEventBus

The `RuntimeEventBus` is an in-process event emitter that carries typed events across subsystems. Components (orchestrator, agent system, channel system) emit events; listeners (diagnostics, TUI renderer, telemetry) subscribe. It is distinct from the SSE transport — it is synchronous and in-process only.

---

## Session System

**Source:** `packages/sdk/src/_internal/platform/runtime/compaction/` and `platform/core/session-*.ts`

### Compaction

Context compaction reduces the token footprint of long conversations to stay within the LLM's context window. `CompactionManager` (`compaction/manager.ts`) coordinates the strategy selection and execution lifecycle.

Four built-in strategies:

| Strategy | Behavior |
|---|---|
| `autocompact` | Triggered when the context window exceeds a configurable threshold |
| `boundary-commit` | Compacts at natural turn boundaries; preserves key decision points |
| `collapse` | Aggressive collapse of completed tool chains into a summary |
| `reactive` | Responds to explicit compaction requests from the orchestrator |
| `microcompact` | Fine-grained compaction targeting the oldest messages first |

`compaction/quality-score.ts` scores the output of each compaction pass to ensure critical information is not lost. `resume-repair.ts` handles recovery when a compacted session cannot be cleanly resumed.

### Session Lineage

`SessionLineageTracker` (`core/session-lineage.ts`) records the parent-child relationships between sessions created by branching. This enables:
- Navigating back to a parent session after a branch
- Attributing an agent session to the orchestrator session that spawned it
- Building a lineage tree for session history views

### Session Memory

`session-memory.ts` handles ephemeral in-session memory: facts injected into the system prompt for the duration of a session without being persisted to the knowledge store.

---

## Plugin System

**Source:** `packages/sdk/src/_internal/platform/plugins/`

### Discovery and Loading

`PluginLoader` (`plugins/loader.ts`) discovers plugins by scanning the configured plugin directories. It reads each plugin's manifest (a `package.json`-adjacent JSON file) and validates it against the plugin manifest schema before loading.

### Lifecycle

`PluginManager` (`plugins/manager.ts`) manages the full plugin lifecycle:
1. **Registration** — plugin manifests are registered with their capabilities and dependencies
2. **Activation** — on startup, plugins are activated in dependency order
3. **Hook Dispatch** — the `HookDispatcher` fires lifecycle hooks (`pre-tool-use`, `post-tool-use`, `pre-turn`, `post-turn`, etc.) and collects results; hooks can block, modify, or annotate tool calls
4. **Deactivation** — graceful shutdown calls each plugin's deactivation hook

`PluginApi` (`plugins/api.ts`) is the interface that plugins receive on activation: access to config, secrets, tool registration, hook registration, and event subscription.

---

---

## Platform Layer Map

For a directory-by-directory breakdown of every subdirectory under `packages/sdk/src/_internal/platform/` — including one-line purpose descriptions, dependency hints, the sync-from-packages pattern, and extraction candidates — see [architecture-platform.md](./architecture-platform.md).

---

## Pairing System

**Source:** `packages/sdk/src/_internal/platform/pairing/`

The pairing system lets companion apps (mobile, web) establish an authenticated connection to the daemon by scanning a QR code displayed in the TUI or operator interface.

### Flow

1. **Token generation** — `getOrCreateCompanionToken(surface, { daemonHomeDir })` generates a `gv_`-prefixed token using `randomBytes(24)` and persists it to `<daemonHomeDir>/operator-tokens.json` (default: `~/.goodvibes/daemon/operator-tokens.json`) at mode `0600`. Tokens are stable across restarts and regenerated only on explicit request. The `surface` parameter is retained for API compatibility but the token path is global since SDK 0.21.28.

2. **Connection info encoding** — `buildCompanionConnectionInfo()` assembles the `CompanionConnectionInfo` payload: daemon URL, token, username, version, and surface name. `encodeConnectionPayload()` serializes it to JSON.

3. **QR generation** — `generateQrMatrix()` encodes the JSON payload into a QR code matrix using a bundled pure-TypeScript QR library (no native dependencies). `renderQrToString()` renders it as an ASCII block string for display in terminal or web UI.

4. **Connection** — the companion app decodes the QR payload, extracts the URL and token, and connects using `transport-http` with the token as a bearer credential.

5. **Revocation** — `regenerateCompanionToken(surface, { daemonHomeDir })` replaces the stored token, invalidating all existing companion/operator connections on that host.

### CompanionConnectionInfo

```ts
interface CompanionConnectionInfo {
  readonly url: string;      // Daemon HTTP endpoint
  readonly token: string;    // gv_<base64url> bearer token
  readonly username: string; // Defaults to 'admin'
  readonly version: string;  // Daemon version string
  readonly surface: string;  // Surface identifier
}
```
