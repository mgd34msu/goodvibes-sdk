# Tool System

The tool system is the daemon-side execution layer used by sessions, agents,
WRFC chains, and remote surfaces. Tools are registered through
`registerAllTools()` and guarded by config permissions plus feature-flagged
contract checks.

Source: `packages/sdk/src/_internal/platform/tools/`.

## Built-In Tools

| Tool | Purpose | Main modes or operations |
|---|---|---|
| `read` | Read text, structured files, and media-aware inputs | per-file extraction, image handling, global extraction defaults |
| `write` | Write files with project/cache/undo integration | create, overwrite, append, transaction modes |
| `edit` | Apply targeted edits | exact, fuzzy, regex, notebook operations, validation, rollback |
| `find` | Search the workspace | files, content, symbols, references, structural AST search |
| `exec` | Run shell commands through the process manager | retries, timeouts, expectations, pre-command file ops, AST guard |
| `fetch` | Fetch HTTP resources | raw/text/markdown/structured extraction, rate limits, sanitization, trusted hosts |
| `analyze` | Analyze code and changes | impact, dependencies, dead code, security, diff, preview, upgrade, surface |
| `inspect` | Inspect project shape | project, API, database, components, layout, accessibility, scaffold |
| `agent` | Spawn and manage agents | spawn, batch-spawn, status, cancel, list, templates, get, budget, plan, wait, message, WRFC, cohorts |
| `state` | Store and inspect runtime state | get, set, list, clear, budget, context, memory, telemetry, hooks, mode, analytics |
| `workflow` | Start and control workflows | start, status, transition, cancel, triggers, schedule |
| `registry` | Discover skills/agents/tools | search, recommend, dependencies, preview, content |
| `task` | Manage cross-session tasks | create, list, show, status, depend, cancel, handoff |
| `team` | Manage team/work lanes | create, list, show, add/remove member, set lanes, delete |
| `worklist` | Manage worklists | create, list, show, add, complete, reopen, remove |
| `mcp` | Inspect and operate MCP servers | servers, tools, schema, resources, security, auth, quarantine/trust |
| `packet` | Manage context packets | create, list, show, revise, publish |
| `query` | Ask and answer structured questions | ask, list, show, answer, close |
| `remote` | Manage distributed runners | create-pool, pools, assign, unassign, contracts, artifacts, review, import-artifact |
| `repl` | Evaluate code in an isolated REPL | eval, history |
| `control` | Inspect host control data | commands, panels, subscriptions, sandbox presets |
| `channel` | Use channel-owned runtime tools | surface-specific tool bridge |
| `web_search` | Run provider-backed web search | query, safe-search, evidence fetching |

## Registration Requirements

`registerAllTools()` requires host-owned collaborators instead of silently
constructing global state. Required collaborators include file undo, mode
manager, process manager, agent manager, message bus, workflow services,
config manager, provider registry, tool LLM resolver, sandbox session registry,
session orchestration, working directory, and surface root.

Optional collaborators enable web search, MCP, WRFC, remote runners, channel
tools, overflow handling, change tracking, and service-backed credential
resolution.

## Contract Verification

The `tool-contract-verification` feature flag is enabled by default. When
enabled, built-in and registered tools are checked for schema validity,
permission class mapping, timeout/cancellation semantics, output policy
compatibility, and idempotency declarations before registration completes.

Hosts can disable the flag explicitly, but the safer default is verification on.

## Permissions

Tool permissions are configured under `permissions.tools.*` and enforced by the
runtime permission layer. The default posture allows read/find/analyze/inspect/
state/registry and prompts for write/edit/exec/fetch/agent/workflow/delegate/MCP.

The permissions policy engine, simulation mode, divergence dashboard, and
policy-as-code features add stricter policy evaluation when enabled.

## Fetch Safety

The fetch tool has an opt-in `fetch-sanitization` feature flag. When enabled,
it classifies initial and redirected hosts, blocks private/localhost/link-local/
metadata targets, applies safe-text handling for unknown hosts, and enforces
streaming response-size caps.

When disabled, callers are responsible for their own fetch policy. The security
settings report exposes that tradeoff to clients.

## Shell Safety

The exec tool runs through `ProcessManager` and can use shell AST normalization
when the `shell-ast-normalization` feature flag is enabled. AST normalization
evaluates compound commands segment-by-segment and gives structured denial
reasons for unsafe command forms.

## File Safety

Read/write/edit tools share `FileStateCache`, `ProjectIndex`, and
`FileUndoManager` instances within a session. Write and edit operations support
transaction modes so hosts can roll back failed multi-file changes.

## Agent And WRFC Integration

The `agent` tool can spawn individual agents, spawn batches, group agents into
cohorts, send messages, wait for completion, inspect budgets/plans, and inspect
WRFC chain history. WRFC chains use engineer, reviewer, and fixer roles with
quality gates and constraint propagation.
