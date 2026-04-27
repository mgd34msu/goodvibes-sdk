# Runtime Orchestration

GoodVibes runtime orchestration is the daemon-side loop that turns user input
into provider calls, tool execution, agent work, workflow events, and persisted
session state.

Sources:

- `packages/sdk/src/_internal/platform/core/`
- `packages/sdk/src/_internal/platform/agents/`
- `packages/sdk/src/_internal/platform/runtime/`
- `packages/sdk/src/_internal/platform/sessions/`
- `packages/sdk/src/_internal/platform/workflow/`
- `packages/sdk/src/_internal/platform/hooks/`
- `packages/sdk/src/_internal/platform/profiles/`
- `packages/sdk/src/_internal/platform/templates/`

## Turn Loop

The core orchestrator owns normal chat/task turns. It resolves the active
provider/model, checks context limits, builds prompt context, streams provider
deltas, executes requested tools, reconciles unresolved tool calls, records
usage, emits runtime events, and performs post-turn context maintenance.

Important pieces:

- `ConversationManager` stores the conversation messages for a session.
- `executeOrchestratorTurnLoop()` drives provider streaming and tool execution.
- `executeToolCalls()` routes tool calls through the registered tool runtime.
- `checkContextWindowPreflight()` protects turns that exceed model limits.
- `OrchestratorFollowUpRuntime` routes follow-up messages back into active
  sessions.
- `ExecutionPlanManager` tracks structured plans with pending, in-progress,
  complete, failed, and skipped statuses.

## Sessions

Session persistence lives under the configured surface root. The session layer
stores session files, recovery files, last-session pointers, lineage, and
session-directory resolution. The runtime distinguishes shared TUI sessions
from isolated remote sessions:

- Shared sessions use the daemon/TUI current provider and model.
- Companion remote sessions keep session-local provider/model selection.
- Home Assistant remote sessions are isolated and expire after the configured
  inactivity TTL.
- ntfy remote chat uses daemon-owned remote chat while ntfy chat-to-TUI uses
  the active shared session.

## Agents

Agents run work outside the current assistant turn. `AgentOrchestrator` owns
agent lifecycle, provider routing, archetype loading, tool dependencies,
communication policy, channel delivery hooks, and runtime event emission.

Agent features include:

- single-agent spawn
- batch spawn
- status, list, get, cancel, wait, and message operations
- cohorts for related agents
- template/archetype loading from built-ins and `.goodvibes/agents/*.md`
- per-agent provider/model routing
- agent-to-agent communication policy
- budget and plan inspection
- channel reply tracking

The `agent` tool exposes these operations to the LLM when the host registers
the full tool runtime.

## Archetypes And Templates

Agent archetypes describe named worker roles. Built-ins cover common roles such
as engineer, reviewer, tester, summarizer, researcher, debugger, and writer.
Project-level markdown files can add or override archetypes with frontmatter
for name, description, tools, provider, model, and prompt content.

Templates provide reusable agent/task shapes for scheduler, workflow, and
sub-agent orchestration flows.

## WRFC

WRFC chains run engineering, review, and fix phases with quality gates. Chain
states are pending, engineering, reviewing, fixing, awaiting gates, gating,
passed, failed, and committing.

The WRFC controller tracks:

- engineer, reviewer, and fixer agent ids
- review scores and review cycles
- fix attempts and gate retry depth
- quality-gate results
- completion reports
- propagated constraints
- synthetic critical issues for constraint-continuity violations

Constraint propagation is documented in
[WRFC constraint propagation](./wrfc-constraint-propagation.md).

## Runtime Events

The runtime bus publishes typed events for turns, sessions, agents, workflows,
tools, communication, providers, routes, state, security, telemetry, and
integration delivery. Clients consume these through the operator realtime
transport, control-plane event streams, or surface-specific streams.

Generated event schemas live in
[Runtime events reference](./reference-runtime-events.md).

## Hooks

Hooks attach host-defined behavior to runtime events. Hook paths use:

```text
<phase>:<category>:<specific>
```

Supported phases:

- `Pre`
- `Post`
- `Fail`
- `Change`
- `Lifecycle`

Supported categories include tool, file, git, agent, compact, LLM, MCP, config,
budget, session, workflow, permission, transport, orchestration, and
communication.

Hook runner types:

- command
- prompt
- agent
- HTTP
- TypeScript

Pre hooks can allow, deny, ask, modify input, or add context. Hook chains match
multi-event sequences and fire a configured action when their conditions pass.
The hook workbench can load, save, reload, scaffold, simulate, inspect, import,
and export managed hook config.

## Workflow Triggers

Workflow triggers evaluate hook events and run configured actions when
conditions match. Conditions support field-path lookup, comparisons, boolean
logic, and event-derived values. Actions can dispatch shell work or agent work
depending on the registered trigger definition.

## Runtime Store And State

Runtime state is split between transient event/state managers and durable
stores. The runtime subtree includes:

- auth state
- compaction strategies
- diagnostics panels
- ecosystem catalog state
- event bus and emitters
- feature flags
- health checks
- idempotency
- integration status
- MCP runtime state
- notifications
- provider accounts and health
- remote runners
- retention policies
- sandbox state
- settings
- task adapters
- telemetry
- tool budgets
- transports
- worktree state

The state subsystem supplies SQLite/KV stores, file state cache, file undo,
file watcher, project index, memory vector store, mode manager, and telemetry
recorder.

## Profiles, Bookmarks, And Export

Profiles hold named display, provider/model, and behavior overrides that can be
switched per session. Bookmarks are named save-points inside sessions for quick
navigation and branching. Export renderers produce JSON, Markdown, and HTML
session exports with optional sensitive-data redaction.

## Code Intelligence

The intelligence layer provides language detection, tree-sitter parsing, LSP
diagnostics, symbol extraction, outline parsing, and hover support. It degrades
when a backend is unavailable and is used by tools, analysis flows, and shell/
code-aware runtime features.

## ACP And Remote Runners

ACP manages agent communication protocol envelopes, handshake state,
connections, and manager lifecycle. Remote runtime support covers runner pools,
assignment, contracts, artifacts, review, and artifact import. The companion
surface can use daemon-hosted remote sessions without mutating shared TUI
provider/model state.
