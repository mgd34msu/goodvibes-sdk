# Decision: `OperatorMethodInput`/`OperatorMethodOutput` are indexed accesses, not distributive conditionals

Date: 2026-07-28
Status: accepted
Depends on `2026-07-28-foundation-io-entries-generated-for-every-verb.md`

## Context

Rendering typed IO for every catalogued verb takes the operator method maps from
368 entries to 464. Merging that work onto `integration/sdk-2026-07-28` made two
files stop compiling, both with **TS2590, "Expression produces a union type that
is too complex to represent"**:

- `packages/operator-sdk/src/client-core.ts:279`, `const client: OperatorRemoteClient = {`
- `packages/sdk/src/browser-scoped.ts:198`, `const operator: ScopedOperatorClient<TMethodId> = {`

Both are the same shape: an object literal being related to an interface whose
members are generic over `OperatorTypedMethodId`, the union of all 464 method
ids.

The cost was not the size of any one method's input. It was **breadth**, and the
multiplier was the indirection every one of those members goes through:

```ts
export type OperatorMethodInput<TMethodId extends OperatorTypedMethodId> =
  TMethodId extends keyof OperatorMethodInputMap
    ? OperatorMethodInputMap[TMethodId]
    : { readonly [key: string]: unknown };
```

That is a **distributive** conditional. Relating the literal to the interface
instantiates the signature at its constraint, the whole union, so the
conditional splits into one instantiation per id and evaluates its branch 464
times. Everything downstream rides along: `MethodArgs`, and `RequiredNamedKeys`
and `OmitNamed` beneath it. `RequiredNamedKeys` is homomorphic (deliberately, see `packages/contracts/src/typed-io-keys.ts`), so against a union it maps per
member, and the branched inputs (`Base & (A | B | C)`, from
`method-catalog-shared.ts` `branchedSchema`) are themselves unions. The product
is what exceeds the compiler's union-complexity ceiling.

## Decision

Drop the conditional. Every id now has a rendered entry, so the lookup is a
plain indexed access:

```ts
export type OperatorMethodInput<TMethodId extends OperatorTypedMethodId> = OperatorMethodInputMap[TMethodId];
export type OperatorMethodOutput<TMethodId extends OperatorTypedMethodId> = OperatorMethodOutputMap[TMethodId];
```

`Map[K]` with `K` a type parameter is deferred and resolved per key on demand,
so no per-member expansion happens when the signature is instantiated at its
constraint.

The fallback branch existed only for ids with no entry. There are none:
`generate-foundation-io-entries.ts` renders all 464,
`check-foundation-io-types.ts` diffs all 464 against their catalog schemas, and
the coverage ratchet is pinned at 0. If a verb ever does lack an entry this now
fails to compile, which is louder, and better, than silently widening it to a
bare record.

### Measured, `packages/operator-sdk`, 464 entries, node's default 4 GB heap

| | Types | Instantiations | Memory | Result |
|---|---|---|---|---|
| distributive conditional | 21,715 | 14,780 | 132.5 MB | **TS2590** |
| indexed access | 6,445 | 14,210 | 96.2 MB | clean |

Full gate (`bun run typecheck`, `tsc -b --force` over every project plus the
type-tests): **clean in 35–37 s**.

## Why not restructure `invoke` itself

Per-namespace clients (`client.automation.jobs.create(...)`) and an
overload/lookup shape that resolves one id without distributing were both
considered. They were rejected because they are **breaking public API changes to
`OperatorRemoteClient`**, consumed by `goodvibes-tui`, `goodvibes-agent` and
`goodvibes-webui`, and the measurement above shows they are not needed. The
distribution, not `invoke`'s genericity, was the multiplier. Removing it fixes
both failing sites at once, including `browser-scoped.ts`, which a change
confined to `invoke` would not have touched.

The public signature of `OperatorMethodInput<M>` is unchanged for every concrete
`M`: the conditional's true branch was already `OperatorMethodInputMap[M]` for
every id in the map, and all 464 are in the map. No consumer call site changes.

## Consequences

- `OmitNamed` had to be made **distributive** (`T extends unknown ? ... : never`)
  in the same change. Applied to a branched input `(Base & A) | (Base & B)` all
  at once, `keyof` sees only the keys the branches SHARE, nothing, so every
  branch's requiredness was dropped and the path helpers accepted `{}` again.
  This is the same trap `RequiredNamedKeys` is homomorphic to avoid, arriving
  from the other side. Guarded by `test/types/typed-client-wrong-body.ts`.

- The open-envelope enforcement is unchanged and still proven by
  `test/types/open-envelope-key-helpers.ts`. Verified by mutation: regressing
  `RequiredNamedKeys` to map over `keyof T` reddens it at line 36; regressing
  `OmitNamed` to a plain `Omit` reddens lines 25 and 29 plus two directives in
  `typed-client-wrong-body.ts` and five call sites in `browser-knowledge.ts`.

- `IndexPart`, `NamedProps`, `OmitNamed` and `RequiredNamedKeys` are now exported
  from the SDK entry point, because the public `RequiredKeys` and `WithoutKeys`
  are written in terms of them (previously `ae-forgotten-export`).

Correction (2026-08-21, v2.0.19): the method count has grown further since
this decision, from 464 to 507 (additive-only, see
`2026-07-06-core-verb-spec.md`'s "Additive only" note). `OperatorMethodInput`/
`OperatorMethodOutput` are still the plain indexed accesses described above,
`OmitNamed` is still distributive, and all four listed type helpers are still
exported from the SDK entry point.
