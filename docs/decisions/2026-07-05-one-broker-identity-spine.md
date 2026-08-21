# Decision: One daemon-hosted broker + identity spine (One-Platform Wave 1, S1)

Status: accepted, 2026-07-05; superseded in part 2026-07-31 by the daemon/TUI split (Phase A)
and daemon-hosted sessions (Phase B), see "Updated 2026-07-31" at the end. The original record
stands as written; the hazard it left open is answered there.
Scope: goodvibes-sdk (`packages/sdk`, `packages/daemon-sdk`)
Wave: One-Platform Wave 1, THE SPINE (S1)

## Decision

ONE daemon-hosted `SharedSessionBroker` + ONE `CompanionChatManager`; the daemon is
the sole owner and sole writer of a single HOME-scoped durable session store; `project`
is DATA on each record; external runtimes register + heartbeat their sessions in as
CLIENTS over the existing control-plane transport; `SurfaceKind` is unified to one
canonical type and the origin `kind` axis is expanded to name every product.

Chosen because it is the minimum structural change that makes the charter sentence true:
one list, one durability path, one identity vocabulary. The broker spine already existed
and was correct (loads all sessions incl. closed, atomic persistence, boot reconciliation,
idempotent `ensureSession`), the fragmentation was entirely from N processes each
constructing their own broker at a project-scoped path, plus the companion manager being a
second, home-scoped, closed-dropping store. Fixing ownership + scope + the closed-skip is
smaller than any distributed alternative.

## What shipped (SDK side; the TUI client conversion is Wave-2/S3)

- **Canonical `SurfaceKind` (two axes kept separate).** `events/surfaces.ts` now defines
  `SURFACE_KINDS = TRANSPORT_SURFACE_KINDS ∪ PRODUCT_SURFACE_KINDS`, where
  `TRANSPORT_SURFACE_KINDS = ROUTE_SURFACE_KINDS` (the strict route-binding list, unchanged)
  and `PRODUCT_SURFACE_KINDS = ['agent','webui','companion','automation']`. The participant/
  message identity axis (`SharedSessionParticipant.surfaceKind`, `SharedSessionMessage.surfaceKind`,
  `SharedSessionRecord.surfaceKinds`) widened to canonical `SurfaceKind`. `AutomationSurfaceKind`
  collapsed to `= TransportSurfaceKind` (dedup, no widening) so routes/channels/delivery keep
  the strict transport set. This is the brief's TRANSPORT ⊂ CANONICAL split, reality required
  the narrow route enum (channel delivery has exhaustive switches), so product surfaces were
  NOT widened into `AutomationSurfaceKind`.

- **`SharedSessionKind` (origin) expanded** to `tui|agent|webui|companion-task|companion-chat|automation`,
  in lockstep across the type (`session-types.ts`), the runtime validator (`SESSION_KINDS`),
  the wire enum (`SHARED_SESSION_KIND_SCHEMA`), and the daemon-sdk response reader.

- **Project-as-data.** `SharedSessionRecord.project` (required on new records, backfilled to
  `'unknown'` on load). The broker store moved from the project-scoped path
  (`<cwd>/.goodvibes/<surface>/control-plane/sessions.json`) to the ONE home-scoped path
  (`~/.goodvibes/control-plane/sessions.json`), overridable via `sessionStorePath`. `listSessions`
  gained a `{project, kind, includeClosed}` filter; the default is the cross-project union.

- **Closed-skip data-loss fix** (`companion-chat-manager.ts` init): closed companion sessions now
  load into memory in a lightweight terminal state (meta + messages retained, no history replay),
  so they are listable AND importable. GC (`_gcSweep`, 5-min grace after `closedAt`) remains the
  sole deletion authority.

- **`sessions.register`** wire method: idempotent upsert keyed on a caller-supplied `sessionId`,
  carrying `{kind, project, participant, title?}`. Maps to `ensureSession` + participant merge;
  re-calling advances `participant.lastSeenAt` (the heartbeat). Wired through the full pipeline
  (schema, method catalog, facade route dispatch, DirectTransport via the operator client, HTTP
  client). Broker-level events are emitted; SSE realtime wiring belongs to S2.

- **Migration importer** (`session-store-importer.ts`): folds companion files + per-project broker
  snapshots + the stale agent store into the one home store at daemon boot, BEFORE the broker
  serves. Idempotent (id-keyed merge, newer-`updatedAt` wins); no session dropped (closed included);
  corrupt/partial files logged and skipped per-file; a re-run is a no-op.

## Registration sub-decision

Add `sessions.register` (idempotent, caller-supplied id, carries kind+project+participant,
`lastSeenAt` = heartbeat) rather than overloading `sessions.create`. Chosen because create's
contract is "make me a new anonymous session" and its wire schema deliberately hides id/kind;
overloading it would make the same method sometimes-create/sometimes-adopt, an honesty hazard
at the wire. `register` maps cleanly onto the already-idempotent `ensureSession`. A separate
lightweight `sessions.heartbeat` is left as an optional follow-on if register's persist cost bites.

## Alternatives rejected

- **Per-surface brokers with file-watch reconciliation.** N writers to N files reconciled by fs
  watchers is today's fragmentation with a sync layer bolted on, race-prone (last-writer-wins
  across watchers), non-atomic across files, and it cannot produce a single authoritative list
  without a merge policy that re-invents the broker. It also keeps the closed-skip and
  scope-mismatch bugs alive per surface.

- **Multi-broker gossip.** Distributed consensus for a single-user, single-host tool, enormous
  complexity (membership, conflict resolution, partition handling) for zero benefit.

- **Keep project-scoping (project as a path prefix).** It is the direct cause of "a daemon in
  project A cannot see project B". Encoding project in the path means the store's identity is its
  location, so the union view the charter demands is structurally impossible. Project must be a
  queryable FIELD.

- **Broaden `sessions.create` to adopt.** Turns one verb into two behaviors and leaks create
  semantics; `register` is the honest verb.

## Known open hazards (closed by later waves)

- **Dual-writer** (risk-7): until the Wave-2 TUI client conversion, a runtime that still constructs
  its own persisting broker while the daemon runs can double-write the home store. S1 ships the
  client-mode broker contract (construct-without-store throws) and the `sessions.register` contract
  so Wave-2 can adopt it; Wave-2 closes the hazard.
- **Closed-session memory growth** (risk-5): loading all historical closed companion sessions is
  bounded today by GC grace deletion; a boot cap + on-demand hydration is a follow-on if counts grow.

## Updated 2026-07-31: the client conversion happened, and the daemon now runs sessions too

### What this record decided, and what it parked

It decided ONE daemon-hosted `SharedSessionBroker` as the sole owner and sole writer of a single
durable session store, with external runtimes registering and heartbeating in as clients. It was
explicit that the client half was not yet done, the "What shipped" heading reads "(SDK side; the
TUI client conversion is Wave-2/S3)", and it parked the consequence under known hazards, in
these words:

> **Dual-writer** (risk-7): until the Wave-2 TUI client conversion, a runtime that still
> constructs its own persisting broker while the daemon runs can double-write the home store. S1
> ships the client-mode broker contract (construct-without-store throws) and the
> `sessions.register` contract so Wave-2 can adopt it; Wave-2 closes the hazard.

It also said nothing about where a conversation's LOOP runs, the broker holds identity, and the
question of daemon-hosted execution was left to the record it names as a later wave.

### Phase A: the client conversion, in its final form

The conversion landed as product separation rather than as a wave inside one repo. The daemon is
now its own product (`goodvibes-daemon`), a composition root over this SDK; the terminal app and
the chat host are clients.

- **The daemon owns the register.** `goodvibes-daemon/src/runtime/services.ts:223-229` constructs
  the `SharedSessionBroker` with `storePath: shellPaths.resolveProjectPath(
  GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json')` and binds a continuation
  runner at `:230` that spawns through the daemon's own agent manager. Its working directory is
  `GOODVIBES_WORKING_DIR` or the process cwd (`src/daemon/cli.ts:106`), and
  `GOODVIBES_DAEMON_SURFACE_ROOT` is still the string `tui`
  (`goodvibes-daemon/src/config/surface.ts`) because that is where every installed machine's state
  already sits; that file records the rename as a receipted migration, not a constant edit.

- **Surfaces receive dispatch over the wire instead of owning it.**
  `platform/runtime/client/session-dispatch.ts` (`createWireSessionDispatch`) satisfies the same
  `setContinuationRunner` seam by polling `sessions.inputs.list` for the sessions a surface hosts
  and acknowledging with `sessions.inputs.deliver`. Both surfaces use it: terminal app
  `src/runtime/services.ts:286`, chat host `src/runtime/services.ts:829`.

- **No surface hosts a daemon.** Both pass `adoptOnly: true`
  (`goodvibes-tui/src/runtime/bootstrap.ts:441`,
  `goodvibes-agent/src/runtime/bootstrap-external-services.ts:168`), and
  `decideDaemonAdoption` checks `adoptOnly` before `embedInProcess`
  (`platform/runtime/daemon-adoption-policy.ts:121-127`), so the `embed` action is unreachable
  from a surface.

- **The dual-writer hazard is closed by separation of files, not by removing the local brokers.**
  Each product's broker writes under its own surface root: the terminal app at
  `<workspace>/.goodvibes/tui/control-plane/sessions.json`
  (`goodvibes-tui/src/runtime/services.ts:273-274`), the chat host's automation register at
  `<workspace>/.goodvibes/agent/control-plane/sessions.json`
  (`goodvibes-agent/src/runtime/services.ts:1083-1084`, kept for `AutomationManager`), and the
  daemon under its own working directory as above. What the surfaces write into the DAEMON's
  store is `sessions.register` over the wire, never a second file handle. The "one home-scoped
  store" wording of the original record is therefore no longer literal: there is one store the
  wire writes to, plus each product's own local file for the sessions it runs itself.

### Phase B: the daemon runs conversations, not only identity

- **The engine** is `platform/hosted-sessions/`, `manager.ts` (lifecycle, limits, the detach
  policy), `session-runtime.ts` (the per-session loop: a `ConversationManager`, a `ToolRegistry`
  from the same `registerAllTools` a terminal calls, a `ContextAccountingHolder`, the
  `Orchestrator`, and the product's own `permissionManager` rather than a second one),
  `store.ts` (atomic writes, bounds, content validation with `.rejected` quarantine, a retention
  sweep, and a disclosed load report), `spine-intake.ts`, `types.ts`, `workspace-floor.ts`,
  `model-route.ts`. `platform/daemon/hosted-sessions-composition.ts` wires it into a daemon and
  is off unless the product supplies a workspace floor factory, the daemon supplies its
  workspace trust gate (`goodvibes-daemon/src/runtime/hosted-session-composition.ts`, passed at
  `src/daemon/cli.ts:536`).

- **A hosted session joins this record's register rather than a parallel one.**
  `hosted-sessions-composition.ts:151` passes `runtimeServices.sessionBroker` as the hosted
  engine's spine, and `spine-intake.ts` registers each hosted session and heartbeats it, so it
  appears in `sessions.list` beside every other kind and `sessions.steer` / `sessions.followUp`
  drive it through the routing that already existed. That is `sessions.register` from this record
  being used by the daemon's own sessions.

- **The verbs** are exactly five: `sessions.hosted.create`, `.attach`, `.detach`, `.kill`,
  `.list` (`packages/contracts/src/generated/operator-method-ids.ts:425-429`; descriptors in
  `platform/control-plane/method-catalog-hosted-sessions.ts`; handlers in
  `platform/control-plane/routes/hosted-sessions.ts`). There is no hosted-only steer or cancel
  verb, and no hosted token-stream verb, the hosted loop is the ordinary `Orchestrator`, so its
  deltas and tool events reach the existing `turn` and `tools` SSE domains stamped with the
  hosted session's id.

- **The detach toggle, with the owner-confirmed default:**
  `platform/config/schema-domain-hosted-sessions.ts` ships `hostedSessions.detachPolicy`
  (`kill` | `survive`), default **`kill`**, stated in the module header as deliberate, because
  detaching a client has always ended its work. A session may override it at creation via
  `sessions.hosted.create`'s `detachPolicy` argument. The rest of the domain:
  `hostedSessions.maxSessions` (8), `hostedSessions.maxMessagesPerSession` (500),
  `hostedSessions.terminatedRetentionMs` (86_400_000), and
  `hostedSessions.promoteInboundConversations` (default **`false`**, a channel message is
  answered by the process that received it unless this is turned on).

### What is still local mode

- **Both surfaces still construct a local `SharedSessionBroker` and still run their conversation
  loop in their own process by default.** Terminal app: `src/runtime/services.ts:273`, with the
  continuation runner spawning through its own `agentManager` at `:294`. Chat host:
  `src/runtime/services.ts:1083` for automation, and its inbound continuation runner spawns
  locally unless promotion is on.

- **Adoption mirrors identity, not execution.** `platform/runtime/client/spine-adoption.ts`
  states it in its header, "Session IDENTITY, not session execution. The conversation itself
  still runs in the surface; what the daemon holds is the register", and wires exactly
  `sessions.register` / `sessions.close`, `sessions.inputs.list` / `.deliver`, `sessions.list`,
  and the memory transport.

- **Hosted execution is opt-in in both directions.** A terminal asks for it explicitly
  (`/hosted new` or `/hosted attach`, `goodvibes-tui/src/input/commands/hosted-runtime.ts`); a
  channel conversation is handed over only when `hostedSessions.promoteInboundConversations` is
  true, read per continuation rather than captured at construction
  (`goodvibes-agent/src/runtime/services.ts:839`,
  `goodvibes-agent/src/runtime/client/hosted-handoff.ts`).

So the register in this record is now genuinely single-writer over the wire, and the daemon has
become an execution host as well, but only for sessions somebody deliberately placed there.
