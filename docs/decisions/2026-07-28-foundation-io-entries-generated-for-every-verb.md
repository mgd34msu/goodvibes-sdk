# Decision: generate OperatorMethodInputMap/OutputMap for every catalogued verb, and drop the typed-IO ratchet to zero

Date: 2026-07-28
Status: accepted
Supersedes the scoping (not the reasoning) of
`2026-07-06-foundation-io-types-hand-authored.md`

## Context

The 2026-07-06 decision hand-authored typed-IO entries for eight methods and
wrote `scripts/check-foundation-io-types.ts` to prove they could not drift from
their method-catalog schemas. It said plainly that it did not solve the problem
project-wide, and that rebuilding the missing `export-foundation-artifacts.ts`
generator was a separate, larger effort. That effort is this change.

Two measured gaps existed at `9ef97eb8` across the 443 catalogued verbs:

- **97 verbs had no entry in either map.** `OperatorMethodInput<M>` /
  `OperatorMethodOutput<M>` fell through to `{ readonly [key: string]: unknown }`
  / `unknown`, so those verbs reached consumers with no compile-time shape at
  all. `calendar.*` (5), `email.*` (4), `memory.*` (13), `projectPlanning.*`
  (17) and `homeassistant.*` (25) were the largest families.
- **91 verbs carried an entry that no longer matched the schema it was rendered
  from.** `check-foundation-io-types.ts` only diffed a hand-maintained `ENTRIES`
  list naming 143 of the 443 ids, so the other 300 were unchecked: correcting a
  `required` array on those catalog schemas changed no consumer type and
  reddened no gate.

The untyped-IO ratchet (`check-foundation-io-coverage.ts`, baseline 97) held the
frontier — a new verb without typed IO fails the build — but by construction did
nothing about the verbs behind it.

## Decision

Entries are **rendered from the catalog descriptors**, not authored. Nothing here
is per-verb.

- `scripts/foundation-io-render.ts` — the schema-to-TS-type-string renderer,
  extracted verbatim from `check-foundation-io-types.ts` so the writer and the
  checker share one implementation.
- `scripts/foundation-io-catalog.ts` — the composition of all 25 builtin
  descriptor arrays, mirroring the module-private `BUILTIN_GATEWAY_METHODS` in
  `method-catalog.ts`. `assertCoversMethodIds` fails loudly if a catalog module
  is wired into `method-catalog.ts` but not here, so verbs cannot fall out of
  coverage silently.
- `scripts/generate-foundation-io-entries.ts` — rewrites both map bodies for all
  443 ids. Wired into `refresh:contracts`.
- `scripts/check-foundation-io-types.ts` — its `ENTRIES` list is now **derived**
  from the catalog rather than hand-maintained, so the drift check covers 886
  entries (443 methods x input/output) instead of 286.
- `FOUNDATION_IO_COVERAGE_BASELINE` lowered 97 -> 0.

### Two renderer corrections, both measured

**Schema-valued `additionalProperties`.** `recordSchema(v)` returns
`{ type: 'object', additionalProperties: v }`, and every call site builds a fresh
object. The renderer identity-matched only the single `METADATA_SCHEMA`
instance, so structurally identical record schemas — `TOOL_ARGUMENTS_SCHEMA`,
`GRAPHQL_VARIABLES_SCHEMA`, `CONFIG_CATEGORY_SNAPSHOT_SCHEMA` and the rest — fell
through to the plain-object branch and rendered as `{  }`, which declares
nothing. Generalizing the identity check to any schema-valued
`additionalProperties` moved 22 map entries from wrong to right and subsumes the
`METADATA_SCHEMA` special case exactly (byte-identical render). It also makes
`approvals.approve`'s `modifiedArgs` and the approval request's `args` stop
claiming `{  }` when the schema says JSON record — the divergence class the
sweep flagged.

The `JSON_VALUE_SCHEMA` / `JSON_OBJECT_SCHEMA` / `JSON_ARRAY_SCHEMA` identity
checks stay ahead of it: those schemas are self-referential and render to the
named recursive `JsonValue` alias, which structural recursion cannot reach.

**`anyOf` of pure required-key refinements.** `knowledge.ingest.connector` is a
base object schema plus `anyOf: [{required:['input']},{required:['content']},
{required:['path']}]` — the JSON-Schema idiom for "at least one of these". The
renderer hit its union branch and threw on a node with no `type`. It now renders
the union of the base object with each branch's keys promoted to required. This
was the only verb of 443 the renderer could not express; after it, zero throw.

An `integer` branch was also tried and reverted: no catalog schema uses
`type: 'integer'`, so it changed nothing and would have been unexercised
speculation in a renderer whose contract is to throw rather than guess.

### A consumer-side collapse the new types exposed

`Omit<OperatorMethodInput<M>, K>` — used at 8 wrapper signatures in
`packages/sdk/src/browser-knowledge.ts` — does not work for any verb whose schema
sets `additionalProperties: true`. That renders as `Base & { readonly [key:
string]: unknown }`, whose `keyof` is `string | number`, so `Exclude<keyof T, K>`
removes nothing and `Pick` retains no named property: the argument type collapses
to the bare index signature and every field, including which fields are required,
is lost. Measured directly, not inferred. `OperatorInputWithout` strips the index
signature before the omit and re-adds it after, keeping both the named shape and
the additional-properties escape hatch.

## Consequences

- 443 of 443 verbs carry typed IO; the ratchet reads 0 and a verb that ships
  without an entry fails the gate rather than joining a backlog.
- The published OpenAPI contract now marks **0** methods `untyped-client-io`
  (was 97).
- Drift coverage went from 143 verbs to all 443 — a corrected `required` array on
  any catalog schema now reaches consumer types, or reddens `contracts:check`.
- `etc/goodvibes-sdk.api.md` grew substantially: the maps went from 346 to 443
  entries and 91 existing entries changed shape. That diff is the point of the
  change, not a side effect.

## Verified

- `bun run contracts:check` — green (needed the documented second pass: the
  OpenAPI artifact consumes the untyped set, so 97 -> 0 required regenerating it).
- `bunx tsc -b` — green.
- The entries are load-bearing, proved two-sided at a production call site rather
  than in `test/` (which `tsc -b` does not typecheck): mutating
  `browser-knowledge.ts`'s `projectPlanning.workPlan.task.status` call to pass
  `status: 42` fails to compile against the generated entries
  (`TS2322: Type 'number' is not assignable to type 'string'`) and compiles
  **clean** against the original file, where that verb had no entry. The entry is
  what does the work.
