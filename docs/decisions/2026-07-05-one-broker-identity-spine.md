# Decision: One daemon-hosted broker + identity spine (One-Platform Wave 1, S1)

Status: accepted — 2026-07-05
Scope: goodvibes-sdk (`packages/sdk`, `packages/daemon-sdk`)
Wave: One-Platform Wave 1 — THE SPINE (S1)

## Decision

ONE daemon-hosted `SharedSessionBroker` + ONE `CompanionChatManager`; the daemon is
the sole owner and sole writer of a single HOME-scoped durable session store; `project`
is DATA on each record; external runtimes register + heartbeat their sessions in as
CLIENTS over the existing control-plane transport; `SurfaceKind` is unified to one
canonical type and the origin `kind` axis is expanded to name every product.

Chosen because it is the minimum structural change that makes the charter sentence true:
one list, one durability path, one identity vocabulary. The broker spine already existed
and was correct (loads all sessions incl. closed, atomic persistence, boot reconciliation,
idempotent `ensureSession`) — the fragmentation was entirely from N processes each
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
  the strict transport set. This is the brief's TRANSPORT ⊂ CANONICAL split — reality required
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
overloading it would make the same method sometimes-create/sometimes-adopt — an honesty hazard
at the wire. `register` maps cleanly onto the already-idempotent `ensureSession`. A separate
lightweight `sessions.heartbeat` is left as an optional follow-on if register's persist cost bites.

## Alternatives rejected

- **Per-surface brokers with file-watch reconciliation.** N writers to N files reconciled by fs
  watchers is today's fragmentation with a sync layer bolted on — race-prone (last-writer-wins
  across watchers), non-atomic across files, and it cannot produce a single authoritative list
  without a merge policy that re-invents the broker. It also keeps the closed-skip and
  scope-mismatch bugs alive per surface.
- **Multi-broker gossip.** Distributed consensus for a single-user, single-host tool — enormous
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
