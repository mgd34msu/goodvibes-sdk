# CI Setup: API surface gate (`api:check`)

`api:check` runs as a step inside the consolidated `validate` job (via `bun run
validate`) in `.github/workflows/ci.yml`; there is no separate
`api-surface-check` job. The standalone job below is illustrative — add it only
if this check ever needs to be isolated into its own job.

Uses the same SHA-pinned action versions as the existing CI jobs.
Fails if the extracted public API surface differs from the committed baseline `etc/goodvibes-sdk.api.md`.

```yaml
  api-surface-check:
    name: API surface snapshot
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
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
- Temp output: `temp/goodvibes-sdk.api.md` — api-extractor's transient scratch report; `temp/` is gitignored (see `.gitignore`). Drift is detected by `git diff` against the committed baseline in `etc/`, not via `temp/`.
- Root scripts:
  - `api:extract` → `bunx api-extractor run --local` (local mode: writes to `etc/`, always succeeds)
  - `api:check`  → `bunx api-extractor run --local && git diff --quiet -- etc/goodvibes-sdk.api.md` (regenerates the baseline in `etc/`, then exits non-zero if `git diff` shows the committed `etc/goodvibes-sdk.api.md` changed)
- To update the baseline after intentional API changes: run `bun run api:extract` locally and commit `etc/goodvibes-sdk.api.md`
- Compiler message suppression: `compilerMessageReporting` in `api-extractor.json` keeps the default compiler diagnostic level at warning; a documented set of TypeScript diagnostic codes (`TS1259`, `TS2305`, `TS2307`, `TS2344`, `TS2694`, `TS2702`, `TS2707`, `TS2709`, `TS2304`, `TS2552`, `TS18028`) is set to `none`, each annotated inline in `api-extractor.json`. These stem from module-interop and vendored-upstream noise outside the SDK's public surface. First-party compile failures are still caught by the build and type-check gates before API extraction.
- The `ae-missing-release-tag` extractor warning is suppressed (pre-1.0 policy: release tags not yet required); `ae-unresolved-inheritdoc-reference` and `ae-forgotten-export` are likewise set to `none` in `extractorMessageReporting`.
- The dedicated `packages/sdk/tsconfig.api-extractor.json` sets `noEmit: true` + `composite: false` so api-extractor's internal tsc pass does NOT write to `dist/`. Without this, running `api:check` would stomp the real build output.

## Workflow for API Changes

1. Make your public API change in source
2. Run `bun run build` to rebuild `dist/`
3. Run `bun run api:extract` to update the baseline
4. Commit both your source changes AND the updated `etc/goodvibes-sdk.api.md`
5. CI `api:check` will pass because baseline matches

This makes every public API change a conscious, visible, git-tracked decision.
