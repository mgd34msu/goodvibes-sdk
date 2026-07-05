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

## Addendum (2026-07-05): schema-level gate aligned with this decision

A separate, earlier validation layer contradicted the stance above: the
operator-sdk's generic JSON-schema response validator
(`validateJsonSchemaResponse` in `packages/operator-sdk/src/client-core.ts`)
validates the raw wire body against `method.outputSchema` *before*
`normalizeSharedSessionRecord` ever runs. `SHARED_SESSION_RECORD_SCHEMA`
(`packages/sdk/src/platform/control-plane/operator-contract-schemas-runtime.ts`,
around line 104) previously listed `project` in its `required` array, so a
mixed-version daemon response omitting `project` threw a `ContractError` at
the schema gate — pre-empting the reader backfill described above entirely.

Fixed by removing `'project'` from `SHARED_SESSION_RECORD_SCHEMA`'s `required`
array (`operator-contract-schemas-runtime.ts` line ~125). `project` remains a
real, typed property on the schema (still `STRING_SCHEMA`) — it is simply no
longer contractually guaranteed present on every wire response, matching the
reader-tolerant stance. This is a response/output-schema relaxation only:
`SHARED_SESSION_REGISTER_INPUT_SCHEMA` (write path, same file, ~line 80-87)
is untouched and still does not require `project` on input, and the daemon's
write path (`session-broker.ts` / `session-broker-sessions.ts`) is unchanged —
it still always populates `project` when it creates a record. The generated
contract artifacts (`packages/contracts/src/generated/operator-contract.ts`,
`packages/contracts/artifacts/operator-contract.json`) were regenerated via
`bun run refresh:contracts` to drop `project` from all embedded
`sessions.*` copies of this schema.

## Addendum (2026-07-05): the enum leg — open the `kind` on read

The `project`-required fix above closed one schema-gate leg; the mixed-version
`kind` enum leg was still open. `SHARED_SESSION_RECORD_SCHEMA.kind` was an
`enumSchema(['tui','agent','webui','companion-task','companion-chat','automation'])`.
A 0.38-pinned operator SDK compiled that enum WITHOUT `agent`/`webui`/`automation`,
so `validateJsonSchemaResponse` (the generic `firstJsonSchemaFailure` walker,
which enforces `enum`) hard-failed the ENTIRE `sessions.list` envelope the moment
any record carried a `kind` the reader's build did not know — blanking the whole
union (webui Sessions view showed 0 rows). This is exactly the tolerance this
decision promised readers, applied to `kind` instead of `project`.

Fixed by making the READ record's `kind` an OPEN enum: `SHARED_SESSION_RECORD_SCHEMA.kind`
now references a plain `{ type: 'string' }` (`SHARED_SESSION_KIND_READ_SCHEMA` in
`operator-contract-schemas-runtime.ts`), so response/output validation accepts an
unknown `kind` string per-record and one alien record can never blank a list. The
tolerant `normalizeSharedSessionRecord` downstream still maps an unknown kind to
the documented `'tui'` fallback and preserves the raw value under
`metadata.wireKind`, so display stays honest.

Writes stay STRICT: `SHARED_SESSION_REGISTER_INPUT_SCHEMA.kind` keeps the closed
`SHARED_SESSION_KIND_SCHEMA` enum, so `sessions.register` still returns 400 on an
unknown kind (leniency is a reader stance, never a writer one — decision point 4).
The daemon's `sessions.register` handler (`runtime-session-register.ts`) already
rejects unknown kinds against the `SHARED_SESSION_KINDS` allowlist; that is
unchanged. Generated contract artifacts were regenerated via
`bun run refresh:contracts` — `sessions.list`/`sessions.get` output copies now
carry `kind: { type: 'string' }` while `sessions.register` input keeps the enum.
