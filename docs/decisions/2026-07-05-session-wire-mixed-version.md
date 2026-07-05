# Decision: mixed-version stance for the session wire (parse-with-backfill)

Date: 2026-07-05
Scope: One-Platform Wave 1 spine — session lifecycle wire contract
Status: accepted

## Context

Two peers on different SDK versions can talk to the same session wire:

- a 0.38-pinned CONSUMER (old SDK client) reading a NEWER daemon's response, and
- a NEW consumer reading an OLDER daemon's response.

The session record is the most-evolved payload on this wire. This round adds
new fields (`retainedMessageCount`, the `sessions.register` `reopened`/`conflict`
envelope, the `session-input-completed` / `session-input-failed` wire
discriminants). A naive strict reader would hard-fail validation on an unknown
`kind`, an absent `project`, or an unexpected extra field, turning a benign
version skew into an outage.

## Decision

The wire READERS degrade honestly instead of hard-failing:

1. **Records parse-with-backfill** (`normalizeSharedSessionRecord`,
   daemon-http-client-validators.ts):
   - absent/blank `project` → `'unknown'` (the documented home-scoped default);
   - an unknown `kind` → `'tui'` (documented fallback), with the raw wire value
     preserved under `metadata.wireKind` so nothing is silently lost;
   - unknown extra fields are carried through untouched (spread), never rejected.
2. **Register response is envelope-tolerant**: `reopened` defaults to `false`
   and `conflict` is only surfaced when the daemon sent it, so an OLD daemon that
   returns just `{ session }` still yields a valid `SharedSessionRegisterResult`.
3. **New discriminants are additive**: `session-input-completed` /
   `session-input-failed` join the enum; an old consumer that switches on
   `payload.event` simply ignores names it does not know (it already had to
   tolerate the un-exhaustive set).
4. **Producers stay strict on INPUT**: `sessions.register` rejects an unknown
   `kind` with 400 rather than coercing it (honest write path). Leniency is a
   READER stance, not a writer one.

## Consequences

- A 0.38 consumer against a new daemon degrades to a listable, honestly-labelled
  record instead of a validation crash; a new consumer against an old daemon sees
  `project: 'unknown'` and no truncation marker, which is correct for that peer.
- The single source of truth for "known kinds" is the shared allowlist
  (`SHARED_SESSION_KINDS`, exported from daemon-sdk and asserted in lockstep by
  session-spine-identity.test.ts); the reader fallback references the same set.
- `metadata.wireKind` is the escape hatch for forward-compat tooling that wants
  to see a kind this build does not yet model.
