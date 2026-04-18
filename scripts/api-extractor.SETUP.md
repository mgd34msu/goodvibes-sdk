# CI Setup: `api-surface-snapshot` Gate

Add the following job to `.github/workflows/ci.yml`.

Uses the same SHA-pinned action versions as the existing CI jobs.
Fails if the extracted public API surface differs from the committed baseline `etc/goodvibes-sdk.api.md`.

```yaml
  api-surface-snapshot:
    name: API surface snapshot (api-extractor)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: "1.3.10"
      - name: Install dependencies
        run: bun install
      - name: Build SDK (generates dist/*.d.ts)
        run: bun run build
      - name: Check API surface matches committed baseline
        run: bun run api:check
```

## Notes

- Config: `api-extractor.json` at repo root
- Baseline: `etc/goodvibes-sdk.api.md` — committed to the repo, acts as the API baseline
- Temp output: `temp/goodvibes-sdk.api.md` — generated on each CI run, diffed against baseline; `temp/` is a transient artifact of `bunx api-extractor run` and is gitignored (see `.gitignore`)
- Root scripts:
  - `api:extract` → `bunx api-extractor run --local` (local mode: writes to `etc/`, always succeeds)
  - `api:check`  → `bunx api-extractor run` (CI mode: exits non-zero if surface differs from baseline)
- To update the baseline after intentional API changes: run `bun run api:extract` locally and commit `etc/goodvibes-sdk.api.md`
- Compiler message suppression: `compilerMessageReporting` in `api-extractor.json` uses **per-code overrides** (not a blanket default) to silence specific TS diagnostic codes that originate from third-party `node_modules/` or vendor code beyond our control (TS1259, TS2304, TS2307, TS2322, TS2345, TS2552, TS2688, TS2694, TS2702) plus TS18028 which fires on private class fields in `.d.ts` output due to api-extractor's internal tsc pass ignoring our target. Real first-party compile errors remain visible and are caught by `bun run build` and `bunx tsc --noEmit` earlier in the CI pipeline.
- The `ae-missing-release-tag` extractor warning is suppressed (pre-1.0 policy: release tags not yet required)
- The dedicated `packages/sdk/tsconfig.api-extractor.json` sets `noEmit: true` + `composite: false` so api-extractor's internal tsc pass does NOT write to `dist/`. Without this, running `api:check` would stomp the real build output.

## Workflow for API Changes

1. Make your public API change in source
2. Run `bun run build` to rebuild `dist/`
3. Run `bun run api:extract` to update the baseline
4. Commit both your source changes AND the updated `etc/goodvibes-sdk.api.md`
5. CI `api:check` will pass because baseline matches

This makes every public API change a conscious, visible, git-tracked decision.
