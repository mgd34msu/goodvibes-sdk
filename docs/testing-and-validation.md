# Testing and validation

> Consumer and contributor guidance. For the internal testing source map see [Testing Architecture](./testing.md).

## What runs where

| When | What | Command |
|------|------|---------|
| While you work | the test files your change affects, and a typecheck | `bun run test:changed`, `bun test <file>`, `bun run typecheck` |
| `git commit` | credential-scope check on staged `packages/*/src` TypeScript (~0.7 s) | `.githooks/pre-commit` |
| Every push to `main` (`ci.yml`) | build, typecheck, the full test run, gitleaks, the packaged-daemon smoke | CI |
| Nightly, on demand, and before an armed release (`release-gates.yml`) | packaging, install smoke, attw, publint, artifact lane, `bun audit`, eval gate, React Native / Workers / Wrangler legs, wake-race sweep, `bun run validate` | CI |
| Version bump | regenerate every generated file | `bun run release:prepare` |

Local work never needs the whole suite. CI runs it on every push.

## Test layers

- **Unit** (`test/*.test.ts`). One module or a small group of modules, called
  directly with real inputs. Fakes stand in only for what is outside the unit
  (a provider, a clock, the network). The bulk of the suite.
- **Integration** (`test/integration/`, and the root files named `*-daemon-wire`,
  `*-http-wire`, `*-integration`). A real composition: `bootDaemon` or
  `createRuntimeServices`, real HTTP on an ephemeral port, real git in a temp
  repository. `test/integration/wrfc-chain-real-engine.test.ts` is the model: a
  whole WRFC chain through the real AgentManager, orchestration engine, fix
  workstream runner and git worktrees, with only the model scripted.
- **End to end** (`bun run smoke:daemon`, `scripts/packed-daemon-smoke.ts`).
  Packs every public package exactly as publish would, installs the tarballs
  into a scratch project, composes a daemon from them with `bootDaemon`, points a
  custom OpenAI-compatible provider at a scripted endpoint, and runs one
  companion-chat turn over HTTP. It fails when the packed daemon cannot boot,
  cannot reach its provider, or cannot bring the reply back into the session.
  `bun run smoke:daemon --workspace` runs the same turn against the workspace
  `dist` without packing. The artifact lane (`bun run release:artifact-lane`)
  is its conformance counterpart over the same packed bytes.
- **Live**. Nothing in the suite calls a real external service; provider keys
  in tests are stubs. Tests that need an optional host binary (the PTY cases in
  `test/exec-interactive.test.ts` need `script(1)`) check for it at the top of
  the test, log why they returned early, and run for real where it exists. Real
  provider and service behavior is verified by hand against a running daemon.

A test earns its place by failing when behavior breaks. Tests that read source
or docs as text, pin wording or object shapes nothing parses, assert a mock's
own return value, or only check that something is defined do not; they were
removed in the 2.1 overhaul and should not come back.

## Local commands

```bash
bun run test:changed            # files affected by changes since origin/main
bun test test/foo.test.ts       # one file
bun run typecheck               # the solution (packages, test/, scripts/) + type tests
bun run smoke:daemon            # the packed-daemon end-to-end smoke (~30 s)
```

`test:changed` is `bun scripts/test.ts --changed=origin/main`: Bun's own
`--changed` selection (files whose import graph touches a file changed since
`origin/main`, committed or not), over the same file set and temp-dir
containment as the full run. Pass a different base with
`bun scripts/test.ts --changed=<ref>`.

`bun run test` runs everything, after a typecheck (`pretest`). It is what the
CI `test` job runs; you rarely need it locally.

## Run the repo's declared script, never a guessed runner

Invoke a repository's own `package.json` script, never a runner inferred from
the file layout. On the webui, `bunx vitest run` fails every file at import and
bare `bun test` skips the `--isolate` flag the suite needs; only `bun run test`
reports the suite's real state. The same applies to `typecheck` and `build`:
the declared script encodes decisions a hand-built command silently drops.

`bun run build` and the package test scripts share the workspace lock, so a
test never reads `packages/*/dist` while a build is rewriting it. Prefer the
package scripts over bare `bun test` when `dist` imports are involved.

## Per-push CI (`ci.yml`)

| Job | Command | Purpose |
|------|---------|---------|
| `build` | `bun run build` | Builds every package's `dist/` once and uploads it as `workspace-build-output`; the release publishes these bytes |
| `typecheck` | `bun run typecheck` | `tsc -b --force` over the solution (packages, `test/`, `scripts/`) and `tsc -p tsconfig.type-tests.json`, each judged by its output as well as its exit code |
| `test` | `bun scripts/test.ts` | One run of `test/*.test.ts`, `test/integration`, `test/toolchain` against the restored build |
| `secret-scan` | gitleaks | Full-history secret scan |
| `daemon-smoke` | `bun run smoke:daemon` | One scripted turn through a daemon composed from the packed tarballs |
| `release-gates` | `release-gates.yml` | Only on a push with `RELEASE_ARMED=true` |
| `auto-release` | tag + dispatch | Only on an armed push, after every job above including the release gates |

## Release gates (`release-gates.yml`)

| Job | Command |
|-----|---------|
| `validate` | `bun run validate` (build, credential scope, exports reachability, examples typecheck, browser compatibility of companion entry points, package metadata) and `bun run flags:graduation` |
| `packaging (pack)` | `bun run pack:check` |
| `packaging (install-smoke)` | `bun run install:smoke` |
| `packaging (attw)` | `bun run types:resolution-check` |
| `packaging (publint)` | `bun run publint:check` |
| `packaging (artifact-lane)` | `bun run release:artifact-lane` |
| `runtimes (rn-bundle)` | `bun run test:rn`: no `Bun.*` or `node:*` in companion bundles |
| `runtimes (workers)` | `bun run test:workers`: the `./web` entry under Miniflare 4 |
| `runtimes (workers-wrangler)` | `bun run test:workers:wrangler`: the same under `wrangler dev --local` |
| `runtimes (wake-race-sweep)` | `bun run sweep:wake-race`: the fake-IMAP suites with one wire call delayed |
| `eval-gate` | `bun run eval:gate`: absolute floors and regression against `eval/baseline.json` |
| `dependency-audit` | `bun run security:audit` |

They run nightly (07:00 UTC), on demand from the Actions tab, and from `ci.yml`
on an armed push, where `auto-release` needs them, so no version is tagged
without them passing on that commit. `bun run release:verify` runs the same set
locally when you need it.

## Generated files: `bun run release:prepare`

Generated and version-stamped files are not checked on every push. They are
rewritten at the version bump:

```bash
bun run release:prepare --minor         # or --patch, --major, --version X.Y.Z
bun run release:prepare --no-bump       # regenerate at the current version
```

In order: every workspace `package.json` version and
`packages/sdk/src/platform/version.ts`; a `## [X.Y.Z]` CHANGELOG section
scaffold when none exists; the build; contract artifacts, foundation-io
entries, OpenAPI, webui facade and Home Assistant client
(`refresh:contracts`); API reference docs; api-extractor reports and the
subpath API surface; bundle budgets (`bundle-budget.ts --update`, re-anchoring
only entries that grew past their ceiling); the eval baseline. It ends by
checking version consistency and the changelog section. It never commits or
tags. The toolchain `release-cut` runs it as its sync command
(`toolchain.config.json`). Each `--check` variant (`docs:check`,
`contracts:check`, `api:check`, `bundle:check`, `eval:baseline:check`, ...)
remains available locally.

## Bundle budgets

`bundle-budgets.json` holds a gzip ceiling per export,
`max(ceil(measured * 1.2), measured + 50)`. `bun run bundle:check` prints the
table; `bun scripts/bundle-budget.ts --update` rewrites the entries that grew
past their ceiling (release:prepare runs it). See
[`bundle-budgets.README.md`](../bundle-budgets.README.md).

## Workers runtime verification

The `./browser` companion entry (`./web` is an alias) is verified three ways in
the release gates: the `rn-bundle` scan of the built `web.js` and `workers.js`,
Miniflare 4 (`workers`), and `wrangler dev --local` (`workers-wrangler`, which
shares Miniflare's runtime; see `test/workers/NOTES.md`). The `./workers`
bridge is covered by `test/cloudflare-worker-batch.test.ts`, and Cloudflare
provisioning by `test/cloudflare-control-plane.test.ts` against a fake API.

## Type-level tests

`tsconfig.type-tests.json` compiles consumer-vantage type tests through the
package names, catching declaration-emit gaps and public type regressions
without running code. `bun run typecheck` includes it; `bun run types:check`
runs it alone.

## Zod opt-in validation

The HTTP transport supports opt-in Zod v4 response validation per call:

```ts
import { z } from 'zod/v4';

const result = await sdk.operator.invoke('namespace.method', input, {
  responseSchema: z.object({ id: z.string() }),
});
```

A mismatch throws a `ContractError` (`kind: 'contract'`).
