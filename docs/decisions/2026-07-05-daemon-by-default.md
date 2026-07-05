# Decision: the local session daemon runs by default (`daemon.enabled`), `danger.daemon` retained as a deprecated alias

Date: 2026-07-05
Scope: One-Platform Wave 2 spine — daemon-by-default ruling + honest config rename
Status: accepted

## Context

Wave 1 stood up a single daemon-hosted `SharedSessionBroker` + `CompanionChatManager`,
version-gated adopt-or-start, loopback-only binding, auth-gated + rate-limited routes,
and actionable 503s. The security posture that the old `danger.daemon` key asserted —
"turning this on is dangerous, keep it off" — was retired in Wave 1:

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

1. **Introduce `daemon.enabled` (boolean, default `true`)** — the honestly-named key.
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
  behavior does not work until a user finds and flips a flag — and the `danger.*`
  namespace actively discourages flipping it. The Wave-1 posture verification (loopback
  binding, auth-gated + rate-limited routes, actionable 503s) is what makes default-on
  defensible; with that in hand, opt-in is a false-safety tax, not a real safeguard.

- **(B) Rename to `daemon.enabled` and DELETE `danger.daemon` outright now.** Rejected:
  a user who deliberately wrote `danger.daemon = false` (the documented off-switch for
  two years) would be silently flipped **on** by an in-place delete — the worst kind of
  surprise for a background-service setting. The alias with precedence preserves every
  existing explicit choice across the flip; the delete is deferred to Wave 6 with a
  migration window.

- **(C) Keep the `danger.` name but change its default to true.** Rejected on honesty
  grounds: the `danger.` namespace asserts a security posture Wave 1 retired. Leaving a
  key named `danger.daemon` **on by default** is a self-contradicting label. The rename
  is the point; the alias only carries back-compat.

## Consequences

- Default users get a running, loopback-bound session daemon — the substrate the Wave-2
  TUI client conversion adopts. The acceptance sentence is reachable out of the box.
- `config.get('danger.daemon')` now returns `boolean | undefined` (was `boolean`);
  callers must go through `resolveDaemonEnabled`, not read the raw alias. The one host
  consumer (`bootstrap-services.ts`) and the daemon CLI log line were migrated.
- An adopt-or-start probe now runs at TUI boot for default users; its cost is measured
  against the startup budget and kept off the first-paint path (see the TUI-side report).

## Tests

`test/daemon-enabled-resolution.test.ts` (resolver precedence: default-on, off-switch,
alias-false-wins, alias-true-wins, unset-defers, fail-safe; plus schema/DEFAULT_CONFIG
default-on and a legacy-off-stays-off round-trip through a real `ConfigManager`) and two
`test/bootstrap-services.test.ts` cases (embedded daemon starts by default when the alias
is unset; `danger.daemon:false` forces it off despite the default-on new key).
