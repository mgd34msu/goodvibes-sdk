# CI Setup: public source marker gate

The repository runs `bun run todo:check` as a step inside the consolidated
`validate` job (via `bun run validate`) in `.github/workflows/ci.yml`. There is
no standalone `no-todo-markers` job. The job YAML below is illustrative (not
wired into CI) — add it only if that check needs to be isolated later.

Uses the same SHA-pinned action versions as the existing CI jobs.

```yaml
  no-todo-markers:
    name: No TODO/FIXME/XXX/HACK/STUB markers in public source
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
        run: bun install
      - name: Check for TODO/FIXME/XXX/HACK/STUB markers in public source
        run: bun run todo:check
```

## Notes

- Script: `scripts/no-todo-markers.ts`
- Root script: `todo:check` → `bun scripts/no-todo-markers.ts`
- Scans: `packages/` (excludes `vendor/`, `generated/`, `*.test.ts`/`*.spec.ts`, `node_modules/`, `dist/`)
- No build step required — the script reads source files directly (`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.mjs`/`.cjs`)
- Exits non-zero and prints `file:line:col [MARKER]` for every violation found, followed by an indented line showing the offending source text
