# CI Setup: `flake-detect` Gate

Add the following job to `.github/workflows/ci.yml`.

Uses the same SHA-pinned action versions as the existing CI jobs.
Job timeout is 15 minutes. N=3 repetitions in CI (versus N=5 local default).

```yaml
  flake-detect:
    name: Flake detection (N=3 stability check)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: "1.3.10"
      - name: Install dependencies
        run: bun install
      - name: Build SDK
        run: bun run build
      - name: Run flake detection (3 repetitions)
        env:
          FLAKE_RUNS: "3"
        run: bun run flake:check
```

## Notes

- Script: `scripts/flake-detect.ts`
- Root script: `flake:check` → `bun scripts/flake-detect.ts`
- Configurable via `FLAKE_RUNS` env var (default: 5, CI uses 3)
- Passes if all N runs produce identical pass/fail outcomes
- Fails if any test flips between pass and fail (flaky), OR if all runs fail (deterministic failure)
- Build step required before flake check to ensure `dist/` is present
- Do NOT run locally without `FLAKE_RUNS=3` unless you have time for 5 full test suite runs
- CI runs flake-check **only on `schedule`** (nightly cron at 06:00 UTC). PRs and push-to-main
  do NOT run flake detection. This is an intentional trade-off: running N=3 full test suites on
  every PR would add ~20 minutes to the CI clock. If you introduce a flaky test, it will surface
  in the nightly run but not in PR CI. Document any known flaky tests in this file.
