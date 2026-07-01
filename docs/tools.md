# Tool System

The tool system is the daemon-side execution layer used by sessions, agents,
WRFC chains, and remote surfaces. Tools are registered through
`registerAllTools()` and guarded by config permissions plus feature-flagged
contract checks.

Accessible via `@pellux/goodvibes-sdk/platform/tools` (daemon embedders). Consumer apps interact through sessions and operator methods.

For how tool-call arguments are parsed, validated, and dropped when malformed, see [Tool Safety](./tool-safety.md).

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
| `agent` | Spawn and manage agents | spawn, batch-spawn for independent roots, status, cancel, list, templates, get, budget, plan, wait, message, WRFC, cohorts |
| `goodvibes_context` | Inspect the current GoodVibes harness safely | runtime summary, redacted config reads/schema, integrations, tool catalog, Cloudflare status/token requirements |
| `goodvibes_settings` | Change GoodVibes settings through the config manager | set, reset with explicit confirmation; rejects raw credential persistence |
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

`registerAllTools()` requires host-owned collaborators instead of implicitly
constructing global state. Required collaborators include file undo, mode
manager, process manager, agent manager, message bus, workflow services,
config manager, provider registry, tool LLM resolver, sandbox session registry,
session orchestration, working directory, and surface root.

Optional collaborators enable web search, MCP, WRFC, remote runners, channel
tools, overflow handling, change tracking, service-backed credential
resolution, and secret-aware integration status.

## Runtime And Settings Awareness

The SDK registers `goodvibes_context` and `goodvibes_settings` for all full
tool runtimes, including TUI turns, companion remote chat, Home Assistant
chat, ntfy remote chat, agents, and channel-backed surfaces.

`goodvibes_context` is read-oriented. It lets the model inspect:

- the host surface root, working directory, and daemon home directory
- the current provider/model and provider/model catalog size
- all config keys by key, category, or prefix, with schema metadata
- configured channel surfaces, service registry posture, and available channel
  tools
- registered tool names and descriptions
- Cloudflare status and token requirement guidance

Credential-like values are always redacted. Sensitive keys report only whether
a credential is configured and whether it is a `goodvibes://` secret reference
or another credential-like value.

`goodvibes_settings` is write-capable and permissioned as a write tool. It can
set or reset scalar config keys through `ConfigManager`, requires
`confirm: true`, and refuses raw token/secret/password values. Clients should
store credentials through the secret system and set config keys to
`goodvibes://` references.

Every SDK-owned turn path adds a small harness-awareness system instruction
that tells the model to call `goodvibes_context` before answering questions
about local settings, configured integrations, host capabilities, tools,
providers, or surfaces. The same instruction tells the model not to spawn
agents or WRFC chains for ordinary questions or direct environment inspection.

## Contract Verification

The `tool-contract-verification` feature flag is enabled by default, so built-in
and registered tools are verified at registration time. Hosts can disable the
flag explicitly, but the safer default is verification on.

See [Tool Safety — Tool Contract Verification](./tool-safety.md#tool-contract-verification)
for what the verifier checks (schema shape, permission class, timeout/cancellation
support, output policy, and idempotency metadata) and how error- versus
warning-level violations are handled.

## Permissions

Tool permissions are configured under `permissions.tools.*` and enforced by the
runtime permission layer. `permissions.mode` selects the approval mode
(`prompt` default, `allow-all`, or `custom`), and each tool category has its own
key with a built-in default:

| Config key | Default | Covers |
|---|---|---|
| `permissions.tools.read` | `allow` | file read (read/find/analyze paths) |
| `permissions.tools.write` | `prompt` | file write |
| `permissions.tools.edit` | `prompt` | file edit/patch |
| `permissions.tools.exec` | `prompt` | shell command execution |
| `permissions.tools.find` | `allow` | file/directory search |
| `permissions.tools.fetch` | `prompt` | outbound network fetch (custom mode) |
| `permissions.tools.analyze` | `allow` | code/project analysis |
| `permissions.tools.inspect` | `allow` | runtime/object inspection |
| `permissions.tools.agent` | `prompt` | spawning subagents / delegating tasks |
| `permissions.tools.state` | `allow` | runtime/session state reads |
| `permissions.tools.workflow` | `prompt` | multi-step workflow automation |
| `permissions.tools.registry` | `allow` | tool/skill registry queries |
| `permissions.tools.mcp` | `prompt` | MCP (external server) tool calls |
| `permissions.tools.delegate` | `prompt` | unknown or unregistered tools (see below) |

The default posture therefore allows read/find/fetch/analyze/inspect/state/registry
and prompts for write/edit/exec/agent/workflow/delegate/MCP. The
`permissions.tools.fetch` default of `prompt` applies only in `custom` mode; in the
default `prompt` mode `fetch` is treated as a read-category tool and auto-approved.
For the broader security posture and how these keys interact with secrets, see
[Security](./security.md) and [Secrets](./secrets.md).

### The two meanings of `delegate`

`delegate` names two distinct things:

- **`permissions.tools.delegate`** is the catch-all permission category for
  unknown or unregistered tools. `PermissionManager.getCategory()` maps any tool
  name that is not in the built-in category table to `'delegate'`
  (`TOOL_CATEGORIES[toolName] ?? 'delegate'`), so this key gates anything the
  runtime does not otherwise recognize.
- A separate, **conditionally-registered ACP `delegate` tool** exists. It is
  registered by `Orchestrator.registerDelegateTool()` only after an `AcpManager`
  is attached, which is why it is absent from the Built-In Tools table above even
  though `delegate` appears in the permission list.

### Policy engine and tool feature flags

The permissions policy engine, simulation mode, and policy-as-code features add
stricter policy evaluation when enabled. Several tool-related feature flags are
defined and default to disabled:

- `permission-divergence-dashboard` — aggregates permission-simulation divergence
  by tool/prefix/mode and gates enforce-mode transitions on the divergence rate.
- `runtime-tools-budget-enforcement` — enforces per-phase wall-clock, token, and
  cost budgets across tool execution pipelines, terminating on a hard breach.
- `overflow-spill-backends` — enables pluggable overflow spill backends
  (`file`, `ledger`, or `diagnostics`); when disabled, overflow uses the file
  backend.

See [Feature Flags](./feature-flags.md) for the full flag catalog.

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

The `agent` tool can spawn individual agents, spawn batches of independent
root work, group agents into cohorts, send messages, wait for completion,
inspect budgets/plans, and inspect WRFC chain history. WRFC chains use
engineer, reviewer, fixer, integrator, and verifier roles plus a gate phase with
quality gates and constraint propagation.

Batch spawn is not the mechanism for pre-spawning reviewer/tester/fixer roots
for the same deliverable. If a batch request looks like role decomposition for
one deliverable, the SDK treats the original user ask as the authoritative WRFC
scope and runs one owner chain whose children are created by the WRFC
controller as each phase becomes reviewable.
