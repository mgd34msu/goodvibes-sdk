# Testing and Validation

> Consumer and contributor guidance. For internal testing architecture see [Testing Architecture](./testing.md).

The SDK repo validates more than TypeScript build success. `bun run validate` is the portable command CI runs; it does not require any external repo checkout.

## CI Gates

This is the canonical CI-gate reference for the workspace. Every push and PR to `main` runs seven standalone jobs (see `.github/workflows/ci.yml`). The documentation, contract-artifact, version, changelog, error, todo, examples, API-surface, and bundle-budget checks are **not** separate jobs — they run as ordered **steps inside the single `validate` job** (see `scripts/validate.ts`).

| Job | Command | Purpose |
|------|---------|---------|
| `validate` | `bun run validate` | Kitchen-sink validation. Runs these checks as ordered steps: API docs sync, docs/examples completeness, error/changelog/version/todo/skipped-test/platform-console gates, TypeScript build, type-level checks (`types:check`), API-surface check (`api:check`), examples typecheck, browser-compat, package metadata, no-any, pack, publint, install smoke, contract-artifact check (`contracts:check`), and bundle budget (`bundle:check`) |
| `security-audit` | `bun audit --audit-level high` + gitleaks scan (`gitleaks/gitleaks-action`) | Runs `bun audit --audit-level high` against the workspace dependency tree and a gitleaks secret scan; the CI job invokes these two steps directly (local `bun run security:audit` covers only the dependency-audit half) |
| `build` | `bun run build` | Builds all workspace package `dist/` output once and uploads it as a single `workspace-build-output` artifact for downstream CI jobs |
| `platform-matrix` | `bun run build && bun run test` (+ `test:rn`, `test:workers`, `test:workers:wrangler` legs) | Runs the full Bun test suite plus the companion-bundle scan and the Workers runtime lanes (see legs below) |
| `types-resolution-check` | `bunx attw --pack packages/sdk --ignore-rules no-resolution cjs-resolves-to-esm` | Validates the `exports` map resolves cleanly for every published subpath |
| `publint-check` | `bun run publint:check` | Detects common `package.json` packaging hygiene issues before release |
| `sbom-check` | `bun run sbom:check` | Generates the CycloneDX SBOM (`sbom.cdx.json`), asserts it is non-empty, validates the CycloneDX schema, and enforces the license policy |

The `platform-matrix` job runs as four matrix legs (one job, not four):

- **bun** — `bun run build && bun run test` runs the full Bun test suite.
- **rn-bundle** — `bun run build && bun run test:rn` verifies companion dist bundles, including `workers.js`, contain no `Bun.*` identifiers and no `node:*` imports.
- **workers** — `bun run test:workers` runs the `./web` entry under Miniflare 4 (workerd V8 isolate, in-process) — 9 tests validate Worker-runtime support (no `node:*`, no `Bun.*`, no client `EventSource`/`WebSocket` dependence). The dedicated `./workers` bridge is covered by source-level batch bridge tests and the `rn-bundle` companion scan.
- **workers-wrangler** — `bun run test:workers:wrangler` runs the `./web` entry under `wrangler dev --local` — exercises wrangler's esbuild bundling pipeline and wrangler.toml config. NOTE: wrangler dev --local shares the Miniflare 4 runtime, so this is **not** a production-workerd verification; see `test/workers/NOTES.md` for runtime coverage boundaries.

## Portable Validation

```bash
bun run validate
```

`bun run validate` runs the complete ordered step list documented in the `validate`
row of the [CI Gates](#ci-gates) table above: API docs sync, docs/examples
completeness, the error/changelog/version/todo/skipped-test/platform-console gates,
TypeScript build, type-level checks (`types:check`), API-surface check (`api:check`),
examples typecheck, browser-compat, package metadata, no-any, pack, publint, install
smoke, contract-artifact check (`contracts:check`), and bundle budget (`bundle:check`).
Test execution is owned by the `platform-matrix` jobs; run `bun run test` locally when
you need the full Bun test suite.

`bun run build` and the package test scripts share the repo workspace lock.
That prevents tests from reading `packages/*/dist` while another build or
validation process is cleaning and rebuilding package output. Use
`bun run test`, `bun run test:rn`, `bun run test:workers`, or
`bun run test:workers:wrangler` instead of invoking `bun test ...` directly
when package `dist` imports are involved.

## Focused Checks

For fast iteration, run the individual check that matches your change instead of
the full `validate` job:

| Command | Purpose |
|---------|---------|
| `bun run validate:strict` | Runs `validate`, then `types:check` and `contracts:check` for an extra-strict local pass |
| `bun run dist:check` | Checks that committed `dist/` output is fresh relative to source (`scripts/check-dist-freshness.ts`) |
| `bun run check:browser` | Browser/companion compatibility scan (`scripts/browser-compat-check.ts`) |
| `bun run check:metadata` | Validates published `package.json` metadata (`scripts/package-metadata-check.ts`) |
| `bun run any:check` | Fails on disallowed `any` types (`scripts/no-any-types.ts`) |
| `bun run platform-console:check` | Fails on disallowed platform `console.*` usage (`scripts/no-platform-console.ts`) |
| `bun run test-skip:check` | Fails on skipped or `.only` tests (`scripts/no-skipped-tests.ts`) |
| `bun run security:audit` | Dependency audit at `--audit-level high` (`bun audit`) |

## Contract Refresh

When generated contract artifacts change, refresh the canonical contract package artifacts before validating:

```bash
bun run refresh:contracts
bun run validate
```

`bun run refresh:contracts` updates generated contract JSON artifacts in `packages/contracts/artifacts`. SDK package preparation copies those artifacts into the published package. source copies were removed; sibling packages are the source of truth.

## Zod Opt-In Validation

The HTTP transport layer supports opt-in Zod v4 response validation at the transport boundary. Pass a `responseSchema` on individual method calls to validate the parsed response body:

```ts
import { z } from 'zod/v4';

const result = await sdk.operator.invoke('namespace.method', input, {
  responseSchema: z.object({ id: z.string() }),
});
```

This is opt-in per call — there is no global schema enforcement. Schema mismatch throws a `ContractError` (a `GoodVibesSdkError` subclass with `kind: 'contract'`).

## Bundle Budget Enforcement

`bundle-budgets.json` at the repo root defines per-entry gzip size ceilings using
`max(ceil(actual * 1.2), actual + 50)` over the last measured gzip size — a 20%
growth multiplier with a `+50 B` floor so tiny facade entries are not failed by a
handful of bytes. `bun run bundle:check` is both the local budget check and the
bundle-budget step inside the `validate` job. See
[`bundle-budgets.README.md`](../bundle-budgets.README.md) for the full
methodology, exclusions, and per-entry rationale rules.

To see current actual sizes:

```bash
bun run bundle:check
```

To update budgets after a legitimate size change:
1. Run `bun run bundle:check` to get the new actual sizes.
2. Set `gzip_bytes` to `max(ceil(actual * 1.2), actual + 50)` for each changed entry in `bundle-budgets.json` (the `+50 B` floor dominates for tiny entries below ~250 B).
3. Keep the file's top-level budget note generic; do not leave stale wave/date
   rationale in the budget baseline.

## Test Coverage Snapshot

[`COVERAGE.md`](../COVERAGE.md) is a generated snapshot of the root-level
`test/*.test.ts` files, produced by `scripts/print-test-coverage.ts`
(`bun scripts/print-test-coverage.ts > COVERAGE.md`). It is **not** enforced by
any CI gate, so it can drift from the actual test set — treat it as a
human-readable index, not an authoritative coverage report.

## License And SBOM Checks

License compliance is tracked through the CycloneDX SBOM generated by
`bun run sbom:check`; the generated `sbom.cdx.json` is intentionally ignored
because it is release/build output. CI runs the `sbom-check` job after the SDK
build artifact is produced, validates the CycloneDX shape, and rejects blocked
license families. Use `bun run sbom:generate` only when you need to regenerate
the raw SBOM without running the validation and license-policy checks.

## Release-Gate Failure Scenarios

Maintainer-facing guidance for the most common release-gate failures:

- **Contract drift** — the contract-artifact step (`contracts:check`) fails when the SDK-embedded contract JSON no longer matches `packages/contracts/artifacts`. Run `bun run refresh:contracts`, then re-run `bun run validate`.
- **Bundle overage** — `bundle:check` fails when a JavaScript export exceeds its gzip ceiling. Investigate the size increase; if it is legitimate, update `bundle-budgets.json` using `max(ceil(actual * 1.2), actual + 50)` and record the new measurement in the entry rationale.
- **SBOM / license policy** — `sbom-check` fails when `sbom.cdx.json` is empty or schema-invalid, or when a dependency carries a blocked license family. Resolve the offending dependency, or update the license policy if the family is acceptable.
- **Types resolution (attw)** — `types-resolution-check` fails when the `exports` map does not resolve cleanly for a published subpath. Fix the `exports`/types wiring in `packages/sdk/package.json` and re-run `bunx attw --pack packages/sdk`.

## Workers Runtime Verification

The `./browser` companion entry point (`createBrowserGoodVibesSdk`) is Workers-ready (the `./web` entry is an equivalent alias — use `./browser` for new projects). (Cloudflare Workers / Miniflare 4 / `workerd`). CI verifies this three ways: (1) `rn-bundle` statically scans the built `web.js` and `workers.js` for forbidden identifiers (`node:*`, `Bun.*`); (2) `platform-matrix (workers)` boots the `./web` entry (the `./web` alias of the Workers-ready `./browser`) under Miniflare 4's programmatic workerd isolate and runs 9 real-runtime tests; (3) `platform-matrix (workers-wrangler)` boots the `./web` entry via `wrangler dev --local` to exercise wrangler's esbuild pipeline and `wrangler.toml` (note: wrangler dev --local uses Miniflare 4 internally, so both runtime lanes share the same isolate; see `test/workers/NOTES.md` for runtime coverage boundaries). The `./workers` entry is a small Worker bridge for daemon batch routes, Cloudflare Queue consumers, and scheduled ticks; its source-level behavior is covered by `test/cloudflare-worker-batch.test.ts`. SDK-owned Cloudflare provisioning is covered without live Cloudflare calls by `test/cloudflare-control-plane.test.ts` using an injected fake Cloudflare API client.

## Type-Level Tests

`bun run types:check` compiles type-level usage tests in `tsconfig.type-tests.json`. These catch public API type regressions without running the code — e.g. verifying that factory function return types are assignable to their documented interfaces.

## Why Each Gate Exists

- **contract-artifact-check** — the SDK package artifact exports must match `packages/contracts/artifacts`. source copies were removed; implementation code is no longer copied into the SDK package.
- **error-contract-check** — The public `SDKErrorKind` taxonomy, retryable status list, and consumer-facing error-kind docs must stay aligned. Run it locally with `bun run error:check`. Internal implementation throws are allowed when they are caught and normalized at public transport/daemon boundaries.
- **rn-bundle** — Static bundle scan. Companion surface (React Native, Expo, browser, web, workers) must be safe for Metro, Vite, webpack, and esbuild. Any `Bun.*` identifier or `node:*` import breaks mobile and browser bundlers. (Runtime verification of `./web` under workerd lives in the separate `workers` and `workers-wrangler` lanes above.)
- **bundle:check** — Prevents accidental bundle size growth; runs as a step in the
  `validate` job. Each export has a gzip ceiling computed as
  `max(ceil(actual * 1.2), actual + 50)`; the 20% multiplier plus `+50 B` floor
  prevents transient-spike failures on tiny entries.
- **types-check** — TypeScript type inference is non-trivial for discriminated union returns. Type tests validate at compile time without runtime overhead.
