# CI Setup: `no-todo-markers` Gate

Add the following job to `.github/workflows/ci.yml`.

Uses the same SHA-pinned action versions as the existing CI jobs.

```yaml
  no-todo-markers:
    name: No TODO/FIXME/XXX/HACK/STUB markers in public source
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
        run: bun install
      - name: Check for TODO/FIXME/XXX/HACK/STUB markers in public source
        run: bun run todo:check
```

## Notes

- Script: `scripts/no-todo-markers.ts`
- Root script: `todo:check` → `bun scripts/no-todo-markers.ts`
- Scans: `packages/` (excludes `_internal/`, `vendor/`, `generated/`, `*.test.ts`, `node_modules/`, `dist/`)
- No build step required — the script reads source `.ts` files directly
- Exits non-zero and prints `file:line [MARKER]` for every violation found
