# Runtime orchestration

GoodVibes runtime orchestration is the daemon-side loop that turns user input
into provider calls, tool execution, agent work, workflow events, and persisted
session state.

Public API surfaces:

- `@pellux/goodvibes-sdk/platform/core`
- `@pellux/goodvibes-sdk/platform/runtime`
- `@pellux/goodvibes-sdk/platform/orchestration`

> See [Public surface reference](./public-surface.md) for stability status and the full list of exported platform subpaths.

## Turn loop

The core orchestrator owns normal chat/task turns. It resolves the active
provider/model, checks context limits, builds prompt context, streams provider
deltas, executes requested tools, reconciles unresolved tool calls, records
usage, emits runtime events, and performs post-turn context maintenance.

All SDK-owned turn paths append a small harness-awareness instruction to the
system prompt. The instruction tells the model to use `goodvibes_context`
before answering questions about GoodVibes settings, configured integrations,
host capabilities, surfaces, provider/model state, or available tools. It also
tells the model not to spawn agents or WRFC chains for ordinary questions,
environment inspection, or direct research that can be answered in the current
turn with tools.

Important pieces:

- `ConversationManager` stores the conversation messages for a session.
- `executeOrchestratorTurnLoop()` drives provider streaming and tool execution.
- `executeToolCalls()` routes tool calls through the registered tool runtime.
- `checkContextWindowPreflight()` protects turns that exceed model limits.
- `OrchestratorFollowUpRuntime` routes follow-up messages back into active
  sessions.
- `ExecutionPlanManager` tracks structured plans with `pending`, `in_progress`,
  `complete`, `failed`, and `skipped` statuses.

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

`POST /api/sessions/:id/messages` defaults to normal conversation routing when
`kind` is omitted. This keeps shared-session messages from becoming agent/WRFC
work accidentally. Callers must send `kind: "task"` when they intentionally
want session-broker task continuation and possible agent spawning. See
[Companion message routing](./companion-message-routing.md) for the full `kind`
taxonomy (`message` / `task` / `followup`) and the per-kind response shapes.

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

## Archetypes and templates

Agent archetypes describe named worker roles. Built-ins cover roles such as
orchestrator, engineer, reviewer, tester, researcher, integrator, and general.
Project-level markdown files can add or override archetypes with frontmatter
for name, description, tools, provider, model, and prompt content.

Templates provide reusable agent/task shapes for scheduler, workflow, and
sub-agent orchestration flows.

## WRFC

WRFC chains run engineering, review, and fix phases with quality gates. Chain
states are pending, engineering, integrating, reviewing, fixing, awaiting_gates,
gating, passed, failed, and committing.

Each WRFC request has one authoritative owner chain. The owner stays visible
and non-terminal until the chain passes, fails, or is cancelled. Engineer,
reviewer, fixer, integrator, and verifier agents are lifecycle children of that owner;
they are not sibling root agents and do not independently decide when the chain
is done. Reviews always evaluate the complete current result against the
original WRFC ask.

Batch spawning remains valid for genuinely independent deliverables. Role
fanout for one deliverable, such as `Engineer + Reviewer` or
`Engineer + Tester`, is normalized into a WRFC owner chain instead of launching
parallel reviewer/tester roots before there is work to review.

The WRFC controller tracks:

- owner, phase, and child-agent ids
- engineer, reviewer, fixer, and integrator agent ids
- review scores and review cycles
- fix attempts and gate retry depth
- quality-gate results
- completion reports
- propagated constraints
- synthetic critical issues for constraint-continuity violations
- subtasks and per-subtask review state for compound chains
- claim-verification status (`claimsVerified`)

For large tasks, the owner can run a **compound chain**. It decomposes the
work into `WrfcSubtask` records, each with its own engineer, reviewer, and
fixer cycle, then spawns an **integrator** to merge the passed subtasks before
the chain's final full-scope review. Each subtask's `WrfcSubtaskState` tracks
where it sits in that cycle; this is the authoritative state table, and other
docs link here.

| Subtask state | What it means |
| --- | --- |
| `pending` | Created but no engineer has been spawned for it yet |
| `engineering` | An engineer agent is implementing the subtask |
| `reviewing` | A reviewer agent is evaluating the engineer's result |
| `fixing` | A fixer agent is addressing confirmed review findings |
| `passed` | The subtask cleared review and waits for the integrator |
| `failed` | The subtask exhausted its cycle without clearing review | A separate **verifier** role checks
engineer and fixer self-reports against the actual on-disk changes. The
`claimsVerified` flag records whether those work claims were confirmed (`false`
flags phantom work, claimed changes that are not present). The full `WORKFLOW_*`
event set for these transitions lives in the
[Runtime events reference](./reference-runtime-events.md).

Constraint propagation is documented in
[WRFC constraint propagation](./wrfc-constraint-propagation.md).

## Orchestration engine

`@pellux/goodvibes-sdk/platform/orchestration` is a separate phase/work-item
pipeline layered over the WRFC chain controller described above, not a
replacement for it. A workstream holds one or more ordered phases, each with a
`PhaseKind` that determines the role of the agent serving it. A work item
advances to its next phase the instant that phase's gate passes, claimed by
whichever capacity slot is free next, rather than being bound to one reviewer
for its whole history the way a WRFC chain is.

| Phase kind | What the phase does |
| --- | --- |
| `plan` | Decompose or design before implementation begins |
| `engineer` | Implement the work item |
| `review` | Evaluate the implementation; served by a general-role agent rather than an engineer |
| `fix` | Address findings from a review phase |
| `gate` | Apply a pass/fail quality check; served by a general-role agent |
| `integrate` | Merge finished work items into the combined result |
| `custom` | A host-defined phase that fits none of the built-in kinds |

Today the engine's live integration point is the WRFC fix phase. When a
reviewer finds issues, `planFixWorkstream` turns those findings into a task
graph and runs it as a workstream through `FixWorkstreamRunner`; a chain
without a fix-workstream runner wired into its composition fails outright
rather than degrading silently. A second integration path, `fromChainSpec`,
can convert a whole WRFC chain into a workstream spec for callers that want
the engine-backed pipeline directly instead of the standalone chain state
machine; as of this writing that path is additive and opt-in, and the
standard chain lifecycle above remains what `/teamwork`, forced-WRFC spawns,
and built-in archetypes actually run.

Beyond the phase pipeline itself, the engine adds capabilities the chain
controller does not have:

- **Best-of-N attempts.** A work item declared with `attempts: N` runs N
  independent siblings in isolated worktrees. A passing sibling is held
  rather than auto-merged; once every sibling in the group finishes, a
  winner is picked explicitly or proposed by an optional judge model, then
  merged through the normal integration lane while the other worktrees are
  cleaned up.
- **Elastic fleet sizing.** A ready task with no available agent spawns one,
  up to a configured fleet ceiling; hitting the ceiling is a visible "N
  ready, M running, at cap" state rather than a silent stall, and an agent
  with nothing left to claim retires instead of idling.
- **Budget ceilings.** Spend is checked before a work item is claimed into a
  new phase, never mid-phase, so an in-flight phase always finishes even if
  a later item would be refused for budget reasons.
- **Dynamic dependency graphs.** Dependency and conflict-serialization edges
  can be added while a workstream is running, with orphan detection and
  cycle prevention.

Workstream state is snapshotted for resume across restarts, and drafts (a
workstream not yet launched) are held in a capped, swept store so a proposed
plan can be edited before it runs.

## Runtime events

The runtime bus publishes typed events for turns, sessions, agents, workflows,
tools, communication, providers, routes, state, security, telemetry, and
integration delivery. Clients consume these through the operator realtime
transport, control-plane event streams, or surface-specific streams.

Turn stream events are scoped to provider iterations. `STREAM_START` and
`STREAM_END` carry `scope: "provider"` and `terminal: false`; a single logical
turn can emit more than one stream pair when the model requests tools and then
continues after tool results. Clients that need to flush partial rendering or
audio can react to `STREAM_END`, but they must keep the turn alive until
`TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, or `PREFLIGHT_FAIL`.

Generated event schemas live in
[Runtime events reference](./reference-runtime-events.md).

## OpenAI-compatible ingress

The authenticated daemon exposes an OpenAI-compatible ingress at `/v1` by
default. This is an interoperability layer for tools that already know how to
call OpenAI's Chat Completions API and need a simple way to send prompts
through the GoodVibes daemon before they have a native GoodVibes integration.

Supported routes:

- `GET /v1/models`
- `POST /v1/chat/completions`

Set the client base URL to the daemon prefix, for example
`http://127.0.0.1:3421/v1` (default control-plane port; configurable via `controlPlane.port`), and use the daemon bearer token as the API key.
The route accepts `goodvibes/current` and provider-qualified registry keys such
as `openai:gpt-5.4`. Streaming responses use
OpenAI-style `text/event-stream` chunks ending with `data: [DONE]`.

This layer is intentionally narrow. It maps OpenAI-style requests to the active
GoodVibes provider registry for direct provider calls; it is not a replacement
for native GoodVibes sessions, tools, surfaces, agent routing, Home Graph, or
control-plane APIs. Configure it with:

- `controlPlane.openaiCompatible.enabled`, default `true`
- `controlPlane.openaiCompatible.pathPrefix`, default `/v1`

## Hooks

Hooks attach host-defined behavior to runtime events. Hook paths use:

```text
<phase>:<category>:<specific>
```

The phase says when a hook fires relative to the event it names, and what its
result may do.

| Phase | When it fires and what it can do |
| --- | --- |
| `Pre` | Before the action; its result can allow, deny, or ask, and can modify the tool input |
| `Post` | After the action completes |
| `Fail` | When the action errors |
| `Change` | When observed state changes |
| `Lifecycle` | On lifecycle transitions such as startup and shutdown |

Supported categories are tool, file, git, agent, compact, llm, mcp, config,
budget, session, workflow, permission, transport, orchestration, and
communication; each is the event namespace its name says.

Five runner types execute hooks, differing in where the handler logic lives.

| Runner | How it executes |
| --- | --- |
| `command` | Runs a user-authored shell command with the event available to it; commands execute with full process privileges by design |
| `prompt` | Sends the event JSON into an LLM prompt template and parses the response as the hook result; a non-JSON response means fire-and-forget success |
| `agent` | Spawns a subagent whose task is the prompt template with the event substituted in, waiting up to the hook's timeout |
| `http` | POSTs the event JSON to a configured URL and parses the response as the hook result |
| `ts` | Loads a TypeScript module whose default export handles the event in-process |
- HTTP
- TypeScript

Pre hooks can allow, deny, ask, modify input, or add context. Hook chains match
multi-event sequences and fire a configured action when their conditions pass.
The hook workbench can load, save, reload, scaffold, simulate, inspect, import,
and export managed hook config.

## Workflow triggers

Workflow triggers evaluate hook events and run configured actions when
conditions match. Conditions support field-path lookup, comparisons, boolean
logic, and event-derived values. Actions can dispatch shell work or agent work
depending on the registered trigger definition.

## Runtime store and state

Runtime state is split between transient event/state managers and durable
stores. The runtime subtree includes:

- auth state
- compaction strategies
- diagnostics panels
- ecosystem catalog state
- event bus and emitters
- capability gates (feature settings)
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

## Profiles, bookmarks, and export

Profiles hold named display, provider/model, and behavior overrides that can be
switched per session. Bookmarks are named save-points inside sessions for quick
navigation and branching. Export renderers produce JSON, Markdown, and HTML
session exports with optional sensitive-data redaction.

## Code intelligence

The intelligence layer provides language detection, tree-sitter parsing, LSP
diagnostics, symbol extraction, outline parsing, and hover support. It degrades
when a backend is unavailable and is used by tools, analysis flows, and shell/
code-aware runtime features.

## ACP and remote runners

ACP manages agent communication protocol envelopes, handshake state,
connections, and manager lifecycle. Remote runtime support covers runner pools,
assignment, contracts, artifacts, review, and artifact import. The companion
surface can use daemon-hosted remote sessions without mutating shared TUI
provider/model state.
