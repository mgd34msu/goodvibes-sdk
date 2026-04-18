# CI Integration: `bundle-budget` Job

## Adding to CI

Add the following job to your GitHub Actions workflow (`.github/workflows/ci.yml` or equivalent).
Do **not** run `bun run sync` — it is intentionally excluded from CI.

```yaml
  bundle-budget:
    name: Bundle Size Budgets
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd

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
- The script auto-builds (`bun run build`) if `dist/` is missing or stale, so no
  explicit build step is required.
- The job exits non-zero if any entry exceeds its budget OR has no budget entry
  in `bundle-budgets.json`. Both conditions are hard failures.
- Timeout is set to 5 minutes (`timeout-minutes: 5`) — the build + check should
  complete in under 2 minutes on a cold runner.

---

## `bundle-budgets.json` Format Reference

The file lives at the **repo root**: `bundle-budgets.json`.

### Schema

```json
{
  "_comment": ["optional string array — ignored by the script"],
  "<export-key>": {
    "gzip_bytes": <number>,
    "rationale": "<string — optional, human-readable explanation>"
  }
}
```

### Rules

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `<export-key>` | `string` | — | Must exactly match a key from `packages/sdk/package.json` `exports` map (e.g. `"."`, `"./auth"`, `"./browser"`). |
| `gzip_bytes` | `number` | yes | Maximum allowed gzipped size in bytes for the built `.js` file. |
| `rationale` | `string` | no | Human-readable explanation of the budget value (recommended). |

### Wildcard and non-JS entries are skipped

The script automatically skips:
- Keys containing `*` (e.g. `"./platform/*"`)
- `"./package.json"`
- Entries whose `import`/`require`/`default` value does not end in `.js`

You do **not** need to add budget entries for these.

### Updating budgets

After Zod lands (or any other dep that increases bundle size):

1. Run `bun run bundle:check` locally to see current actual sizes in the table.
2. For any entry that changed, set `gzip_bytes` to `Math.ceil(actual * 1.2)`.
3. Update the `_comment` date field to reflect the new measurement date.
4. Commit the updated `bundle-budgets.json`.

### Adding a new entry-point

When a new key is added to `packages/sdk/package.json` `exports`:

1. Build: `bun run build`
2. Measure: `gzip -c packages/sdk/dist/<new-entry>.js | wc -c`
3. Set budget: `Math.ceil(measured * 1.2)`
4. Add entry to `bundle-budgets.json` with a `rationale` string.

The CI job will fail with `! NO BUDGET` until a budget is registered — this is
intentional to force explicit registration of every new entry point.
