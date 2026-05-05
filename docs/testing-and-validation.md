# Testing and Validation

> Consumer and contributor guidance. For internal testing architecture see [Testing Architecture](./testing.md).

The SDK repo validates more than TypeScript build success. `bun run validate` is the portable command CI runs; it does not require any external repo checkout.

## CI Gates

Every push and PR to `main` must pass these gates:

| Gate | Command | Purpose |
|------|---------|---------|
| `validate` | `bun run validate` | Kitchen-sink validation: API docs sync, docs/examples completeness, error/changelog/version/todo/skipped-test gates, TypeScript build, type-level checks, runtime support, package metadata, no-any, pack, install smoke |
| `build` | `bun run build` | Builds `packages/sdk/dist` once and uploads it for downstream CI jobs |
| `contract-artifact-check` | `bun run contracts:check` | Ensures SDK-embedded contract JSON artifacts match `packages/contracts/artifacts` |
| `platform-matrix (bun)` | `bun run build && bun run test` | Runs the full Bun test suite |
| `platform-matrix (rn-bundle)` | `bun run build && bun run test:rn` | Verifies companion dist bundles, including `workers.js`, contain no `Bun.*` identifiers and no `node:*` imports |
| `types-check` | `bun run types:check` | Compiles type-level usage tests against the uploaded build artifact to catch type regressions |
| `api-surface-check` | `bun run api:check` | Verifies the API Extractor baseline matches the public type surface built by the `build` job |
| `sbom-check` | `bun run sbom:check` | Generates the CycloneDX SBOM (`sbom.cdx.json`), asserts it is non-empty, validates the CycloneDX schema, and enforces the license policy |
| `platform-matrix (workers)` | `bun run test:workers` | Runs the `./web` entry under Miniflare 4 (workerd V8 isolate, in-process) — 9 tests validate Worker-runtime support (no `node:*`, no `Bun.*`, no client `EventSource`/`WebSocket` dependence). The dedicated `./workers` bridge is covered by source-level batch bridge tests and the `rn-bundle` companion scan. |
| `platform-matrix (workers-wrangler)` | `bun run test:workers:wrangler` | Runs the `./web` entry under `wrangler dev --local` — exercises wrangler's esbuild bundling pipeline and wrangler.toml config. NOTE: wrangler dev --local shares the Miniflare 4 runtime, so this is **not** a production-workerd verification; see `test/workers/NOTES.md` for runtime coverage boundaries. |
| `types-resolution-check` | `bunx attw --pack packages/sdk --ignore-rules no-resolution cjs-resolves-to-esm` | Validates the `exports` map resolves cleanly for every published subpath |
| `publint-check` | `bun run publint:check` | Detects common `package.json` packaging hygiene issues before release |
| `bundle-budget-check` | `bun run bundle:check` | Verifies every JavaScript export has an explicit budget and stays within the gzip ceiling |

## Portable Validation

```bash
bun run validate
```

Covers: API docs sync, docs/examples completeness, error/changelog/version/todo
gates, skipped-test detection, TypeScript build, type-level checks, runtime
support, package metadata, no-any, pack, and install smoke. Test execution is
owned by the `platform-matrix` jobs; run `bun run test` locally when you need
the full Bun test suite.

`bun run build` and the package test scripts share the repo workspace lock.
That prevents tests from reading `packages/*/dist` while another build or
validation process is cleaning and rebuilding package output. Use
`bun run test`, `bun run test:rn`, `bun run test:workers`, or
`bun run test:workers:wrangler` instead of invoking `bun test ...` directly
when package `dist` imports are involved.

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

const result = await transport.requestJson(route, payload, {
  responseSchema: z.object({ id: z.string() }),
});
```

This is opt-in per call — there is no global schema enforcement. Schema mismatch throws a `GoodVibesSdkError` with `kind: 'validation'`.

## Bundle Budget Enforcement

`bundle-budgets.json` at the repo root defines per-entry gzip size ceilings with
20% growth headroom over the last measured size. `bun run bundle:check` is both
the local budget check and the CI `bundle-budget-check` job.

To see current actual sizes:

```bash
bun run bundle:check
```

To update budgets after a legitimate size change:
1. Run `bun run bundle:check` to get the new actual sizes.
2. Set `gzip_bytes` to `ceil(actual * 1.2)` for each changed entry in `bundle-budgets.json`.
3. Keep the file's top-level budget note generic; do not leave stale wave/date
   rationale in the budget baseline.

## License And SBOM Checks

License compliance is tracked through the CycloneDX SBOM generated by
`bun run sbom:check`; the generated `sbom.cdx.json` is intentionally ignored
because it is release/build output. CI runs the `sbom-check` job after the SDK
build artifact is produced, validates the CycloneDX shape, and rejects blocked
license families. Use `bun run sbom:generate` only when you need to regenerate
the raw SBOM without running the validation and license-policy checks.

## Workers Runtime Verification

The `./browser` companion entry point (`createBrowserGoodVibesSdk`) is Workers-ready (the `./web` entry is an equivalent alias — use `./browser` for new projects). (Cloudflare Workers / Miniflare 4 / `workerd`). CI verifies this three ways: (1) `rn-bundle` statically scans the built `web.js` and `workers.js` for forbidden identifiers (`node:*`, `Bun.*`); (2) `platform-matrix (workers)` boots `./browser` under Miniflare 4's programmatic workerd isolate and runs 9 real-runtime tests; (3) `platform-matrix (workers-wrangler)` boots `./browser` via `wrangler dev --local` to exercise wrangler's esbuild pipeline and `wrangler.toml` (note: wrangler dev --local uses Miniflare 4 internally, so both runtime lanes share the same isolate; see `test/workers/NOTES.md` for runtime coverage boundaries). The `./workers` entry is a small Worker bridge for daemon batch routes, Cloudflare Queue consumers, and scheduled ticks; its source-level behavior is covered by `test/cloudflare-worker-batch.test.ts`. SDK-owned Cloudflare provisioning is covered without live Cloudflare calls by `test/cloudflare-control-plane.test.ts` using an injected fake Cloudflare API client.

## Type-Level Tests

`bun run types:check` compiles type-level usage tests in `tsconfig.type-tests.json`. These catch public API type regressions without running the code — e.g. verifying that factory function return types are assignable to their documented interfaces.

## Why Each Gate Exists

- **contract-artifact-check** — the SDK package artifact exports must match `packages/contracts/artifacts`. source copies were removed; implementation code is no longer copied into the SDK package.
- **error-contract-check** — The public `SDKErrorKind` taxonomy, retryable status list, and consumer-facing error-kind docs must stay aligned. Run it locally with `bun run error:check`. Internal implementation throws are allowed when they are caught and normalized at public transport/daemon boundaries.
- **rn-bundle** — Static bundle scan. Companion surface (React Native, Expo, browser, web, workers) must be safe for Metro, Vite, webpack, and esbuild. Any `Bun.*` identifier or `node:*` import breaks mobile and browser bundlers. (Runtime verification of `./web` under workerd lives in the separate `workers` and `workers-wrangler` lanes above.)
- **bundle:check** — Prevents accidental bundle size growth when run locally or
  reintroduced as a CI gate. Each entry has a ceiling; the 20% headroom prevents
  transient-spike failures.
- **types-check** — TypeScript type inference is non-trivial for discriminated union returns. Type tests validate at compile time without runtime overhead.
