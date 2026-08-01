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

- Configs at repo root, one per tracked entry point:
  - `api-extractor.json` — the SDK's client entry point (`packages/sdk/dist/index.d.ts`)
  - `api-extractor.embed.json` — the SDK's embed entry point
  - `api-extractor.terminal-shell.json` — `packages/terminal-shell`, the other package
    consumers import directly. It carries its own
    `packages/terminal-shell/tsconfig.api-extractor.json` for the same reason the SDK
    does, and declares no `bundledPackages`: terminal-shell depends on the SDK rather
    than the other way round, so its report references SDK types by import instead of
    inlining them.
- Baselines, all committed: `etc/goodvibes-sdk.api.md`, `etc/goodvibes-sdk-embed.api.md`,
  `etc/goodvibes-terminal-shell.api.md`
- Temp output: `temp/goodvibes-sdk.api.md` — api-extractor's transient scratch report; `temp/` is gitignored (see `.gitignore`). Drift is detected by `git diff` against the committed baseline in `etc/`, not via `temp/`.
- Root scripts:
  - `api:extract` → runs all three configs in local mode (writes to `etc/`, always succeeds)
  - `api:check`  → `api:extract`, then `git diff --quiet` over all three committed
    baselines, then `api:subpath:check`. Exits non-zero if any of them moved.
- To update the baseline after intentional API changes: run `bun run api:extract` locally and commit `etc/goodvibes-sdk.api.md`
- Compiler message suppression: `compilerMessageReporting` in `api-extractor.json` keeps the default compiler diagnostic level at warning; a documented set of TypeScript diagnostic codes (`TS1259`, `TS2305`, `TS2307`, `TS2344`, `TS2694`, `TS2702`, `TS2707`, `TS2709`, `TS2304`, `TS2552`, `TS18028`) is set to `none`, each annotated inline in `api-extractor.json`. These stem from module-interop and vendored-upstream noise outside the SDK's public surface. First-party compile failures are still caught by the build and type-check gates before API extraction.
- The `ae-missing-release-tag` extractor warning is suppressed (pre-1.0 policy: release tags not yet required); `ae-unresolved-inheritdoc-reference` and `ae-forgotten-export` are likewise set to `none` in `extractorMessageReporting`.
- The rollups cover ONE entry point each. Everything published only through a subpath
  export is covered instead by `scripts/check-subpath-api-surface.ts`, which walks each
  tracked package's `exports` map and records every subpath's surface into
  `etc/subpath-api-surface.json` (SDK) and `etc/subpath-api-surface-terminal-shell.json`.
  That script covers terminal-shell's `./conformance` and `./terminal-output-guard`
  entry points, which no rollup config sees. Both mechanisms run inside `api:check`.
- The dedicated `packages/sdk/tsconfig.api-extractor.json` sets `noEmit: true` + `composite: false` so api-extractor's internal tsc pass does NOT write to `dist/`. Without this, running `api:check` would stomp the real build output.

## Workflow for API Changes

1. Make your public API change in source
2. Run `bun run build` to rebuild `dist/`
3. Run `bun run api:extract` to update the baseline
4. Commit your source changes AND every updated baseline under `etc/`
5. CI `api:check` will pass because baseline matches

This makes every public API change a conscious, visible, git-tracked decision.
