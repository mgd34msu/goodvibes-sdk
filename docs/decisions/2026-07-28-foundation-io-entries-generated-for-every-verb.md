# Decision: the open-envelope key fix ships; the every-verb rendering does not, yet

Date: 2026-07-28
Status: accepted
Supersedes the scoping (not the reasoning) of
`2026-07-06-foundation-io-types-hand-authored.md`

`wo/typedio-coverage` carried two separable things. One is a defect fix and
lands here. The other is a completeness expansion that cannot compile yet, and
is recorded here so it can land later without being re-derived.

## What landed

The open-envelope key helpers (`packages/contracts/src/typed-io-keys.ts`) and
their two production consumers.

A contract input whose schema sets `additionalProperties: true` renders as
`Base & { readonly [key: string]: unknown }`. `keyof` that intersection is
`string | number`, so both `Omit` and any `keyof`-driven mapped type silently
degrade against it: the omit collapses the named shape into the bare index
signature, and a required-keys mapped type yields `never`. **139 of 443**
operator inputs are open envelopes. Both degradations were in production:

- `transport-http/src/client-plumbing.ts` — `RequiredKeys` returned `never`, so
  `MethodArgs` concluded "no required fields" and made the operator client's
  input argument OPTIONAL on every open-envelope verb. A caller could omit a
  body the schema requires.
- `sdk/src/browser-knowledge.ts` — `Omit<OperatorMethodInput<M>, K>` in the
  browser facade, collapsing the same way.

Both now go through `NamedProps` / `OmitNamed` / `RequiredNamedKeys`, which
strip the index signature first, apply the key operation, then re-add it.
`test/types/open-envelope-key-helpers.ts` pins the behaviour.

Two things the fix immediately caught, which is the argument for it:

- `OmitNamed` had to be made DISTRIBUTIVE. `Omit` is
  `Pick<T, Exclude<keyof T, K>>`, and `keyof` a union is the INTERSECTION of its
  members' keys — so on a `Base & (A | B | C)` input ("one of
  body/content/attachments") the branches collapsed into one flat object with
  every branch member optional, turning "one of these is required" into "none of
  these is required". Same class of loss as the index-signature trap, reached
  the same way.
- `test/operator-sdk-coverage.test.ts` was calling `sessions.messages.create`
  with `{ role, content }`. That verb declares neither property and REQUIRES
  `body`. The call would have been refused with a 400; it compiled only because
  `RequiredKeys` had collapsed. Corrected to the declared shape.

The facade's three branched verbs merge with `Object.assign` rather than object
spread: spread of a branched union widens every member to optional, so the
merged value stops proving it satisfies a branch. `Object.assign` returns an
intersection, which keeps it — same runtime value, no cast.

## What did NOT land, and exactly where it stands

Rendering every catalogued verb's input/output from its own schema — the
generator, the 464-entry maps, the coverage ratchet at 0, and the size bound
built for them. All of it is on `wo/typedio-coverage` at `15dd3ca3`; nothing was
deleted. Entries stay at 368 and the coverage ratchet at its matching baseline.

It does not land because **`packages/operator-sdk` stops compiling.** Measured
by building each project separately rather than inferred from the solution
build:

| | result |
|---|---|
| `packages/contracts` | 2s, clean |
| `packages/transport-http` | 2s, clean |
| `packages/operator-sdk`, HEAD's 368 entries | 132s, clean |
| `packages/operator-sdk`, 464 rendered entries | SIGABRT, out of memory, ~500s |

**Heap caveat, so these numbers are not misread:** those runs are bare
`bunx tsc`, which gets node's DEFAULT ~4 GB ceiling. The raised ceiling in
`scripts/typecheck.ts` does not apply to them. Both sides of the comparison sit
at the same 4 GB, so the comparison holds; absolute headroom is a separate
question, and at a 16 GB ceiling the full rendering still ran past 10 minutes
without finishing.

The cause is breadth, not a few fat verbs.
`OperatorRemoteClient.invoke<TMethodId extends OperatorTypedMethodId>` is
generic over the whole method-id union, so `MethodArgs` — and `OmitNamed` and
`RequiredKeys` beneath it — instantiate once per member.

### The size bound, built and measured, for whoever picks this up

Bounding by rendered input size was tried. It is not sufficient on its own, but
the analysis is sound and should not be redone:

- 464 verbs, median 41 rendered characters, mean 136, then a very short tail.
- A 1100-character gap sits between `automation.schedules.create` (2384) and
  `multimodal.writeback` (1287). **Threshold: 1800 characters**, chosen as the
  widest empty interval in the distribution — anywhere inside the gap bounds the
  same three verbs, and nothing sits near enough to flip across it on an
  incidental schema edit.
- Bounded verbs: `automation.jobs.create`, `automation.jobs.update`,
  `automation.schedules.create`.
- "Bounded" means the required properties keep their real types and the optional
  ones fall into the open index signature the envelope already has. That
  deliberately preserves requiredness — bounding by dropping the whole shape
  would have reintroduced the `never` defect on those three. The schema is
  untouched; the invoke gate still enforces it in full.
- Effect: total rendered input characters 63,347 → 55,483, against HEAD's
  45,613. It recovers about 45% of the gap. Not enough, because the cost is
  breadth.

The bound was built with disclosure and a two-way ratchet before being trusted,
and that immediately earned its keep: the branch-exemption rule was
early-returning, so the two `automation.*.create` verbs — which sit in BOTH the
branch-exemption set and the size-bound set — were never bounded at all. The
bound looked applied while doing nothing to the two largest inputs it existed
for. A count alone would not have shown that; naming the verbs did.

### The real fix, scheduled not forgotten

Make `OperatorRemoteClient.invoke` non-generic across all method ids. That
changes the public operator client's signature, so it needs its own work order
and its own verification rather than being done at the tail of a merge sequence.
The expansion and the bound land the moment it is done.

## Standing cost, unrelated to any of the above

`packages/operator-sdk` takes **132 seconds** to typecheck on HEAD's own 368
entries, at the default 4 GB heap. That predates this round. Anyone adding verbs
should know what they are walking toward; it was not introduced here and is not
fixed here.
