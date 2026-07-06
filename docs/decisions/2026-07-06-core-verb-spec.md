# Decision: a canonical core-verb vocabulary for operator method ids, plus five worst-class collision fixes

Date: 2026-07-06
Scope: Wave 6 stage-0 coherence — W6-C3 (Command language / core-verb spec, E8)
Status: accepted

## Context

`OPERATOR_METHOD_IDS` (`packages/contracts/src/generated/operator-method-ids.ts`) is a
flat list of ~307 dotted ids. Nothing enumerated or constrained the verb vocabulary —
the final dotted segment of each id was a free-form word chosen independently by
whoever added that method. The Wave-6 audit found:

- **An update-verb split**: `automation.jobs.patch`, `routes.bindings.patch`, and
  `watchers.patch` used the HTTP-verb word `patch`, while the rest of the catalog's
  partial-mutation methods used `update`.
- **A redundant lifecycle pair**: `automation.jobs` had both `enable`/`disable` AND
  `pause`/`resume`, with byte-identical `{id, enabled}` output shapes and identical
  semantics (pause==disable, resume==enable) — two names for the same operation.
- **Five worst-class command-surface collisions** (ranked in the audit): the word
  "schedule" meaning three different things, memory command fragmentation, a
  TUI/agent tasks-verb-set drift, a dead-code `/session` registration twin in the
  agent, and a `/sessions` visibility split between TUI and agent.

This is the pre-1.0.0 window — the semver ruling parks breaking removals and renames
at the major bump specifically so this class of cleanup can happen once, cleanly,
before the 1.0.0 compatibility guarantee starts. Renames here are breaking-by-design.

## Decision

### 1. The core-verb spec (`packages/contracts/src/core-verbs.ts`)

- **`CORE_VERBS`**: a closed vocabulary of 19 generic lifecycle/CRUD verbs (list, get,
  search, snapshot, status, create, update, delete, upsert, set, enable, disable,
  close, reopen, cancel, run, retry, invoke, stream, register). Every method whose
  action is a generic lifecycle operation must use one of these words.
- **`BANNED_VERBS`**: `patch`, `pause`, `resume` — retired verbs that must never
  reappear as a tail, even if someone re-adds a similarly-named method later without
  knowing the history.
- **`EXEMPT_VERB_CATEGORIES`**: ~9 categories (external-api-mirror,
  media-and-voice-io, transport-and-protocol, ingest-and-content,
  approval-and-routing, session-and-work-lifecycle, reporting-and-diagnostics,
  process-control, maintenance-and-indexing) covering the large, expected set of
  domain-specific verbs (`voice.stt`, `homeassistant.homeGraph.askHomeGraph`,
  `telemetry.otlp.logs`, ...) that are real single-purpose operations, not a
  coherence bug. One outlier (`mcp.servers.remove`, a `delete` synonym) is flagged
  under `legacy-verb-aliases` as a KNOWN, explicitly out-of-scope inconsistency
  rather than silently exempted or force-renamed — see risk #6 below.
- **Namespace rule**: a resource family name is the plural noun it manages; verbs
  attach directly. The one reusable exception — a family gets BOTH a singular
  per-item action surface and a plural collection surface only when the plural name
  is already claimed for the collection — is not ad hoc: `knowledge.schedule.*`
  (singular, single-record actions) beside `knowledge.schedules.list` (plural,
  collection) is the canonical, pre-existing example this wave found and kept,
  not a new pattern invented for the schedule rename.
- **Conformance test** (`test/core-verbs-conformance.test.ts`): lints every id in
  `OPERATOR_METHOD_IDS` against the spec — a verb tail must be core, exempt-with-
  documented-reason, or the test fails and names the offending id(s). A separate
  assertion bans `patch`/`pause`/`resume` outright. Five more tests are direct
  regression guards for the specific collisions fixed below.

### 2. Update-verb split — fixed by rename, not by exemption

`automation.jobs.patch` → `automation.jobs.update`, `routes.bindings.patch` →
`routes.bindings.update`, `watchers.patch` → `watchers.update`. Pure id renames — the
HTTP method on each descriptor is still `PATCH` (that's an HTTP-transport detail, not
the operator-method vocabulary) and the request/response shapes are unchanged. Proved
end-to-end over real HTTP in `test/w6-c3-core-verb-rename-daemon-wire.test.ts`
(bootDaemon, ephemeral port): the new ids are dispatched by the daemon's generic
`/api/control-plane/methods/{id}/invoke` route and behave identically to their old
names; the `.patch` ids now 404 with `"Unknown gateway method"` — the SDK's own
existing "uncataloged method" 404 path (the same one W6-C4 is giving a machine code
this wave), never a silent fallback.

**REJECTED** widening this to every already-consistent-but-differently-worded id in
the catalog (there is exactly one further outlier, `mcp.servers.remove` — see above) —
that is explicitly out of scope for a worst-class-only pass (risk #6, below).

### 3. Redundant lifecycle pair — retired, not aliased

`automation.jobs.pause` and `automation.jobs.resume` are deleted from the catalog
entirely (not kept as deprecated aliases — this is the wave built for clean breaks).
`automation.jobs.enable`/`disable` are the sole canonical lifecycle verbs. A
caller-facing "pause"/"resume" user-facing verb (the agent's `/schedule pause <id>`
UX, `operator-actions.ts`) now maps onto the `disable`/`enable` wire methods — the
*user's* word is unaffected, only the *wire* vocabulary collapsed. Proved over real
HTTP: both ids now 404 as unknown methods; enable/disable still round-trip correctly.

### 4. SCHEDULE triple-meaning (worst-class collision #1) — namespace, don't merge

**Finding**: the bare top-level `schedules.*` family (list/create/delete/enable/
disable/run) shared a resource type with `automation.jobs.*` (both produce/act on
the same job record; `schedules.create`'s output was literally `AUTOMATION_JOB_SCHEMA`)
but used a DIFFERENT, unnamespaced id family — even though its own HTTP paths were
already `/api/automation/schedules/*`. This bare family is not dead: it backs the
agent's own reminder/routine tooling (`reminder-schedule.ts`, `autonomy-schedule.ts`,
`routine-schedule-promotion.ts`, `agent-schedule-tool.ts`) — a genuinely different
*user-facing* concept (lightweight reminders/routines) built on the *same* wire
resource the TUI's heavier `/schedule` command manages via `automation.jobs.*`. A
third, textually similar but functionally unrelated family, `knowledge.schedule(s).*`
(recurring knowledge-ingestion jobs), completed the triple meaning.

**Decision**: rename the bare family to `automation.schedules.*` — bringing the id in
line with its own HTTP path and making it an explicit sibling of `automation.jobs.*`
and `automation.runs.*` under the `automation.` namespace. This removes the bare
top-level `schedules` word entirely, so only two clearly namespace-qualified
"schedule" families remain: `automation.schedules.*` (this one) and
`knowledge.schedule(s).*` (unchanged — already correctly namespaced and already
follows the canonical singular-item/plural-list convention). Proved end-to-end over
real HTTP: a full create → list → disable → enable → run → delete lifecycle round-
trips under the new id; the bare `schedules.*` ids now 404 as unknown methods.

**REJECTED** merging `automation.jobs.*` and `automation.schedules.*` into one family
— that is a genuine product-capability question (does the agent's lighter
reminder/routine framing collapse into the TUI's job model, or stay a distinct
front-end over the same resource?) that belongs to a product ruling, not a naming
pass, and risks silently changing agent capability. The E8 mandate is that *shared*
verbs mean the same thing everywhere; it does not require collapsing two products'
distinct front-ends over a shared resource into one. **REJECTED** renaming
`knowledge.schedule(s).*` — it was never the source of the ambiguity (it was already
correctly namespaced); the ambiguity was the *bare* family colliding with it and with
the agent's tooling, which the rename above resolves without touching a family that
was already right.

### 5. MEMORY fragmentation (worst-class collision #2) — command-surface only, coordinated with W6-C2

**Finding**: TUI's `/memory` (`session-content.ts`) and agent's `/memory`
(`commands.ts`, forwarding to `recallCommand.handler`) are NOT the same feature
despite the identical command name — TUI's is an ephemeral, session-scoped sticky-
note list ("pinned across context compaction"); agent's is an alias for `/recall`,
the durable cross-session `MemoryStore` search. Typing `/memory add <text>` does two
unrelated things depending which surface you're on.

**Decision** (command-surface scope only — the canonical memory-store design is
W6-C2's, not this brief's, per file ownership): rename TUI's session-scoped notes
command from `/memory` to `/note` (free, non-colliding, matches the existing
`/pin`-style singular naming convention), and register `/memory` on TUI as an alias
of `/recall` — matching the agent's existing pattern, so `/memory` means "the durable
recall store" identically on both surfaces post-fix. `memory.*` at the SDK wire layer
stays the vector-ops-only sub-namespace (`memory.doctor`, `memory.vector.rebuild`,
etc.) — it was never actually part of the naming collision; the collision was purely
in the two products' own command registries.

**REJECTED** redesigning the underlying memory store or merging TUI's ephemeral notes
into the durable `MemoryStore` — that is W6-C2's canonical-store design question
(scope/schema/honesty-contract), not a naming fix; this brief coordinates the
`/memory` surface with W6-C2 per file ownership, it does not own the store.

### 6. TASKS verb-set drift (worst-class collision #3) — ruled a deliberate architectural boundary, not a bug: HONEST NO-OP

**Finding (revised after reading agent's actual code, not just grepping it)**:
`opsApi.tasks` (the SDK's local, in-process runtime-task control plane —
`platform/runtime/runtime-ops-api.ts`) and the wire `OPERATOR_METHOD_IDS` `tasks.*`
family (`list`/`get`/`create`/`cancel`/`retry`/`status`, "submit a task to the daemon
or a shared session") are legitimately different resources that share a name: one is
local in-process subtask tracking, the other is cross-surface daemon-mediated
submission — not itself a bug. TUI's `/tasks` command exposes the full local write
surface (`create`/`update`/`complete`/`fail`/`cancel`/`pause`/`resume`/`retry`);
agent's `/tasks` (`input/commands/tasks-runtime.ts`) is read-only (`list`/`show`/
`output`/`open`/`panel`). The first pass over this (grep-only) treated the asymmetry
as an accidental gap and planned to add the missing write subcommands to the agent.
**Reading the actual file disproves that**: agent's `/tasks` has an explicit
`BLOCKED_TASK_MUTATIONS` set and a `printTaskMutationBlocked` message —
*"policy connected-host tasks are read-only from the Agent TUI; normal work stays in
the main conversation... build/fix/review use /delegate \<task\> to hand explicit
implementation work to GoodVibes TUI"* — and the whole command is `hidden: true` with
its own note that `/workplan` is agent's recommended, visible durable-task surface.
This is the SAME deliberate policy already established for `/session`
(`printSessionGraphMutationBlocked`: *"explicit build/fix/review handoff must use
/delegate so GoodVibes TUI owns execution"*) — the agent is a planning/conversation
surface; execution-side mutation is intentionally TUI-only, consistently, across two
different commands. It is not a drift bug; it is the one-platform architecture's
division of responsibility, already documented in the code the audit's grep pass
didn't read closely enough to catch.

**Decision**: rule this an HONEST NO-OP for W6-C3 — no code change to agent's
`/tasks`. The read-only verb vocabulary that agent DOES expose (`list`/`show`/
`output`) already matches TUI's naming exactly for the shared read-only subset; there
is no actual vocabulary inconsistency to fix, only a deliberate capability boundary
that predates this wave and belongs to the one-platform division-of-responsibility
ruling, not a naming/collision pass. Per Mike's no-deferral rule, ruling a "fix" a
no-op requires a real, checked reason — this is that reason, not convenience: forcing
write capability into the agent here would reverse an existing, actively-documented
architectural decision without a mandate to do so.

**REJECTED** (the original, grep-only plan) adding create/update/complete/fail/
cancel/pause/resume/retry subcommands to agent's `/tasks` — this would silently
reverse the agent's documented read-only-execution boundary, which is exactly the
kind of scope creep risk #6 warns against, just discovered one investigation step
later than the schedule/session findings. **REJECTED** renaming `opsApi.tasks` to
disambiguate it from the wire `tasks.*` family — touches the SDK's core
ops-control-plane property name across dozens of call sites for a naming-clarity gain
that doesn't fix an actual behavior bug. **REJECTED** deleting the wire
`tasks.retry`/`tasks.status` as "undriven" — real, intentional remote-submission
capability for a future/other consumer, not dead code.

### 7. Agent `/session` orphan (worst-class collision #4) — delete the dead registrar, fix the stale usage text

**Finding**: `commands/session-workflow.ts` exports `registerSessionWorkflowCommands`,
a function that calls `registry.register({ name: 'session', aliases: ['sess'], ... })`
with its OWN, richer usage text (mentioning `events`/`groups`/`hotspots` transcript
subcommands). It is never called anywhere in the startup path — `commands.ts` only
registers `sessionCommand` from `commands/session.ts`. `registerSessionWorkflowCommands`
is genuinely dead code (would throw a collision error if it were ever called, since
`sessionCommand` already owns the name). It is NOT masking a functional bug: the live
`sessionCommand`'s default-branch fallback to `handleSessionWorkflowCommand` already
reaches the `events`/`groups`/`hotspots` subcommand logic (verified: `handleSessionWorkflowCommand`
implements them at session-workflow.ts:439) — those subcommands work today, they are
just undocumented in `sessionCommand`'s own usage string.

**Decision**: delete the dead `registerSessionWorkflowCommands` export (the orphan
registrar) and fix `sessionCommand`'s usage/help text to document
`events [kind] | groups [kind] | hotspots`, closing the discoverability gap that the
orphan's confusing duplicate registration attempt was presumably trying (incorrectly)
to fix. No behavior change — the live capability was already reachable.

**REJECTED** merging the dead registrar's subcommand set into the live one — there was
nothing to merge; the subcommands were already live via the shared
`handleSessionWorkflowCommand` function both registrations called.

### 8. Agent `/sessions` visibility (worst-class collision #5, low-sev)

**Finding**: TUI's `/sessions` is visible (discoverable in help/autocomplete) and
forwards args to `/session`'s handler for the `resume`-style muscle-memory case
(`/sessions resume <id>`); the agent's `/sessions` is functionally identical but
registered `hidden: true` and lacks the arg-forwarding.

**Decision**: remove `hidden: true` from the agent's `/sessions` registration and add
the same arg-forwarding TUI has, for identical behavior on both surfaces.

## Risks addressed

1. Renaming ids is a wire change — every consumer invoke of a renamed id moved in the
   same pass (SDK worktree develops the renames; agent/TUI consumer updates ride the
   dev overlay before landing, per file ownership). No deprecation aliases were kept
   for the renamed/retired ids — this is the wave built for clean breaks, and the
   release train ships SDK + all three consumers together.
2. The tasks and session-orphan rulings are recorded above with their real reasons,
   not by convenience.
3. Scope was held to the worst-class items — see the explicit REJECTED entries above
   for what was deliberately NOT re-touched (the `mcp.servers.remove` outlier, the
   TUI/agent tasks-domain naming overlap, the automation.jobs/schedules resource
   merge question).
4. The `/memory` surface was coordinated with, not owned ahead of, W6-C2's canonical
   memory-store design.

## Verification

- `test/core-verbs-conformance.test.ts` — 10 tests, static lint of the full
  `OPERATOR_METHOD_IDS` union plus direct regression guards for each collision fix.
- `test/w6-c3-core-verb-rename-daemon-wire.test.ts` — 9 tests, bootDaemon-based proof
  over real HTTP (ephemeral port, isolated home) that the renamed ids work and the
  retired ids are gone from the live daemon, not just the generated catalog.
- Full SDK suite: 3428 pass / 0 fail.
- `contracts:check`, `refresh:contracts:check`, `api:check`, `version:check`: green
  (see the W6-C3 work-order report for exact commands/output).
