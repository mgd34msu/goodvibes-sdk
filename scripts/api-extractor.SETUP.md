# CI Setup: `api-surface-check` Gate

The repository runs the following job in `.github/workflows/ci.yml`.

Uses the same SHA-pinned action versions as the existing CI jobs.
Fails if the extracted public API surface differs from the committed baseline `etc/goodvibes-sdk.api.md`.

```yaml
  api-surface-check:
    name: API surface snapshot
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - name: Setup Bun + deps (cached)
        uses: ./.github/actions/setup
      - name: Build SDK
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
- Compiler message suppression: `compilerMessageReporting` in `api-extractor.json` keeps the default compiler diagnostic level at warning and only overrides `TS1259`, which comes from module-interop noise outside the SDK's public surface. First-party compile failures are still caught by the build and type-check gates before API extraction.
- The `ae-missing-release-tag` extractor warning is suppressed (pre-1.0 policy: release tags not yet required)
- The dedicated `packages/sdk/tsconfig.api-extractor.json` sets `noEmit: true` + `composite: false` so api-extractor's internal tsc pass does NOT write to `dist/`. Without this, running `api:check` would stomp the real build output.

## Workflow for API Changes

1. Make your public API change in source
2. Run `bun run build` to rebuild `dist/`
3. Run `bun run api:extract` to update the baseline
4. Commit both your source changes AND the updated `etc/goodvibes-sdk.api.md`
5. CI `api:check` will pass because baseline matches

This makes every public API change a conscious, visible, git-tracked decision.
