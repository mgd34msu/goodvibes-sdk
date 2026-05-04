# bundle-budgets.json — methodology and exclusions

This document explains the structure of `bundle-budgets.json` so that file can stay machine-focused (entries + per-entry rationales) without an oversized `_comment` block.

## Methodology

`gzip_bytes = max(ceil(actual_gzipped_bytes * 1.2), actual_gzipped_bytes + 50)` for the last accepted dist/ baseline.

- For entries below ~250 B, the **+50 B floor** dominates the 1.2x multiplier. This is intentional — tiny facades get a flat +50 B headroom regardless of size.
- The **1.2x multiplier** only matters for entries larger than ~250 B.
- This keeps tiny facade entries from failing over a handful of bytes while retaining tight proportional budgets for larger entry points.

## Updating after a legitimate bundle-size change or new entry

1. Run `bun run bundle:check` to see the current actual sizes.
2. Set `gzip_bytes` to `max(ceil(actual * 1.2), actual + 50)` for each changed entry.
3. Update the per-entry `rationale` with the new measurement and the commit at which it was taken.
4. Keep entry rationales free of stale wave/date-specific narrative — anchor to a commit hash.

Entry keys must match the `exports` map keys in `packages/sdk/package.json` exactly.

## Intentional exclusions (not budgeted here)

- **`./events/<domain>` explicit subpath entries** — each per-domain event file is a small typed barrel (~50–200 B gzip). Real domain files at HEAD: `agents`, `automation`, `communication`, `compaction`, `contracts`, `control-plane`, `deliveries`, `domain-map`, `forensics`, `knowledge`, `mcp`, `mcp-types`, `ops`, `orchestration`, `permissions`, `planner`, `plugins`, `providers`, `routes`, `security`, `session`, `surfaces`, `tasks`, `tools`, `transport`, `turn`, `ui`, `watchers`, `workflows`, `workspace`. Contributors adding a new event domain that pulls in a large dependency should verify size manually via `bundle:check`.
- **`./contracts/operator-contract.json` and `./contracts/peer-contract.json`** — static JSON artifacts; their size is governed by the contract refresh process at `scripts/refresh-contract-artifacts.ts`.
- **`./package.json`** — metadata only, not a runtime bundle.
- **`./platform` subsystem namespaces** (`acp`, `adapters`, `artifacts`, `automation`, `batch`, `bookmarks`, `channels`, `cloudflare`, `companion`, `control-plane`, `discovery`, `export`, `hooks`, `mcp`, `media`, `permissions`, `plugins`, `profiles`, `scheduler`, `security`, `sessions`, `state`, `templates`, `types`, `watchers`, `web-search`, `workflow`, `workspace`) — budgeted only via the `./platform` aggregate. A 10x expansion of any individual subsystem will fail that single budget; promote the subsystem to a dedicated subpath entry if it grows past ~200 B individually.

## Validation

`scripts/bundle-budget.ts` compares `bundle-budgets.json` keys to `package.json` exports. CI fails on missing or unknown entries. To add a new export, add it to `package.json/exports` AND `bundle-budgets.json/<key>` in the same PR.

```bash
bun run bundle:check          # includes build step
bun run bundle:check:strict   # skips build, uses existing dist/
```
