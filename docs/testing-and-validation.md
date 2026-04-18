# Testing and Validation

The SDK repo validates more than TypeScript build success. `bun run validate` is the portable command CI runs; it does not require any external repo checkout.

## CI Gates

Every push and PR to `main` must pass these gates:

| Gate | Command | Purpose |
|------|---------|---------|
| `validate` | `bun run validate` | Full workspace validation: API docs sync, docs/examples completeness, TypeScript build, type-level checks, tests, pack, install smoke |
| `mirror-drift` | `bun run sync:check` | Ensures `_internal` transport-http mirror is byte-for-byte in sync with its canonical source |
| `platform-matrix (bun)` | `bun run build && bun test test` | Runs full test suite on Bun |
| `platform-matrix (rn-bundle)` | `bun test test/rn-bundle-node-imports.test.ts` | Verifies companion dist bundles contain no `Bun.*` identifiers and no `node:*` imports |
| `throw-guard` | inline `rg` scan | Prevents raw `throw new Error(` / `throw Error(` in public SDK source |
| `changelog-check` | `bun run changelog:check` | Blocks releases when `CHANGELOG.md` is missing a `## [X.Y.Z]` section for the current version |
| `version-consistency` | `bun run version:check` | Ensures all workspace `package.json` files carry the same version |
| `types-check` | `bun run types:check` | Compiles type-level usage tests against the public API surface to catch type regressions |
| `bundle-budgets` | `bun run bundle:check` | Enforces per-entry gzip size budgets from `bundle-budgets.json`; a budget failure means an entry point grew beyond its 20% headroom allowance |
| `sbom-check` | `bun run sbom:generate` + CI-inline size + schema assertions | Generates the CycloneDX SBOM (`sbom.cdx.json`) and asserts non-empty + valid schema (no standalone `sbom:check` script — validation is inlined in `.github/workflows/ci.yml`) |
| `platform-matrix (workers)` | `bun run test:workers` | Runs the `./web` entry under Miniflare 4 (workerd V8 isolate, in-process) — 9 tests validate Worker-runtime compatibility (no `node:*`, no `Bun.*`, no client `EventSource`/`WebSocket` dependence) |
| `platform-matrix (workers-wrangler)` | `bun run test:workers:wrangler` | Runs the `./web` entry under `wrangler dev --local` — exercises wrangler's esbuild bundling pipeline and wrangler.toml config. NOTE: wrangler dev --local shares the Miniflare 4 runtime, so this is **not** a production-workerd verification (see `test/workers/FINDINGS.md`) |
| `zero-any` | `bun run any:check` | Scans `packages/`, `test/`, `scripts/` for TypeScript `any` types in real type positions. Zero tolerance — fails the build on any occurrence outside vendored third-party code (`packages/*/vendor/`). See `scripts/no-any-types.ts` |
| `attw` (are-the-types-wrong) | `bunx @arethetypeswrong/cli --pack` | Validates the `exports` map resolves cleanly under `node16` and `bundler` conditions for every published subpath |
| `publint` | `bunx publint` | Detects common `package.json` packaging hygiene issues before release |

## Portable Validation

```bash
bun run validate
```

Covers: API docs sync, docs/examples completeness, TypeScript build, type-level checks, tests, pack, install smoke.

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

`bundle-budgets.json` at the repo root defines per-entry gzip size ceilings with 20% growth headroom over the last measured size. The `bun run bundle:check` command is what the CI `bundle-budgets` job runs.

To see current actual sizes:

```bash
bun run bundle:check
```

To update budgets after a legitimate size change:
1. Run `bun run bundle:check` to get the new actual sizes.
2. Set `gzip_bytes` to `ceil(actual * 1.2)` for each changed entry in `bundle-budgets.json`.
3. Update the measurement date in the file's `_comment` block.

## Workers Runtime Verification

The `./web` companion entry point (`createWebGoodVibesSdk`) is Workers-compatible (Cloudflare Workers / Miniflare 4 / `workerd`). CI verifies this three ways: (1) `rn-bundle` statically scans the built `web.js` for forbidden identifiers (`node:*`, `Bun.*`); (2) `platform-matrix (workers)` boots `./web` under Miniflare 4's programmatic workerd isolate and runs 9 real-runtime tests; (3) `platform-matrix (workers-wrangler)` boots `./web` via `wrangler dev --local` to exercise wrangler's esbuild pipeline and `wrangler.toml` (note: wrangler dev --local uses Miniflare 4 internally, so both runtime lanes share the same isolate — see `test/workers/FINDINGS.md` for the production-workerd gap).

## Type-Level Tests

`bun run types:check` compiles type-level usage tests in `tsconfig.type-tests.json`. These catch public API type regressions without running the code — e.g. verifying that factory function return types are assignable to their documented interfaces.

## Why Each Gate Exists

- **mirror-drift** — `packages/transport-http/src/` is mirrored into `packages/sdk/src/_internal/transport-http/`. Without this gate, a source edit in the canonical package silently diverges from the inlined copy.
- **throw-guard** — All consumer-reachable errors must be `GoodVibesSdkError` instances with a typed `kind` discriminant. Raw `throw new Error` bypasses the error contract.
- **rn-bundle** — Static bundle scan. Companion surface (React Native, Expo, browser, web) must be safe for Metro, Vite, webpack, and esbuild. Any `Bun.*` identifier or `node:*` import breaks mobile and browser bundlers. (Runtime verification of `./web` under workerd lives in the separate `workers` and `workers-wrangler` lanes above.)
- **bundle-budgets** — Prevents accidental bundle size growth. Each entry has a ceiling; the 20% headroom prevents transient-spike failures.
- **types-check** — TypeScript type inference is non-trivial for discriminated union returns. Type tests validate at compile time without runtime overhead.
