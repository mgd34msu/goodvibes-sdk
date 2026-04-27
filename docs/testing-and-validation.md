# Testing and Validation

The SDK repo validates more than TypeScript build success. `bun run validate` is the portable command CI runs; it does not require any external repo checkout.

## CI Gates

Every push and PR to `main` must pass these gates:

| Gate | Command | Purpose |
|------|---------|---------|
| `validate` | `bun run validate` | Kitchen-sink validation: API docs sync, docs/examples completeness, TypeScript build, type-level checks, browser compatibility, package metadata, no-any, pack, install smoke |
| `build` | `bun run build` | Builds `packages/sdk/dist` once and uploads it for downstream CI jobs |
| `mirror-drift` | `bun run sync:check` | Ensures `_internal` transport-http mirror is byte-for-byte in sync with its canonical source |
| `platform-matrix (bun)` | `bun run build && bun run test` | Runs the full Bun test suite |
| `platform-matrix (rn-bundle)` | `bun run build && bun run test:rn` | Verifies companion dist bundles, including `workers.js`, contain no `Bun.*` identifiers and no `node:*` imports |
| `lint-gates` | inline raw-throw scan + `bun run changelog:check` + `bun run version:check` | Prevents raw public throws, missing changelog sections, and workspace version drift |
| `types-check` | `bun run types:check` | Compiles type-level usage tests against the uploaded build artifact to catch type regressions |
| `sbom-check` | `bun run sbom:generate` + CI-inline size + schema assertions | Generates the CycloneDX SBOM (`sbom.cdx.json`) and asserts non-empty + valid schema (no standalone `sbom:check` script — validation is inlined in `.github/workflows/ci.yml`) |
| `platform-matrix (workers)` | `bun run test:workers` | Runs the `./web` entry under Miniflare 4 (workerd V8 isolate, in-process) — 9 tests validate Worker-runtime compatibility (no `node:*`, no `Bun.*`, no client `EventSource`/`WebSocket` dependence). The dedicated `./workers` bridge is covered by source-level batch bridge tests and the `rn-bundle` companion scan. |
| `platform-matrix (workers-wrangler)` | `bun run test:workers:wrangler` | Runs the `./web` entry under `wrangler dev --local` — exercises wrangler's esbuild bundling pipeline and wrangler.toml config. NOTE: wrangler dev --local shares the Miniflare 4 runtime, so this is **not** a production-workerd verification (see `test/workers/FINDINGS.md`) |
| `types-resolution-check` | `bunx attw --pack packages/sdk --ignore-rules no-resolution cjs-resolves-to-esm` | Validates the `exports` map resolves cleanly for every published subpath |
| `publint-check` | `bun run publint:check` | Detects common `package.json` packaging hygiene issues before release |
| `sync-safety-check` | `bun run sync:check` + inline stale-delete guard | PR-only guard against mirror drift and accidental mass deletion |

## Portable Validation

```bash
bun run validate
```

Covers: API docs sync, docs/examples completeness, TypeScript build,
type-level checks, browser compatibility, package metadata, no-any, pack, and
install smoke. Test execution is owned by the `platform-matrix` jobs; run
`bun run test` locally when you need the full Bun test suite.

`bun run build` and the package test scripts share the repo workspace lock.
That prevents tests from reading `packages/*/dist` while another build or
validation process is cleaning and rebuilding package output. Use
`bun run test`, `bun run test:rn`, `bun run test:workers`, or
`bun run test:workers:wrangler` instead of invoking `bun test ...` directly
when package `dist` imports are involved.

## Internal Refresh

When you changed internal workspace source, refresh the umbrella package before validating:

```bash
bun run sync
bun run validate
```

`bun run sync` rebuilds the umbrella package's internal source tree from the internal workspace packages. It also rewrites import paths. **Do not run `bun run sync` from agent or subagent contexts** — it mass-deletes `_internal/platform/` source.

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
20% growth headroom over the last measured size. `bun run bundle:check` remains
the local budget check. It is not wired as a standalone job in the current
`.github/workflows/ci.yml`; add a workflow step before treating it as a required
CI gate again.

To see current actual sizes:

```bash
bun run bundle:check
```

To update budgets after a legitimate size change:
1. Run `bun run bundle:check` to get the new actual sizes.
2. Set `gzip_bytes` to `ceil(actual * 1.2)` for each changed entry in `bundle-budgets.json`.
3. Update the measurement date in the file's `_comment` block.

## Workers Runtime Verification

The `./web` companion entry point (`createWebGoodVibesSdk`) is Workers-compatible (Cloudflare Workers / Miniflare 4 / `workerd`). CI verifies this three ways: (1) `rn-bundle` statically scans the built `web.js` and `workers.js` for forbidden identifiers (`node:*`, `Bun.*`); (2) `platform-matrix (workers)` boots `./web` under Miniflare 4's programmatic workerd isolate and runs 9 real-runtime tests; (3) `platform-matrix (workers-wrangler)` boots `./web` via `wrangler dev --local` to exercise wrangler's esbuild pipeline and `wrangler.toml` (note: wrangler dev --local uses Miniflare 4 internally, so both runtime lanes share the same isolate — see `test/workers/FINDINGS.md` for the production-workerd gap). The `./workers` entry is a small Worker bridge for daemon batch routes, Cloudflare Queue consumers, and scheduled ticks; its source-level behavior is covered by `test/cloudflare-worker-batch.test.ts`. SDK-owned Cloudflare provisioning is covered without live Cloudflare calls by `test/cloudflare-control-plane.test.ts` using an injected fake Cloudflare API client.

## Type-Level Tests

`bun run types:check` compiles type-level usage tests in `tsconfig.type-tests.json`. These catch public API type regressions without running the code — e.g. verifying that factory function return types are assignable to their documented interfaces.

## Why Each Gate Exists

- **mirror-drift** — `packages/transport-http/src/` is mirrored into `packages/sdk/src/_internal/transport-http/`. Without this gate, a source edit in the canonical package silently diverges from the inlined copy.
- **throw-guard** — All consumer-reachable errors must be `GoodVibesSdkError` instances with a typed `kind` discriminant. Raw `throw new Error` bypasses the error contract.
- **rn-bundle** — Static bundle scan. Companion surface (React Native, Expo, browser, web, workers) must be safe for Metro, Vite, webpack, and esbuild. Any `Bun.*` identifier or `node:*` import breaks mobile and browser bundlers. (Runtime verification of `./web` under workerd lives in the separate `workers` and `workers-wrangler` lanes above.)
- **bundle:check** — Prevents accidental bundle size growth when run locally or
  reintroduced as a CI gate. Each entry has a ceiling; the 20% headroom prevents
  transient-spike failures.
- **types-check** — TypeScript type inference is non-trivial for discriminated union returns. Type tests validate at compile time without runtime overhead.
