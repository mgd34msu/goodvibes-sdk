# bundle-budgets.json — methodology and exclusions

This document explains the structure of `bundle-budgets.json` so that file can stay machine-focused with entries and per-entry rationales.

## Methodology

`gzip_bytes = max(ceil(actual_gzipped_bytes * 1.2), actual_gzipped_bytes + 50)` for the last accepted dist/ baseline.

- For entries below ~250 B, the **+50 B floor** dominates the 1.2x multiplier. This is intentional — tiny facades get a flat +50 B headroom regardless of size.
- The **1.2x multiplier** only matters for entries larger than ~250 B.
- This keeps tiny facade entries from failing over a handful of bytes while retaining tight proportional budgets for larger entry points.

## Updating after a legitimate bundle-size change or new entry

1. Run `bun run bundle:check` to see the current actual sizes.
2. Set `gzip_bytes` to `max(ceil(actual * 1.2), actual + 50)` for each changed entry.
3. Update the per-entry `rationale` with the new measurement and the release or commit at which it was taken.
4. Keep entry rationales free of stale wave/date-specific narrative — anchor to a concrete release or commit.

Entry keys must match the `exports` map keys in `packages/sdk/package.json` exactly.

## Tracked aggregates (budgeted here, deliberately)

- **`./events` barrel and domain entries** — `package.json` declares the root
  `./events` entry and explicit `./events/<domain>` entries. `bundle-budgets.json`
  tracks the root barrel because it is the public aggregate entry consumers
  import when they want the event type/guard facade, and it also tracks each
  explicit per-domain entry so every public import path has a budget.
  The aggregate's `domains` array enumerates the in-scope domain identifiers for
  human reference; `scripts/bundle-budget.ts` verifies that list against the
  actual event-domain files.

## Intentional exclusions (not budgeted here)

- **`./contracts/operator-contract.json` and `./contracts/peer-contract.json`** — static JSON artifacts; their size is governed by the contract refresh process at `scripts/refresh-contract-artifacts.ts`.
- **`./package.json`** — metadata only, not a runtime bundle.
- **Generated JSON/static assets** that do not resolve to JavaScript from the
  package export map. Every explicit JavaScript export, including platform
  subsystem entries such as `./platform/knowledge` and `./platform/runtime/ui`,
  must have a budget.

## Validation

`scripts/bundle-budget.ts` compares `bundle-budgets.json` keys to `package.json` exports. CI fails on missing or unknown entries. To add a new export, add it to `package.json/exports` AND `bundle-budgets.json/<key>` in the same PR.

```bash
bun run bundle:check          # includes build step
bun run bundle:check:strict   # skips build, uses existing dist/
```
