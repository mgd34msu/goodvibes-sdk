# Decision: the local session daemon runs by default (`daemon.enabled`), `danger.daemon` retained as a deprecated alias

Date: 2026-07-05
Scope: One-Platform Wave 2 spine, daemon-by-default ruling + honest config rename
Status: accepted; **the Wave-6 removal (item 5) executed 2026-07-06, see "Wave 6: removal executed" below**; **superseded in part 2026-07-31 by the daemon/TUI split (Phase A) and daemon-hosted sessions (Phase B), see "Updated 2026-07-31" at the end.** The 2026-07-05 and 2026-07-06 records below stand as written.

## Context

Wave 1 stood up a single daemon-hosted `SharedSessionBroker` + `CompanionChatManager`,
version-gated adopt-or-start, loopback-only binding, auth-gated + rate-limited routes,
and actionable 503s. The security posture that the old `danger.daemon` key asserted, "turning this on is dangerous, keep it off", was retired in Wave 1:

- the daemon binds `127.0.0.1` only (never a routable interface),
- every control-plane/companion route is Bearer-auth-gated,
- the gateway is rate-limited and returns honest, actionable 503s.

The One-Platform charter's acceptance sentence ("start a coding session in the TUI →
see and steer it from another surface") requires cross-surface session visibility for
**default** users. That only holds if a session broker is actually running for a default
user. As long as the daemon was gated behind `danger.daemon` (default **false**), the
Wave-2 TUI client conversion had nothing to adopt: the acceptance sentence was
unreachable out of the box, and the key's very name told users the honest posture was
"leave it off."

## Decision

1. **Introduce `daemon.enabled` (boolean, default `true`)**, the honestly-named key.
   Naming follows the schema's `group.field` convention (cf. `httpListener.*`,
   `controlPlane.*`). Default **on**. Loopback (`127.0.0.1`) stays the default host;
   default-on changes *whether* the daemon runs, not *where* it binds.

2. **Retain `danger.daemon` as a deprecated alias.** Reads are still honored. The alias
   has **no default** (resolves to `undefined` when the user never set it), so the
   resolver can tell "unset" from an explicit `danger.daemon = false`.

3. **Precedence (documented contract).** `resolveDaemonEnabled(config)`:
   - if `danger.daemon` is an explicit boolean → it **wins** (a legacy user who wrote
     `danger.daemon = false` stays off; `= true` stays on);
   - otherwise `daemon.enabled` governs (default `true`).
   The alias is a *reader* override only; it never resurrects a "dangerous" posture,
   it only lets an existing opt-out survive the flip.

4. **Shared, not TUI-local.** The resolver lives in the SDK config module
   (`platform/config/index.ts`) so the standalone daemon CLI and the TUI adopt-or-start
   path (`bootstrap-services.ts`) resolve the flag identically. There is no second
   source of truth.

5. **Removal scheduled Wave 6.** The alias, its schema entry, and the resolver's alias
   branch are removed then; this is recorded in the schema comments and the plan doc.

## Alternatives rejected

- **(A) Keep the daemon off and make users opt in (`daemon.enabled` default false, or
  keep `danger.daemon`).** Rejected: the acceptance sentence requires cross-surface
  visibility for *default* users. An opt-in default means the headline One-Platform
  behavior does not work until a user finds and flips a flag, and the `danger.*`
  namespace actively discourages flipping it. The Wave-1 posture verification (loopback
  binding, auth-gated + rate-limited routes, actionable 503s) is what makes default-on
  defensible; with that in hand, opt-in is a false-safety tax, not a real safeguard.

- **(B) Rename to `daemon.enabled` and DELETE `danger.daemon` outright now.** Rejected:
  a user who deliberately wrote `danger.daemon = false` (the documented off-switch for
  two years) would be silently flipped **on** by an in-place delete, the worst kind of
  surprise for a background-service setting. The alias with precedence preserves every
  existing explicit choice across the flip; the delete is deferred to Wave 6 with a
  migration window.

- **(C) Keep the `danger.` name but change its default to true.** Rejected on honesty
  grounds: the `danger.` namespace asserts a security posture Wave 1 retired. Leaving a
  key named `danger.daemon` **on by default** is a self-contradicting label. The rename
  is the point; the alias only carries back-compat.

## Consequences

- Default users get a running, loopback-bound session daemon, the base the Wave-2
  TUI client conversion adopts. The acceptance sentence is reachable out of the box.
- `config.get('danger.daemon')` now returns `boolean | undefined` (was `boolean`);
  callers must go through `resolveDaemonEnabled`, not read the raw alias. The one host
  consumer (`bootstrap-services.ts`) and the daemon CLI log line were migrated.
- An adopt-or-start probe now runs at TUI boot for default users; its cost is measured
  against the startup budget and kept off the first-paint path (see the TUI-side report).

## Tests (as of the original 2026-07-05 ruling, superseded: see below)

`test/daemon-enabled-resolution.test.ts` (resolver precedence: default-on, off-switch,
alias-false-wins, alias-true-wins, unset-defers, fail-safe; plus schema/DEFAULT_CONFIG
default-on and a legacy-off-stays-off round-trip through a real `ConfigManager`) and two
`test/bootstrap-services.test.ts` cases (embedded daemon starts by default when the alias
is unset; `danger.daemon:false` forces it off despite the default-on new key).

## Wave 6: removal executed (2026-07-06)

Item 5 above ("removal scheduled Wave 6") is done, as W6-R1 in
`.goodvibes/audit/2026-07-06-wave6-briefs.json`. What changed from the plan above:

- **`danger.daemon` is gone**: removed from `schema-domain-core.ts` (`coreTailConfigSettings`),
  from the `ConfigKey`/`ConfigValue` unions in `schema-types.ts`, and from the `danger`
  object's type shape. `resolveDaemonEnabled`'s alias branch (`config/index.ts`) is deleted;
  its signature is unchanged, so all 7 existing callers compiled without edits.

- **The silent-flip hazard (Alternative B, rejected above for the same reason) is closed by
  a config migration, not by the alias.** `platform/config/migrations.ts` exports
  `migrateDangerDaemonAlias`, applied in `ConfigManager.load()` for both the global and
  project settings files, BEFORE the raw JSON is deep-merged with defaults:
  - an explicit on-disk `danger.daemon: false` is rewritten onto `daemon.enabled: false`
    (the legacy off-switch is preserved, the same guarantee Alternative B would have
    broken) and the alias key is stripped from the merged shape;
  - an explicit `danger.daemon: true` is stripped with no rewrite (already the default);
  - absent/non-boolean is a no-op.

  The migration is a pure function over the raw parsed object and is idempotent by
  construction (an already-migrated object has no `danger.daemon` key left to act on).

  It runs at every `load()` rather than rewriting the file on disk, no unexpected write
  during construction; the honest resolution holds indefinitely regardless of whether the
  bytes on disk are literally rewritten (they naturally drop the deprecated key the next
  time anything calls `.save()`).

- **Raw readers migrated in the same change** (not left for later, they stop typechecking
  the moment the union drops the key): TUI `snapshot.ts`, `surface-command.ts`,
  `remote-runtime-setup.ts`, `onboarding-wizard-apply.ts`; agent `settings-modal.ts` +
  `settings-modal-types.ts` (the override-note machinery, now dead and removed) +
  `agent-settings-policy.ts` (`EXTERNAL_HOST_SETTING_KEYS`).

- **The 7 helper callers were untouched**, per the plan: `resolveDaemonEnabled`'s signature
  did not change.

## Tests (post-removal)

`test/daemon-enabled-resolution.test.ts` (resolver: default-on, off-switch, unset;
`danger.daemon` confirmed absent from `CONFIG_SCHEMA`/`CONFIG_KEYS`; a legacy
`danger.daemon:false`/`:true` on disk resolves correctly through a real `ConfigManager`),
`test/config-migrations.test.ts` (the migration as a pure function, rewrite, no-rewrite,
no-op, and idempotency across repeated application; plus the same cases wired through
`ConfigManager.load`, including a `reload()` round-trip), and the two updated
`test/bootstrap-services.test.ts` cases (`daemon.enabled:true` runs the daemon;
`daemon.enabled:false` leaves it off, no `danger.daemon` reader anywhere in the file
data now).

## Updated 2026-07-31: the daemon is a separate product, and it now runs sessions

### What this record decided, and what it parked

It decided that the local session daemon runs for default users (`daemon.enabled`, default
`true`, loopback-bound), and that the deprecated `danger.daemon` alias carried existing opt-outs
across the rename. What made that ruling necessary was stated in its own consequences:

> Default users get a running, loopback-bound session daemon, the base the Wave-2
> TUI client conversion adopts. The acceptance sentence is reachable out of the box.

and

> An adopt-or-start probe now runs at TUI boot for default users

Two things were parked in that framing. First, the daemon was still something a SURFACE brought
into being, the record's whole mechanism is a surface's adopt-or-start probe, with in-process
embedding as a documented topology beside it. Second, the daemon was a session REGISTER: it made
sessions visible and steerable across surfaces, and this record makes no claim about where a
conversation's loop runs. Both were ruled on 2026-07-30 and executed in two phases.

### Phase A: the daemon stopped being something a surface starts

The daemon became its own product (repo `goodvibes-daemon`), a composition root over this SDK,
installed alongside the terminal app and the chat host. What changed about the mechanism this
record describes:

- **A surface adopts; it never embeds and never spawns.** Both surface products pass
  `adoptOnly: true` into `startExternalServices`
  (`goodvibes-tui/src/runtime/bootstrap.ts:441`,
  `goodvibes-agent/src/runtime/bootstrap-external-services.ts:168`). In the shared ruling
  (`platform/runtime/daemon-adoption-policy.ts:121-127`), `adoptOnly` is checked before
  `embedInProcess` and before the spawn fallback: with the port free the decision is
  `adopt-only-idle`, so neither the `embed` branch (`platform/runtime/bootstrap-services.ts:695`)
  nor the detached-spawn branch is reachable from a surface. The daemon product does not call
  `startExternalServices` at all.

- **`daemon.embedInProcess` is still a shipped key** (`platform/config/schema-domain-core.ts:119`
  default `false`, schema entry at `:704`) and the `embed` code path still exists, but no shipped
  product reaches it. This is recorded so nobody reads the key's presence as a live topology.

- **`daemon.enabled` remains a real setting with the same default and the same resolver.**
  `resolveDaemonEnabled` still gates the whole external-service block
  (`platform/runtime/bootstrap-services.ts:602`), with it false a surface does not even try to
  adopt, and the daemon's own CLI reports it (`goodvibes-daemon/src/daemon/cli.ts:652`, via the
  SDK's `platform/daemon/cli.ts:169`). What it now means for a surface is "may I adopt a daemon",
  not "shall I start one".

- **The one recovery step for a missing daemon is starting the installed service.**
  `platform/runtime/client/daemon-autostart.ts` (`autostartInstalledDaemon`) asks the platform
  service manager whether the daemon's service entry exists, starts it if so, waits a bounded
  time and re-probes. Its boundaries are strict: a reachable daemon is never restarted, a
  `blocked` or `incompatible` port is left alone, an already-active unit gets a wait rather than a
  second start, and a daemon that is not installed gets guidance rather than a surrogate. Called
  from `goodvibes-tui/src/runtime/bootstrap.ts:449`.

So the acceptance sentence this record was written to make reachable is still reachable by
default, but by installing the daemon product, not by a surface conjuring one.

### Phase B: the daemon became an execution host as well as a register

- **The engine** lives in `platform/hosted-sessions/` (`manager.ts`, `session-runtime.ts`,
  `store.ts`, `spine-intake.ts`, `types.ts`, `workspace-floor.ts`, `model-route.ts`) and is wired
  into a daemon by `platform/daemon/hosted-sessions-composition.ts`. A hosted session composes
  the same `Orchestrator`, the same `ToolRegistry` from `registerAllTools`, and the product's own
  `permissionManager`, not a second, weaker one. It is OFF until a product supplies a workspace
  floor factory; the daemon supplies its workspace trust gate
  (`goodvibes-daemon/src/runtime/hosted-session-composition.ts`, passed at
  `goodvibes-daemon/src/daemon/cli.ts:536`).

- **Five verbs**: `sessions.hosted.create`, `.attach`, `.detach`, `.kill`, `.list`
  (`packages/contracts/src/generated/operator-method-ids.ts:425-429`; descriptors in
  `platform/control-plane/method-catalog-hosted-sessions.ts`, handlers in
  `platform/control-plane/routes/hosted-sessions.ts`). Steering, follow-ups and tool-call cancels
  stay on the ordinary session verbs, which resolve a hosted id daemon-side.

- **The detach toggle, with the owner-confirmed default:** `hostedSessions.detachPolicy`, enum
  `kill` | `survive`, default **`kill`**
  (`platform/config/schema-domain-hosted-sessions.ts:39`, `:49-54`), overridable per session at
  creation. Alongside it: `hostedSessions.maxSessions` (8),
  `hostedSessions.maxMessagesPerSession` (500), `hostedSessions.terminatedRetentionMs`
  (86_400_000), and `hostedSessions.promoteInboundConversations` (default **`false`**).

- **Surfaces reach it as clients.** Terminal app: `src/runtime/client/hosted-sessions.ts`,
  `hosted-session-stream.ts`, `hosted-roster.ts` and the `/hosted` command
  (`src/input/commands/hosted-runtime.ts`). Chat host:
  `src/runtime/client/hosted-sessions.ts` and `hosted-handoff.ts`, gated on
  `hostedSessions.promoteInboundConversations` read per continuation
  (`goodvibes-agent/src/runtime/services.ts:839`). Web app:
  `src/views/sessions/HostedSessionsView.tsx`, `src/lib/hosted-sessions.ts`,
  `src/lib/hosted-session-stream.ts`.

### What is still local mode

The daemon running by default does not mean sessions run in the daemon by default.

- Both surfaces still construct a local `SharedSessionBroker` and run their conversation loop in
  their own process: `goodvibes-tui/src/runtime/services.ts:273` (continuation runner spawning
  through its own `agentManager` at `:294`), `goodvibes-agent/src/runtime/services.ts:1083`.
- Adoption wires identity only. `platform/runtime/client/spine-adoption.ts` header: "Session
  IDENTITY, not session execution. The conversation itself still runs in the surface; what the
  daemon holds is the register." It activates `sessions.register` / `sessions.close`,
  `sessions.inputs.list` / `.deliver`, `sessions.list` and the memory transport, and nothing
  else.
- A hosted session exists only when somebody asks for one: an explicit `/hosted new` or
  `/hosted attach` in the terminal, or an inbound channel conversation with
  `hostedSessions.promoteInboundConversations` turned on. With the shipped defaults, no session
  is daemon-hosted and detaching still ends work, exactly as it always has.
