# CI Integration: bundle size budgets (`bundle:check`)

## Current CI Gate

The repo runs `bun run bundle:check` as a step inside the consolidated `validate`
job (via `bun run validate`) in `.github/workflows/ci.yml` — there is no
standalone `bundle-budget-check` job. Generated artifact drift is covered by the
`bun run contracts:check` step in that same `validate` job; there is no separate
`contract-artifact-check` job. The standalone job YAML below is illustrative —
add it only if the bundle gate ever needs to be isolated.

```yaml
  bundle-budget-check:
    name: Bundle size budgets
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: "1.3.10"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Check bundle budgets
        run: bun run bundle:check
```

### Notes

- The job runs `bun run bundle:check` which invokes `scripts/bundle-budget.ts`.
- The script auto-builds (`bun run build`) only when `dist/` is missing; if `dist/`
  exists but is stale it warns and does NOT rebuild — pass `--build` to force a
  rebuild, or run `bun run build` first.
- `bun run bundle:check:strict` runs the same check with `--no-build`, which
  errors (instead of building) if `dist/` is missing — use it in CI after a
  separate build step.
- The job exits non-zero if any entry exceeds its budget, has no budget entry in
  `bundle-budgets.json`, OR has a stale budget entry whose key no longer matches
  a package export. All three are hard failures — when you remove an export, also
  remove its `bundle-budgets.json` entry (see *Removing an entry-point* below).
- Timeout is set to 5 minutes (`timeout-minutes: 5`) — the build + check should
  complete in under 2 minutes on a cold runner.

---

## `bundle-budgets.json` Format Reference

The file lives at the **repo root**: `bundle-budgets.json`.

### Schema

```json
{
  "<note-key>": "optional human-readable note — ignored by the script",
  "<export-key>": {
    "gzip_bytes": <number>,
    "rationale": "<string — optional, human-readable explanation>"
  }
}
```

Budget-entry objects may carry extra human-readable fields that the size check ignores. One exception: the `./events` entry's `domains` array is validated against `dist/events/*.js`, and the gate fails if the list drifts from the built domain files.

### Rules

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `<export-key>` | `string` | — | Must exactly match a key from `packages/sdk/package.json` `exports` map (e.g. `"."`, `"./auth"`, `"./browser"`). |
| `gzip_bytes` | `number` | yes | Maximum allowed gzipped size in bytes for the built `.js` file. |
| `rationale` | `string` | no | Human-readable explanation of the budget value (recommended). |

### Wildcard and non-JS entries are skipped

The script automatically skips:
- Keys containing `*` (subpath-pattern export keys, if any are added)
- `"./package.json"`
- Entries whose `import`/`require`/`default` value does not end in `.js`

You do **not** need to add budget entries for these.

### Updating budgets

After a legitimate dependency or implementation change increases bundle size:

1. Run `bun run bundle:check` locally to see current actual sizes in the table.
2. For any entry that changed, set `gzip_bytes` to `Math.ceil(actual * 1.2)`.
3. Keep note entries generic; do not add wave/date-specific rationale.
4. Commit the updated `bundle-budgets.json`.

### Adding a new entry-point

When a new key is added to `packages/sdk/package.json` `exports`:

1. Build: `bun run build`
2. Measure: `gzip -c packages/sdk/dist/<new-entry>.js | wc -c`
3. Set budget: `Math.ceil(measured * 1.2)`
4. Add entry to `bundle-budgets.json` with a `rationale` string.

The CI job will fail with `! NO BUDGET` until a budget is registered — this is
intentional to force explicit registration of every new entry point.

### Removing an entry-point

When a key is removed from `packages/sdk/package.json` `exports`:

1. Remove the matching entry from `bundle-budgets.json`.
2. If the removed export was an event domain under `./events`, also drop it from
   the `./events` entry's `domains` array.

A budget key that no longer matches any package export is treated as **stale**:
the script reports `stale bundle budget entries do not match a JS export` and
exits non-zero. Deleting the orphaned entry clears the gate.
