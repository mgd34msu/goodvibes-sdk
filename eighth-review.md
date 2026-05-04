# Eighth Review — Comprehensive Codebase Audit

**HEAD:** `c597590`
**Methodology:** 6 parallel reviewers, swim-lane scoped (sdk-core, packages, tests, docs+examples, build+CI+config, public surface).
**Organization:** Severity → Area. Same-file findings within an area cluster naturally. Reviewers should `grep` by file path to find all findings on a single file.

## Summary

**Total findings: 257** (20 CRITICAL, 56 MAJOR, 106 MINOR, 59 NITPICK, 16 coverage gaps)

| Area | CRIT | MAJ | MIN | NIT | COV | Total |
|---|---|---|---|---|---|---|
| sdk-core      | 2 | 10 | 30 | 15 |  — | 57 |
| packages      | 1 |  6 |  9 |  6 |  — | 22 |
| tests         | 5 | 11 | 18 | 10 | 16 | 60 |
| docs+examples | 8 | 12 | 20 | 13 |  — | 53 |
| build+CI      | 3 |  9 | 20 | 11 |  — | 43 |
| public surface| 1 |  8 |  9 |  4 |  — | 22 |
| **TOTAL**     |**20**|**56**|**106**|**59**|**16**|**257**|

---

# CRITICAL

## CRITICAL — sdk-core


### C1 — `browser.ts:74` & `react-native.ts:81` — `realtime` option spread clobbers carefully merged reconnect defaults
**File:** `packages/sdk/src/browser.ts:54-75`
**File:** `packages/sdk/src/react-native.ts:74-82`
**Severity:** Critical (Correctness / Bug)

Both platform factories build a `realtime` block that injects browser-/RN-appropriate `sseReconnect` and `webSocketReconnect` defaults, then spread `...(options.realtime ?? {})` *after*. Because object spread is last-wins, when a caller passes `options.realtime = { onError: fn }` (no reconnect overrides), their bare object **deletes** the platform defaults' inner `sseReconnect` / `webSocketReconnect` properties — they evaporate to `undefined`, and downstream `createEventSourceConnector` / `createWebSocketConnector` call sites in `client.ts:456-457,473-474` see no reconnect policy.

The internal merge at `sseReconnect: { ...(options.realtime?.sseReconnect ?? {}) }` was clearly *intended* to be the only source of `options.realtime.sseReconnect`, with the trailing spread only carrying `onError`. Either omit the trailing spread, pull out only `onError`, or invert the order.

**Fix sketch:**
```ts
realtime: {
  ...(options.realtime ?? {}),
  sseReconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5_000,
                  ...(options.realtime?.sseReconnect ?? {}) },
  webSocketReconnect: { ... },
},
```

### C2 — `tools/repl/index.ts:92` — `eval()` of caller-supplied expression inside spawned process
**File:** `packages/sdk/src/platform/tools/repl/index.ts:80-92`
**Severity:** Critical-equivalent (Sandbox boundary correctness)

The REPL tool serialises caller-supplied bindings + expression into a `runner` script and invokes it via `process.execPath -e runner` (i.e. another Node process). Inside the runner the expression flows through `eval(payload.expression)`. The mitigation is `requireReplSandbox` at line 47, which throws unless `launchPlan.backend === 'qemu'`. **However**, `evalJavaScriptInSandbox` is also reachable via `sandboxSessionRegistry.execute(...)` (line 92) — a session path that depends on the registry's own enforcement. If a future refactor (or an alternative backend such as a forthcoming `'firejail'` value) ever bypasses the QEMU check, this becomes a remote-code-execution sink with caller-supplied bindings injected directly into `globalThis`. Two follow-ups:
  1. Tighten the guard in `requireReplSandbox` to a positive allowlist *also* enforced inside `evalJavaScriptInSandbox` (defence-in-depth).
  2. Add an assertion that the session referenced by `sessionId` is itself QEMU-backed before the registry path is used.

---


## CRITICAL — packages


### CRIT-1 — HTTP retry backoff is off-by-one (always over-delays first retry by one factor)

**File:** `packages/transport-http/src/http-core.ts:519`

```ts
await sleepWithSignal(getHttpRetryDelay(attempt + 1, resolvedRetry), requestOptions.signal);
```

`attempt` is incremented at the top of the loop (`attempt += 1` on line 378) so it is already 1-based at the point of the catch. `getHttpRetryDelay` documents that attempt `1` is the first retry (uses `baseDelayMs`) and attempt `2` applies one backoff factor (see `backoff.ts:30-32`). Calling with `attempt + 1` after the first failure waits `baseDelayMs * factor` instead of `baseDelayMs` — every retry sleeps one factor too long.

With default policy (`baseDelayMs=250`, `factor=2`, `maxDelayMs=2_000`) the first retry sleeps 500 ms instead of 250, the next 1000 instead of 500, and so on, doubling the user-visible latency on flaky calls. This is a true bug rather than a config nit because `DEFAULT_HTTP_RETRY_POLICY.maxAttempts = 1` (no retry) hides it on the default path; once a caller sets `maxAttempts > 1` the off-by-one becomes load-bearing.

Fix: use `getHttpRetryDelay(attempt, resolvedRetry)`.

---


## CRITICAL — tests


### CRIT-01 — `test/_helpers/dist-mtime-check.ts` is dead: NO test imports it
**File:** `test/_helpers/dist-mtime-check.ts:1-58`

The sentinel was added per its own docstring ("M1 (seventh-review): dist/ staleness sentinel… Import this helper in any test that loads packages from dist/"). A grep for `dist-mtime-check` across the entire repo returns ONE file: itself. No test imports it.

Meanwhile `scripts/check-dist-freshness.ts` exists and `bun run dist:check` is wired in `package.json:75`, but it is NOT in the `pretest` chain (`package.json:43` only runs `bun run build`). Tests that import from `packages/*/dist/` (e.g. `test/helpers/dist-errors.ts:11-16`, `test/workers/workers.test.ts`, `test/workers-wrangler/worker.ts`) silently load stale bundles whenever `bun run build` is skipped or partial.

**Fix:** Either delete the orphan helper, or import it from at least one dist-loading test (`test/helpers/dist-errors.ts` is the obvious place, or a top-level `test/_helpers/setup.ts` shared by every dist-touching test).

### CRIT-02 — `COVERAGE.md` is stale by ~78 entries (lists 90, repo has ~168 root tests)
**File:** `COVERAGE.md:1-141`

COVERAGE.md stops at `T90 = test/platform-adapter-contract.test.ts` and a footer (`COVERAGE.md:102`) acknowledges "This list covers the first 90 root-level test files". Actual count of `test/*.test.ts` (root only) is ~168 (`precision_glob` confirms 212 total `.ts` test files; subtracting integration/workers/_helpers/_internal yields ~168 root tests).

Between T89 (`obs-09`) and T90 (`platform-adapter-contract`), the alphabetical order skips obs-11..22, observer-coverage, observer-otel, openai-compatible-routes, operator-* (5 files), orchestrator-abort, otlp-* (2 files), peer-sdk*, perf-* (5 files). The whole `sec-*`, `wrfc-*`, `transport-*`, `router-e2e-*`, `homegraph-*` groups (and many more) are entirely absent.

**Why it matters:** The file is presented as a navigation aid for review tooling. Stale → reviewers will wrongly assume a feature has no test, and orchestrators that pin coverage by ID will silently over- or under-cover.

**Fix:** Regenerate from `scripts/test.ts`'s file list, or delete the static table and replace with a `bun scripts/print-test-coverage.ts` helper.

### CRIT-03 — `T90` row entry encodes a misleading per-file test count
**File:** `COVERAGE.md:100`

`| T90 | \`test/platform-adapter-contract.test.ts\` — 31 tests |`

This is the only row with a count appended; every other row omits it. The `31` is not verifiable from any script (no per-file counter exists). It will rot the moment the file changes. Either every row should be auto-generated with a count, or none. Inline magic numbers in nav tables are a maintenance trap.

### CRIT-04 — Title/assertion mismatch in wrangler harness (`server` vs `service`)
**File:** `test/workers-wrangler/wrangler.test.ts:220`

```ts
test('error path — mock returns 5xx, errorKind is typed \'server\'', async () => {
  …
  expect(b.kind).toBe('service');   // line 229 — actually 'service'
```

The test name says `'server'` but the assertion checks `'service'`. The Miniflare twin (`test/workers/workers.test.ts:172`) correctly says `'service'`. If `kind` ever becomes `'server'` (matching the test title), this test will silently pass under the wrong taxonomy because the failure message would point reviewers at a contradictory expectation. Fix the test name string.

### CRIT-05 — `provider-routes-secrets-skipped.test.ts` casts admin-path stubs to `as never`
**File:** `test/provider-routes-secrets-skipped.test.ts:137-189`

The router-level test stubs ~30 `DaemonHttpRouterContext` fields with `{} as never`, including `userAuth`, `agentManager`, `automationManager`, `approvalBroker`, `controlPlaneGateway`, `gatewayMethods`, `sessionBroker`, `routeBindings`, `surfaceRegistry`, `distributedRuntime`, `voiceService`, `webSearchService`, `knowledgeService`, `mediaProviders`, `multimodalService`, `artifactStore`, `memoryRegistry`, `platformServiceManager`.

Two problems:
1. `as never` defeats the type system — if the production code path under `/api/providers` is later refactored to call any of these stubbed services, the test will still typecheck. The bug will only surface as a `TypeError: Cannot read properties of undefined` at runtime.
2. Functions like `buildSurfaceAdapterContext`, `requireRemotePeer`, `invokeGatewayMethodCall`, `trySpawnAgent` `throw new Error('not expected')` — but the dispatcher will only call them if it ever takes the wrong branch, and the resulting throw becomes a 500 inside a try/catch that may be swallowed.

**Fix:** Use a precise mock shape derived from the type, with `vi.fn()`-style spies that fail loudly. Or extract a smaller `ProviderRouteContext`-only path that doesn't need a full `DaemonHttpRouterContext`.

---


## CRITICAL — docs+examples


### CRIT-001 — `retries-and-reconnect.md:84` imports `generateIdempotencyKey` from `transport-http`; not exported there

- File: `docs/retries-and-reconnect.md:83-89`
- Evidence: The only `generateIdempotencyKey` definition is `packages/sdk/src/platform/runtime/remote/reconnect.ts:381`, re-exported from `packages/sdk/src/platform/runtime/remote/index.ts:123`. `packages/transport-http/src/**` defines no such symbol; neither does the SDK facade `packages/sdk/src/transport-http.ts`.
- Consequence: `import { generateIdempotencyKey } from '@pellux/goodvibes-sdk/transport-http'` throws `SyntaxError`/`undefined` at module load (TS error first, runtime undefined second).
- Additional defect: the source signature is `generateIdempotencyKey(sessionId: string): string` — the doc calls it with no argument. Even at the right path it would not type-check.
- Additional defect: `platform/runtime/remote` is itself **not** in the public exports map. The only public path to this helper is via `platform/runtime` (the aggregate). The doc should name a real public surface or stop documenting the helper at all.
- Fix: either remove the snippet, expose `generateIdempotencyKey` from a public path, or change the import to `@pellux/goodvibes-sdk/platform/runtime` if it’s actually re-exported there (verify before writing).

### CRIT-002 — `authentication.md:143` claims `AutoRefreshCoordinator` is exported from `@pellux/goodvibes-sdk/auth`; it is not

- File: `docs/authentication.md:143-144`
- Evidence: `packages/sdk/src/auth.ts` exports only `PermissionResolver`, `SessionManager`, `TokenStore`, `OAuthStartState`, `OAuthTokenPayload`, `BrowserTokenStoreOptions`, `GoodVibesAuthClient`, `AutoRefreshOptions`, `createMemoryTokenStore`, `createBrowserTokenStore`, `createGoodVibesAuthClient` (lines 27–84, 109, 151, 240). `AutoRefreshCoordinator` is imported from `./client-auth/auto-refresh.js` for internal use only. It is exported from `./client-auth/index.ts:4`, reachable via `@pellux/goodvibes-sdk/client-auth` (which IS in the package.json exports map but is undocumented elsewhere).
- Consequence: Any caller copying the doc text into `import { AutoRefreshCoordinator } from '@pellux/goodvibes-sdk/auth';` fails with TS2305.
- Fix: change the path to `@pellux/goodvibes-sdk/client-auth` and add that subpath to `public-surface.md`, **or** add `export { AutoRefreshCoordinator } from './client-auth/index.js';` to `auth.ts`.

### CRIT-003 — `authentication.md:120-141` autoRefresh option shape disagrees with surrounding prose

- File: `docs/authentication.md:120-141`
- Evidence: source defines `GoodVibesSdkOptions.autoRefresh?: AutoRefreshOptions` (`packages/sdk/src/client.ts:200`) and `AutoRefreshOptions { autoRefresh?: boolean; refreshLeewayMs?: number; refresh?: ...}` (`packages/sdk/src/client-auth/auto-refresh.ts:34`). The doc’s code block uses `autoRefresh: { autoRefresh: true, ...}` — that is correct. But the prose immediately below says: "Set `autoRefresh: false` to disable it entirely." That is wrong. `autoRefresh: false` is a `boolean`, which is not assignable to `AutoRefreshOptions | undefined`; the actual disable is `autoRefresh: { autoRefresh: false }`.
- Consequence: Users writing `createGoodVibesSdk({ autoRefresh: false })` get a TS error and, even if they `as any`-coerce it, the runtime check `(options.autoRefresh?.autoRefresh ?? true)` (`client.ts:379`) reads `false.autoRefresh` → `undefined` → `?? true` → enabled. Doc claim is functionally false.
- Fix: rewrite the disable instruction to `autoRefresh: { autoRefresh: false }`, or reshape the option to accept `boolean | AutoRefreshOptions`.

### CRIT-004 — `examples/daemon-fetch-handler-quickstart.ts:34` returns a fake operator contract that does not satisfy the type

- File: `examples/daemon-fetch-handler-quickstart.ts:34`
- Evidence: `getOperatorContract: () => ({ version: 1 })` is followed by an aside saying real contracts come from `buildOperatorContract()`. The actual `OperatorContract` shape (see `packages/contracts/src/generated/operator-contract.ts`) is a deep object with `operator.methods`, `operator.endpoints`, etc. Returning `{ version: 1 }` cannot satisfy the parameter type used by `createDaemonControlRouteHandlers`.
- Consequence: this is the example referenced by `CONTRIBUTING.md` `examples-typecheck` gate — it should not pass `bun --cwd examples run typecheck` unless the type is being silently widened. Inspect: either the example is type-cheating (`as any` somewhere upstream) or `getOperatorContract` is typed loosely. Either way, the example demonstrates a value that will fail at runtime when `dispatchControlMethods` reads `operator.methods`.
- Fix: either import `buildOperatorContract` and call it, or mark the example clearly with `as unknown as OperatorContract` and a `// FIXME: replace with buildOperatorContract()`.

### CRIT-005 — `public-surface.md:175-208` advertises wildcard subpath prefixes that are NOT in the exports map

- File: `docs/public-surface.md:175-208`
- Evidence: the table lists prefixes that imply consumers may import any path under them: `platform/acp/*`, `platform/adapters/*`, `platform/artifacts/*`, `platform/automation/*`, `platform/batch/*`, `platform/channels/*`, `platform/cloudflare/*`, `platform/companion/*`, `platform/control-plane/*`, `platform/discovery/*`, `platform/hooks/*`, `platform/mcp/*`, `platform/media/*`, `platform/security/*`, `platform/state/*`, `platform/watchers/*`, `platform/web-search/*`. `packages/sdk/package.json:50-229` exposes none of these. The only platform subpaths in the exports map are: `platform`, `platform/config`, `platform/core`, `platform/daemon`, `platform/git`, `platform/integrations`, `platform/intelligence`, `platform/knowledge`, `platform/knowledge/extensions`, `platform/knowledge/home-graph`, `platform/multimodal`, `platform/node`, `platform/node/runtime-boundary`, `platform/pairing`, `platform/providers`, `platform/runtime`, `platform/runtime/observability`, `platform/runtime/state`, `platform/runtime/store`, `platform/runtime/ui`, `platform/tools`, `platform/utils`, `platform/voice`.
- Consequence: every wildcard the table advertises will throw `ERR_PACKAGE_PATH_NOT_EXPORTED` at module resolution. The page directly contradicts itself: line 165 says "there is no wildcard" and lines 175–208 then list 17 wildcards.
- Fix: replace the wildcard table with the explicit exact subpaths listed in `packages/sdk/package.json`. Drop the prefixes that have no matching public subpath.

### CRIT-006 — `public-surface.md` omits exported subpaths that are real

- File: `docs/public-surface.md` (no entries)
- Evidence: missing from the page despite being public per `package.json`: `./client-auth`, `./observer`, `./platform/config`, `./platform/git`, `./platform/integrations`, `./platform/intelligence`, `./platform/knowledge/extensions`, `./platform/multimodal`, `./platform/node/runtime-boundary`, `./platform/pairing`, `./platform/runtime/observability`, `./platform/runtime/state`, `./platform/runtime/store`, `./platform/runtime/ui`, `./platform/utils`, `./platform/voice`, `./platform/providers`, `./platform/tools`, `./platform/daemon`. Combined with CRIT-005, the page is the wrong half of the actual contract.
- Fix: regenerate `public-surface.md` from `package.json` exports — make this the source-of-truth doc instead of a hand-curated table.

### CRIT-007 — `examples/companion-approvals-feed.ts` claim mismatch with `README.md` policy

- File: `examples/companion-approvals-feed.ts:4-7`, `README.md:94-100`
- Evidence: README documents browser usage with `createWebGoodVibesSdk` from `/web` (line 94). The example uses `createBrowserGoodVibesSdk` from `/browser`. Both factories exist (`packages/sdk/src/web.ts:14`, `packages/sdk/src/browser.ts:48`) and the package exports both subpaths, so the example compiles. But the user-visible inconsistency: README and `web-ui-integration.md` push `/web`; examples push `/browser`. `getting-started.md:216` says they are "both companion-safe" — but does not declare a recommended one.
- Consequence: docs are internally inconsistent on which factory to use for browser companion code.
- Fix: pick one. If both are equivalent, say so once and use the recommended one consistently across README, examples, and `companion-approvals-feed.ts`.

### CRIT-008 — `secrets.md:6` references a private SDK source path as the canonical source

- File: `docs/secrets.md:6`
- Evidence: `Source: packages/sdk/src/platform/config/secret-refs.ts.` Embedding a source path in docs makes it the de-facto contract; but the only public seam for config is `@pellux/goodvibes-sdk/platform/config`. `secret-refs.ts` exists, but consumers should not be invited to import from a file path. Same pattern repeats in `auth.md:8`, `runtime-orchestration.md:9-15`, `channel-surfaces.md:9-12`. These read like internal docs being shipped as consumer docs.
- Fix: replace file-path callouts with public-subpath callouts, or move these notes into an `_internal/` doc tree the publish step omits.

---


## CRITICAL — build+CI+config


### CRIT-001 — Action SHA pins lack version annotations across BOTH workflow files
**Files:**
- `.github/workflows/ci.yml:21,33,49,68,74,90,130,132,146,166,170,184,186,192,206,210,224,233,247,251,265,267,273,297`
- `.github/workflows/release.yml:29,46,62,75,91,108,123,158,173,208,212`
- `.github/actions/setup/action.yml:9,13`

**Severity:** Critical (Security / Supply chain)

Most SHA pins have NO trailing `# vX.Y.Z` annotation. Examples:
```yaml
# ci.yml:21,33,49,68,90,130,146,166,184,206,224,247,265
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd   # ← no "# v4.2.2"
# ci.yml:74,297
uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a   # ← no "# vX.Y.Z"
# ci.yml:170,192,210,233,251,273
uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c   # ← no "# vX.Y.Z"
# action.yml:13
uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830   # ← no "# vX.Y.Z"
# action.yml:9
uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6   # ← no "# v2.2.0"
```

The annotated SHAs (`# v6.4.0` for setup-node, `# v2.2.0` for setup-bun in release.yml only, `# v2.3.9` for gitleaks, `# v3.0.0` for gh-release) **were verified against the GitHub API and match correctly**. The remaining un-annotated pins are unverifiable to a human reviewer or to dependabot — the entire point of the `# vX.Y.Z` convention is to enable visual auditing and tooling-driven version updates.

**Verification against GitHub API (`https://api.github.com/repos/<action>/git/refs/tags/<v>`):**

| SHA in repo | Resolved tag (probed) | Notes |
|---|---|---|
| `actions/checkout@de0fac2e…` | NOT v4.2.2 (`11bd71901bbe…`); NOT v5.0.0 (`08c6903cd8c0…`) | Untagged or unreleased commit. **Treat as unverified.** |
| `actions/upload-artifact@043fb46d…` | NOT v4.6.2 (`ea165f8d65b6…`); NOT v5.0.0 (`330a01c490ac…`) | Unverified. |
| `actions/download-artifact@3e5f45b2…` | NOT v4.3.0 (`d3f86a106a0b…`); NOT v5.0.0 (`634f93cb2916…`) | Unverified. |
| `actions/cache@0057852b…` | NOT v4.2.4 (`0400d5f644dc…`); NOT v4.0/4.1/4.2 series probed. | Unverified. |
| `actions/setup-node@48b55a01…` | v6.4.0 ✓ | Annotated and matches. |
| `oven-sh/setup-bun@0c5077e5…` | v2.2.0 ✓ | Annotated. |
| `gitleaks/gitleaks-action@ff98106e…` | v2.3.9 ✓ | Annotated. |
| `softprops/action-gh-release@b4309332…` | v3.0.0 ✓ | Annotated. |

**Risk:** The four unverified pins (`actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `actions/cache`) cannot be confirmed to point at a known release. They may be intermediate commits or dependabot-applied patches; without `# vX.Y.Z` markers they bypass the standard supply-chain review surface. If any of these are commits that were later force-pushed or rewound, no audit path exists.

**Fix:** Add the matching `# vX.Y.Z` annotation to every action pin, AND verify the SHA resolves to the claimed tag. Example after fix:
```yaml
uses: actions/checkout@<correct_sha>   # v4.2.2
uses: actions/upload-artifact@<correct_sha>   # v4.6.2
uses: actions/download-artifact@<correct_sha>   # v4.3.0
uses: actions/cache@<correct_sha>   # v4.2.4
uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6   # v2.2.0
```
Also reconcile against the desired upstream tag — if these SHAs intentionally pre-date a tag, that fact must be documented.

---

### CRIT-002 — Release pipeline can publish to npm on raw `push: tags: v*` with no human gate
**File:** `.github/workflows/release.yml:14-16, 98-142`

The `publish-npm` job runs `release:publish:ci` (which executes `npm publish --provenance`) automatically when a tag matching `v*` is pushed (`if: github.event_name == 'push'`, line 133). There is no manual `environment:` gate, no required reviewer, and no `workflow_dispatch` confirmation step that requires a separate approver before publish.

The `concurrency.cancel-in-progress: false` (line 20) prevents concurrent publishes but does not gate the publish itself. A repository-write compromise (forced tag push, branch admin override) would result in an immediate npm publish using the stored `NPM_TOKEN`.

**Fix:** Add a GitHub `environment:` (e.g. `npm-publish-prod`) with required reviewers to the `publish-npm` job:
```yaml
publish-npm:
  environment:
    name: npm-publish-prod   # configured with required reviewers in repo settings
    url: https://www.npmjs.com/package/@pellux/goodvibes-sdk
```
This is the standard supply-chain control for npm provenance pipelines.

---

### CRIT-003 — `validate.ts` skips `release:verify:verdaccio`, `bundle:check`, and `dist:check` despite being the validate gate
**File:** `scripts/validate.ts:1-34`

`bun run validate` (the script run by CI's `validate` job and by every developer) does NOT invoke `bundle:check`, `verdaccio-dry-run`, `dist:check`, `flake:check`, `sbom:generate`, or `contracts:check`. CI runs these as separate jobs, but locally `bun run validate` produces a green light that does not match the CI green light. Developers can ship a release-blocking bundle-budget regression without warning.

Line 32 `pack:check` is run, but line 33 `install:smoke` is the last step — bundle-budget regressions are CI-only.

**Fix:** Add `bundle:check` and `contracts:check` to `validate.ts`:
```ts
run('bun', ['run', 'contracts:check']);
run('bun', ['run', 'bundle:check']);
```
…or document explicitly that `validate` is a subset and create a `validate:full` script that mirrors CI exactly. Currently `validate:strict` exists (package.json:56) but it only adds `types:check` + `contracts:check` — still missing bundle-budget.

---


## CRITICAL — public surface


### CRIT-01 — public-surface.md advertises 17 platform subpaths that don't exist in exports map
**File:** `docs/public-surface.md:179-208`
**Severity:** Critical (Documentation/Contract drift — release-breaking from consumer perspective)

The "Subsystems included in the platform surface" table at lines 179-208 lists 17 `platform/<subsystem>/*` subpaths as documented stable beta surfaces:

- `platform/acp/*` (line 179)
- `platform/adapters/*` (line 180)
- `platform/artifacts/*` (line 181)
- `platform/automation/*` (line 182)
- `platform/batch/*` (line 183)
- `platform/channels/*` (line 184)
- `platform/cloudflare/*` (line 185)
- `platform/companion/*` (line 186)
- `platform/control-plane/*` (line 188)
- `platform/discovery/*` (line 190)
- `platform/hooks/*` (line 192)
- `platform/mcp/*` (line 196)
- `platform/media/*` (line 197)
- `platform/security/*` (line 203)
- `platform/state/*` (line 204)
- `platform/watchers/*` (line 207)
- `platform/web-search/*` (line 208)

None of these have a corresponding `./platform/<name>` (or `/*` subpath) entry in `packages/sdk/package.json` exports map (lines 110-201). The doc directly contradicts itself at line 165 ("every public platform path is listed intentionally in package.json") and lines 214-216 ("sealed paths" — anything not in the export map will fail).

This is a release contract violation: a consumer who reads `public-surface.md`, sees `platform/security/*` listed as "stable beta," and writes `import {...} from '@pellux/goodvibes-sdk/platform/security'` will get a hard module resolution error.

**Fix path:** Either (a) add explicit `./platform/<subsystem>` entries (and source `index.ts` modules) for each subsystem the table lists; or (b) delete those rows from the table and replace with a clear list of subsystems that are *internally available via `./platform/node`* but not directly importable. Option (b) is faster and matches today's reality — `packages/sdk/src/platform/node/index.ts` already re-exports all of these as namespaces.

---


---

# MAJOR

## MAJOR — sdk-core


### MAJ-1 — `runtime/tools/phases/prehook.ts:60-66` — silently-swallowed hook infrastructure failure
**File:** `packages/sdk/src/platform/runtime/tools/phases/prehook.ts:60`
**Severity:** Major (Error handling / Observability)

```ts
} catch (_err) {
  // Hook infrastructure failure — allow execution to proceed
  return { phase: 'prehooked', success: true, ... };
}
```
The `_err` is dropped, no `logger.warn`/`logger.error`, no telemetry event. Failures in the hook chain become permanently invisible — hooks can be misconfigured for weeks before anyone notices. At minimum log via `summarizeError(err)` and emit a runtime event so it surfaces in diagnostics.

### MAJ-2 — `auth.ts:323,327` — uses outer `tokenStore` instead of the constructed `ts` wrapper
**File:** `packages/sdk/src/auth.ts:316-337`
**Severity:** Major (Inconsistency / Latent bug)

`createGoodVibesAuthClient` constructs `const ts: TokenStore | null = tokenStore ? new TokenStore(tokenStore) : null;` (line 256) — a wrapped instance that owns auto-refresh / observer behaviour — but `setToken` and `clearToken` (lines 322-327) reach past it and call `assertWritableTokenStore(tokenStore).setToken/clearToken` against the *raw* user-supplied store. Any side-effects baked into `TokenStore` (cache invalidation, event emission) are bypassed for these two paths. Use `ts.setToken(...)` / `ts.clearToken()` for consistency.

### MAJ-3 — `client.ts:455-481` — `onError` may fire twice per realtime error
**File:** `packages/sdk/src/client.ts:455-481`
**Severity:** Major (Behavioural — double-invocation)

The SSE/WebSocket connector receives `onError: options.realtime?.onError` *and* the wrapping `createRemoteRuntimeEvents(...)` receives an additional `onError: (error) => options.realtime?.onError?.(error)`. Depending on whether the connector itself rethrows or whether `createRemoteRuntimeEvents` adds its own catching layer (transport-realtime package), a single transport error may invoke the user's `onError` twice. Pass the callback in only one place, or document the contract explicitly in `GoodVibesRealtimeOptions`.

### MAJ-4 — `automation/manager-runtime.ts:112-740` — god class (628 lines, ~50 methods)
**File:** `packages/sdk/src/platform/automation/manager-runtime.ts:112-740`
**Severity:** Major (Maintainability / SOLID-SRP)

`AutomationManager` owns: persistence (`load`, `saveJobs`, `saveRuns`, `pruneRunHistory`), scheduling (`scheduleJob`, `cancelTimer`, `queueDueHeartbeatJobs`, `advanceScheduledHeartbeatJob`), execution (`executeJob`, `runNow`, `triggerHeartbeat`, `retryRun`, `cancelRun`, `recordExternalRunResult`, `reconcileActiveRuns`), delivery (`maybeDeliverRun`, `maybeDeliverFailureNotice`, `scheduleFailureFollowUp`), runtime sync (`syncJobToRuntime`, `syncRunToRuntime`, `syncRuntimeSnapshot`), and event emission (`emitJobCreated`, `emitJobUpdated`, `emitJobAutoDisabled`, `emitRunQueued`, `emitRunStarted`, `emitRunCompleted`, `emitRunFailed`). Sibling files `manager-runtime-scheduling.ts`, `manager-runtime-delivery.ts`, `manager-runtime-reconcile.ts`, `manager-runtime-execution.ts`, `manager-runtime-helpers.ts`, `manager-runtime-events.ts` already exist as helper modules — finishing the extraction (or composing them via dependency injection rather than `private` methods) would drop this to ~150 lines.

### MAJ-5 — Many silent `} catch { return <default>; }` blocks across the SDK
**File:** 37+ files including `client-auth/{ios,expo,android}-*.ts:197/186/233`, `platform/cloudflare/{worker-source,worker-settings,utils,resources}.ts`, `platform/{bookmarks,profiles}/manager.ts`, `platform/core/execution-plan.ts:127,153`, `platform/companion/companion-chat-persistence.ts:68`, `platform/daemon/{http-listener,facade}.ts`, `platform/artifacts/store.ts:97,662`, `platform/mcp/client.ts:84,382`, `platform/automation/manager-runtime-helpers.ts:405`, `platform/channels/delivery/shared.ts:156,163`, `platform/tools/{worklist,inspect/shared,goodvibes-runtime,shared/auto-heal,shared/overflow}/...`.
**Severity:** Major (Error handling — invisible failures)

The pattern `try { ... } catch { return null|''|false|[]|undefined; }` is used pervasively to convert parse / I/O / module-load failures into harmless fallbacks. Most paths *should* fall back, but the unanimous absence of `logger.debug('...', { error: summarizeError(err) })` means corrupt token stores, broken JSON state files, and module-load misconfigurations all become silent. Adding a single debug-level breadcrumb per call site would make these surfaces diagnosable without changing behaviour.

### MAJ-6 — `tools/repl/index.ts:54-63` — sync `readFileSync`/`writeFileSync`/`mkdirSync` on the request hot path
**File:** `packages/sdk/src/platform/tools/repl/index.ts:54,61-63`
**Severity:** Major (Performance / Event-loop blocking)

`loadHistory` and `saveHistory` block the event loop on every REPL invocation. For a tool that may be called dozens of times per agent turn, prefer `fs.promises.{readFile,writeFile,mkdir}` or a queued append-only writer. Same pattern repeats across other modules surfaced by the `sync_io` discovery query: `platform/{version,utils/prompt-loader,utils/markdown-disclosure,workspace/daemon-home,watchers/store,artifacts/store,agents/{wrfc-workmap,orchestrator-prompts,archetypes},tools/{write,worklist,team,find/shared,state,shared/{overflow,auto-heal}}/...,mcp/config,core/execution-plan,voice/providers/microsoft,security/user-auth,media/builtin-generation-providers,discovery/scanner,runtime/{session-persistence,ecosystem/catalog}}.ts`. (User-auth bootstrap, `version.ts`, and `daemon-home` are legitimately sync-only paths and should be excluded.)

### MAJ-7 — `client.ts:415-417` & `auth.ts:328` — `tokenStore!` non-null assertions reachable on edge case
**File:** `packages/sdk/src/client.ts:420`
**Severity:** Major (Type safety)

`mws.push(createAutoRefreshMiddleware(coordinator, transportProxy, tokenStore!));` — `tokenStore` is narrowed via the outer ternary at line 380 *but* the lint of the inner conditional only checks `coordinator`, not `tokenStore`. They happen to be 1:1 today (line 380: `coordinator !== null && tokenStore !== null`), but the postfix-`!` removes the safety net. Either widen the conditional check (`if (coordinator && tokenStore)`) or store the narrowed value: `const ts = tokenStore; if (coordinator && ts) { mws.push(... ts); }`.

### MAJ-8 — `react-native.ts:7,84-95` — `getAuthToken` resolver collapses external resolver semantics
**File:** `packages/sdk/src/react-native.ts:85,93-95`
**Severity:** Major (Behavioural)

`createReactNativeGoodVibesSdk` always overrides realtime auth resolution to `() => base.auth.getToken()`. When a caller passed a *static* `authToken` (no `tokenStore`, no `getAuthToken`), `base.auth.getToken()` works, but it changes the public contract: the realtime connector now reads from the SDK's wrapped token store on every reconnect rather than honouring the caller's `getAuthToken` resolver directly. This is fine in the common case, but undocumented; either document or pass through the original `options.getAuthToken` when present.

### MAJ-9 — `index.ts:46-55` — barrel `export *` re-exports may collide silently
**File:** `packages/sdk/src/index.ts:46-55`
**Severity:** Major (Public surface hygiene)

Eight back-to-back `export *` lines (`./observer/index.js`, `./contracts.js`, `./daemon.js`, `./errors.js`, `./transport-core.js`, `./transport-direct.js`, `./transport-http.js`, `./transport-realtime.js`, `./operator.js`, `./peer.js`). Each of those is itself a `export *` from an external `@pellux/goodvibes-*` package. With this many wildcard re-exports, name collisions silently lose the second binding (TS compiler emits no error for `export *` overlaps). Recommendation: enumerate the public surface explicitly (e.g. `export type { ... } from './contracts.js';` + `export { ... } from './contracts.js';`) so future additions to upstream packages can't accidentally shadow each other or pollute the public API.

### MAJ-10 — `platform/runtime/remote/transport-contract.ts:546` — `Math.random` jitter is acceptable but logged here for completeness
**File:** `packages/sdk/src/platform/runtime/remote/transport-contract.ts:546`
**Severity:** Minor → re-classified Major because the same jitter affects retry timing for transport failures across the SDK.

`computeRetryDelay(... rng = Math.random)` is fine for jitter (not a security RNG), and the function takes `rng` as an injectable parameter for tests. Confirm callers in `runtime/transports/daemon-http-client.ts` and elsewhere actually inject a deterministic RNG in the `runtime/eval/` test harness; if they don't, retry-delay tests will be flaky. Recommend a project-wide `cryptoSafeJitter()` helper or document the test convention in JSDoc.

---


## MAJOR — packages


### MAJ-1 — `connect()` is async but cannot throw, so the surrounding try/catch is dead code

**File:** `packages/transport-realtime/src/runtime-events.ts:517-535`

```ts
const connect = async () => {
  if (stopped) return;
  closeSocket();
  const nextSocket = new WebSocketImpl(url);
  socket = nextSocket;
  nextSocket.addEventListener('open', onOpen);
  ...
};

try {
  await connect();
} catch (error) {
  const connectionError = transportErrorFromUnknown(error, 'WebSocket runtime event connection failed');
  ...
  throw connectionError;
}
```

In standard runtimes `new WebSocket(url)` does not throw for transport-level failures — those surface through the `error`/`close` events that `onError`/`onClose` handle. `closeSocket()`, `addEventListener` and the assignment likewise cannot throw synchronously, so the `try/catch` here is dead and the `throw connectionError` path is unreachable. The corresponding catch-after-`await connect()` on line 530 is also unreachable on the same grounds. Worse, `scheduleReconnect` calls `void connect().catch(...)` (line 397) — that catch is also dead, meaning a failure inside `connect()` (e.g. `new URL` throwing if `buildWebSocketUrl` were ever called inside connect) would silently disappear.

Fix: either throw synchronously from `new WebSocketImpl(url)` failures by wrapping in try/catch *inside* `connect`, or remove the dead handlers and rely entirely on `onError`/`onClose`. Document the chosen contract.

### MAJ-2 — WebSocket `onOpen` `await` race window with `socket = null`

**File:** `packages/transport-realtime/src/runtime-events.ts:420-451`

`onOpen` is `async`, awaits `getAuthToken()` and `injectTraceparentAsync()`. Between the `await` and the `openedSocket.send(JSON.stringify(...))` on line 435, another listener (`onClose` or `onError`) can run, call `closeSocket()`, and set `socket = null`. The guard `if (stopped || socket !== openedSocket) return` mitigates this, but `flushOutboundQueue(openedSocket)` on line 442 is called on `openedSocket`, which by then may have `readyState === CLOSED`. `WebSocket.send` on a closed socket throws synchronously in Node/Bun and queues `INVALID_STATE_ERR` in browsers. The catch on line 444 handles this, but the queued messages drained from `outboundQueue` are then **lost** — they are popped before `flushOutboundQueue` ever calls `send`, with no rollback path.

Fix: re-check `isSocketOpen(openedSocket, WebSocketImpl)` immediately before each `ws.send` inside `flushOutboundQueue`; if not open, push the item back to the front of the queue (or restart with `unshift`) and break. Alternatively, atomic-snapshot the queue and only commit removals after successful `send`.

### MAJ-3 — `outboundQueueBytes` accounting underflow when `closeSocket()` races emitLocal

**File:** `packages/transport-realtime/src/runtime-events.ts:295-366, 408-418`

`outboundQueueBytes` is decremented in `flushOutboundQueue` (412) and the drop-oldest branch in `emitLocal` (349). But if `closeSocket()` is called before `flushOutboundQueue` ever drains (e.g. caller cancels), `outboundQueue` and `outboundQueueBytes` are not reset — stale entries persist into the next reconnect cycle and are flushed against the new socket. This may be the desired "queue across reconnects" behavior, but combined with MAJ-2's race the totals can drift positive (bytes counted but messages dropped from front via `outboundQueue.shift()` returning `undefined` if `outboundQueue.length === 0` while bytes > 0 isn't possible, but the inverse — `outboundQueueBytes` going negative — is possible if `flushOutboundQueue` partially drains and `closeSocket` fires before the loop exits).

Fix: reset `outboundQueueBytes = 0` and `outboundQueue.length = 0` in the disposal path (the returned cleanup at line 536-542) and consider a single mutation primitive that updates both length and byte total atomically.

### MAJ-4 — `domain-events.ts` connect-then-immediately-disconnect leaks the connection on race

**File:** `packages/transport-realtime/src/domain-events.ts:107-135`

```ts
connectPromise = Promise.resolve(connect(domain, ...))
  .then((cleanup) => {
    if (typeof cleanup !== 'function') return;
    if (disconnectPending && !hasListeners()) {
      cleanup();
      return;
    }
    disconnect = cleanup;
  })
```

If `connect()` returns a non-function cleanup (allowed: `void | () => void` per `DomainEventConnector` type) AND `disconnectPending` was set while the promise was in-flight, the connection is held open with no cleanup handle — the runtime has no way to close it. The early `return` on `typeof cleanup !== 'function'` skips `disconnectPending` handling.

Fix: when `cleanup` is not a function, log/throw if `disconnectPending` is true, since there is no way to honor the pending close. At minimum, document that connectors must always return a cleanup function once the connection is established (and tighten the type to `Promise<() => void>`).

### MAJ-5 — Server error body fields echo internal context (info disclosure)

**File:** `packages/daemon-sdk/src/error-response.ts:284-336`

`buildErrorResponseBody` faithfully serialises `provider`, `operation`, `phase`, `requestId`, `providerCode`, `providerType`, `retryAfterMs`, plus daemon-side `hint`/`guidance` text into the wire body. Several fields are useful to clients (`retryAfterMs`, `category`, `hint`) but `provider`, `operation`, and `phase` reveal internal pipeline structure (e.g. which provider failed, what step inside the daemon was running) to any HTTP client. For a public daemon this is information disclosure that aids fingerprinting and targeted attacks.

Fix: gate `provider`/`operation`/`phase`/`providerCode`/`providerType` on the request principal's privilege (admin/operator only) or strip them at a public-surface boundary. The structured body schema in `errors/src/daemon-error-contract.ts` admits these fields, but the daemon's own routing layer should redact for unauthenticated callers.

### MAJ-6 — `onMessage` JSON.parse against unbounded input before size check

**File:** `packages/transport-realtime/src/runtime-events.ts:453-465`

```ts
const frameBytes = textEncoder.encode(event.data).byteLength;
if (frameBytes > MAX_INBOUND_FRAME_BYTES) { throw ... }
const frame = JSON.parse(event.data) as { ... };
```

The size check happens before parse — good. But `textEncoder.encode(event.data)` allocates the full UTF-8 buffer first (up to 4× the JS string length) just to measure it. For a 1 MiB cap the allocation cost is fine; for a hostile peer sending repeated near-cap frames this doubles allocator pressure. More importantly, `event.data.length * 4 >= MAX_INBOUND_FRAME_BYTES` is a sufficient cheap pre-check that avoids the encode entirely on the hot path.

Fix: short-circuit with `if (event.data.length > MAX_INBOUND_FRAME_BYTES) throw` (worst-case 1 byte/char), and only fall back to `textEncoder.encode` when within the cheap bound.

---


## MAJOR — tests


### MAJ-01 — Two parallel helper directories (`test/helpers/` and `test/_helpers/`)
**Files:** `test/_helpers/` (7 files), `test/helpers/` (1 file: `dist-errors.ts`)

The codebase has **two** helper roots. `test/helpers/dist-errors.ts:11-16` re-exports from `packages/errors/dist/`. Everything else is under `test/_helpers/`. The naming (`_helpers` vs `helpers`) is purely a convention and only one file lives in the legacy directory. New contributors will guess wrong; renaming churn invites import-path drift.

**Fix:** Move `test/helpers/dist-errors.ts` into `test/_helpers/` and remove `test/helpers/`.

### MAJ-02 — `test/COVERAGE.md` rot — 12 numbered slots marked "missing" without follow-up
**File:** `test/COVERAGE.md:14-72`

The table flags `obs-10`, `obs-17`, `obs-20`, `obs-23`, `sec-04`, `sec-09`, `sec-10`, `perf-04`, `perf-05`, `perf-06`, `perf-08`, `perf-09`, `perf-11` as `_(missing)_ — Gap flagged by seventh-review`. This is the eighth review; nothing has changed. Either:
- The numbered IDs are valid and someone owes 12 missing tests, OR
- The number sequence is arbitrary and the ID column should be removed.

Leaving "Gap flagged by seventh-review" tombstones makes the doc actively misleading — reviewers cannot tell whether a missing slot is a known TODO, an intentional skip, or stale documentation. Pick one and stick with it.

Also 12/12 entries with file paths use placeholder text `_(not yet assigned)_` — the table promises to map IDs → real tests but never delivers.

### MAJ-03 — `expect(...durationMs).toBeGreaterThanOrEqual(0)` is partially tautological
**Files:**
- `test/transport-middleware.test.ts:135` (`ctx.durationMs!`)
- `test/transport-middleware.test.ts:180` (`ctx.durationMs`)
- `test/obs-04-llm-instrumentation.test.ts:20` (`wrapped.durationMs`)

Since `durationMs` is computed via `Date.now() - start` of monotonic-ish wall time, `>= 0` is trivially true (modulo `Date.now` going backwards under NTP, which is not what these tests are guarding). Each call site DOES also have an upper-bound `toBeLessThan(1000)`, which carries the actual assertion weight, so the tautology is partial — but the redundant lower bound clutters intent. A comment in `transport-middleware.test.ts:134` even acknowledges this ("Sanity-bound: must be non-negative…").

**Fix:** Drop `>= 0` and rely on the upper bound, OR make the lower bound meaningful (e.g. `> 0` if the test exercises a deliberate `await` that should produce non-zero elapsed time).

### MAJ-04 — `dist-freshness.test.ts` and `check-dist-freshness.ts` duplicate the same logic with no shared module
**Files:** `scripts/check-dist-freshness.ts:23-115`, `test/dist-freshness.test.ts:5-27`, `test/_helpers/dist-mtime-check.ts:24-58`

Three separate implementations of "newest src mtime > newest dist mtime":
- `scripts/check-dist-freshness.ts` — recursively walks each tree, reports STALE/MISSING/FRESH, exits non-zero.
- `test/dist-freshness.test.ts` — compares only `src/index.ts` vs `dist/index.js` mtimes (single-file, will miss internal staleness when `index.ts` re-exports).
- `test/_helpers/dist-mtime-check.ts` — same as `dist-freshness.test.ts` (single-file), but throws at import time. Currently dead (CRIT-01).

The single-file mtime check in `dist-freshness.test.ts:24` is **weaker** than `check-dist-freshness.ts` — touching a deep file in `src/` won't update `src/index.ts`'s mtime, so the test passes while dist is stale.

**Fix:** Make `dist-freshness.test.ts` shell out to `bun scripts/check-dist-freshness.ts` so both checks share the recursive walker.

### MAJ-05 — `test/_helpers/daemon-stub-handlers.ts` returns `Response.json({ ok: true })` for ALL admin/state-mutating endpoints, including unauth paths
**File:** `test/_helpers/daemon-stub-handlers.ts:50-60, 100-127, 144-154, 186-205`

Every `post*`/`patch*`/`delete*` handler stub returns `{ ok: true }`. There is no spy/recording mechanism — when a route test exercises e.g. `postLocalAuthUser`, `deleteRemotePeerToken`, or `revokeRemotePeerToken`, the test cannot assert that the stub was actually called with the expected args. Tests that import this stub end up testing the *router dispatch path*, not the handler invocation.

Only `postChannelAccountAction` uses `unexpectedHandler as never` (`daemon-stub-handlers.ts:86`) — every other admin handler silently ACCEPTS calls. If a route is misrouted (e.g. `DELETE /local-auth/session/:id` accidentally goes to `deleteLocalAuthUser`), the stub returns `{ ok: true }` and the test passes. This is exactly the "sham mock" pattern the user warned about.

**Fix:** Replace `jsonStub({ ok: true })` with a recording wrapper:
```ts
function recordingStub<T>(value: T): { handler: () => Response; calls: unknown[][] }
```
so each test can opt-in to call-count assertions for the routes it actually exercises.

### MAJ-06 — `test/integration/auth-flow-e2e.test.ts` and `any-runtime-event-property.test.ts` both rely on heavyweight `arbitraries.ts` (605 LOC of fast-check generators) but the file is 43kB and never trimmed
**File:** `test/integration/_shared/arbitraries.ts:1-605`

The arbitraries file is large enough to be its own concern. Spot-check shows it generates *every* runtime event variant. If a generator drifts from production union types, the tests still compile (because of the `as never` / `unknown` casts that fast-check uses internally) but exercise stale shapes. Recommend a `arbitraries.unit.test.ts` that round-trips a sample of each generated value through the production Zod schema to detect drift.

### MAJ-07 — `test/perf-07-interval-unref.test.ts` regex-greps source files instead of using AST
**File:** `test/perf-07-interval-unref.test.ts:40-62`

`hasUnrefInWindow` uses three layered regex heuristics (inline `.unref()` chain, `const x = setInterval(...)` then scan 20 lines for `x.unref?.()`, fallback any `.unref()` in next 25 lines). The fallback (line 60-61) is a false-positive trap: ANY unrelated `.unref?.()` within 25 lines of a `setInterval(...)` makes the check pass. A future refactor that wraps `setInterval` and unrefs an unrelated timer 24 lines below will silently disable the regression guard.

**Fix:** Replace with a real AST walk via the existing `@ast-grep/napi` dep (the SDK already uses it under `packages/sdk/src/platform/tools/find/structural.ts`).

### MAJ-08 — Race-prone `setTimeout(..., 120)` in `test/knowledge-semantic-answer.test.ts:535`
**File:** `test/knowledge-semantic-answer.test.ts:535`

A test schedules `setTimeout(() => store.upsertExtraction(...), 120)` and then awaits semantic-repair logic that polls. On a slow CI runner, the 120ms window may slip past the polling deadline and the test will go red intermittently. Surrounding code (`waitFor` from `_helpers/test-timeout.ts`) supports a `timeoutMs` knob — use it; don't hard-code a magic 120.

### MAJ-09 — `cache-invariants.test.ts:280` real `setTimeout` inside a determinism-claim test
**File:** `test/cache-invariants.test.ts:280`

The surrounding test (lines 270-330) explicitly says "Deterministic version: emit both events synchronously so setImmediate cannot fire between them" — but the same suite still uses real wall-clock `setTimeout` calls elsewhere and reads `Date.now()` to assert wall-clock bounds (line 305: `t0 = Date.now()`, line 327: `expect(...).toBeLessThanOrEqual(Date.now())`). Determinism is partial. If the suite ever runs under a frozen-clock harness, the bound `<=Date.now()` will tautologically pass.

### MAJ-10 — `test/dist-freshness.test.ts:24` only checks `src/index.ts` not deep tree
**File:** `test/dist-freshness.test.ts:24`

```ts
expect(statSync(distEntry).mtimeMs).toBeGreaterThanOrEqual(statSync(sourceEntry).mtimeMs);
```

If you edit `packages/sdk/src/platform/runtime/transports/foo.ts` without touching `src/index.ts`, the `src/index.ts` mtime stays old and the test passes despite stale dist. Same hole as CRIT-01.

### MAJ-11 — `dist-mtime-check.ts:47` swallows `statSync` errors silently with a comment
**File:** `test/_helpers/dist-mtime-check.ts:47-49`

```ts
} catch {
  // dist/ may not exist in all environments; skip missing files
}
```

If the dist tree is fully missing (mid-rebuild, accidental `rm -rf`), this sentinel reports OK. The whole point of the helper is to fail loudly when dist is stale; failing silently when dist is *absent* is the strictly worse failure mode.

---


## MAJOR — docs+examples


### MAJ-001 — README claims provider/model runtime, but the SDK is a daemon client

- File: `README.md:42-50`
- Evidence: README lists "Provider/model runtime", "Agentic runtime", "Knowledge/wiki system", "Channel surfaces" etc. as things "the SDK provides". Those features live behind the daemon and the platform surface; the typical consumer of the umbrella package never instantiates a provider runtime. Compare `getting-started.md:3-6` which is precise: "`@pellux/goodvibes-sdk` is a client SDK for the GoodVibes daemon. It does not call Anthropic, OpenAI, Gemini, or any other AI provider directly." Reads as marketing fluff that contradicts the precise stance.
- Fix: re-scope the README capability list to differentiate "client-of-daemon" features from "daemon-embedding" features.

### MAJ-002 — `getting-started.md:200-205` shows `createConsoleObserver` imported from root — verify it is reachable

- File: `docs/getting-started.md:200-205`
- Evidence: `packages/sdk/src/index.ts:46` does `export * from './observer/index.js';` and `packages/sdk/src/observer/index.ts:135` exports `createConsoleObserver`. So this **does work** — but the same surface is duplicated as a separate entrypoint `./observer` in the exports map (`package.json:98-101`) without docs. Consumers cannot tell whether the canonical path is the root or `./observer`.
- Fix: pick one canonical path; document it in `public-surface.md`. Either delete the `./observer` subpath or stop re-exporting through root.

### MAJ-003 — `error-handling.md:15` and `error-handling.md:82` use `sdk.operator.accounts.snapshot()` — exists, but unrelated to the example’s point

- File: `docs/error-handling.md:15,82`
- Evidence: `accounts.snapshot` is real (`packages/operator-sdk/src/client-core.ts:111-113`). Fine. But the example sets up a `safeSnapshot(sdk: OperatorSdk)` accepting `OperatorSdk` and calling `sdk.operator.control.snapshot()`. `OperatorSdk` does not have an `operator` property — that namespace exists on the umbrella SDK type. The function signature is wrong.
- File: `docs/error-handling.md:53-71`
- Fix: change the parameter type to `GoodVibesSdk` (from `@pellux/goodvibes-sdk`) or call `sdk.control.snapshot()` directly on `OperatorSdk`.

### MAJ-004 — `error-handling.md:56` references `ControlSnapshot` type that the SDK does not export

- File: `docs/error-handling.md:56`
- Evidence: signature uses `ControlSnapshot` as a return type, but no public export by that name exists across the published surfaces (`packages/sdk/src/index.ts`, `packages/operator-sdk/src/**`, `packages/contracts/src/**`). The shape lives inline as the output of `OperatorMethodOutput<'control.snapshot'>`.
- Fix: replace with `OperatorMethodOutput<'control.snapshot'>` and import from `@pellux/goodvibes-sdk/contracts`, or remove the explicit annotation.

### MAJ-005 — `realtime-and-telemetry.md:42-44` documents `sdk.operator.telemetry.otlp.{traces,logs,metrics}()` — exists, prose is fine; but `daemon-embedding.md` does not match `surfaces.md`

- File: `docs/realtime-and-telemetry.md:42-44`
- Evidence: `packages/operator-sdk/src/client-core.ts:139-142` confirms `telemetry.otlp.{traces,logs,metrics}` exists. Note for completeness only — no defect.
- Adjacent defect: `daemon-embedding.md:39-49` enumerates daemon route groups (channel routes, integration routes, system routes, knowledge routes, media routes, runtime automation routes, runtime session routes, remote/peer routes). The published `@pellux/goodvibes-daemon-sdk` exports `dispatchAutomationRoutes`, `dispatchSessionRoutes`, `dispatchTaskRoutes`, `dispatchOperatorRoutes`, plus the unified `dispatchDaemonApiRoutes` (per `packages/daemon-sdk/src/index.ts:22-27`). The other groups in the list have no matching public dispatcher. The bullet list reads as if those groups are stable.
- Fix: enumerate exactly what is exported from `@pellux/goodvibes-daemon-sdk` and stop listing groups the consumer cannot wire.

### MAJ-006 — `submit-turn-quickstart.mjs:22` claim about response shape

- File: `examples/submit-turn-quickstart.mjs:22`
- Evidence: comment says "response is { session: { id, ... } }" — this assumes a specific output shape for `sessions.create`. Looking at `OperatorMethodOutput<'sessions.create'>` (declared in `packages/contracts/src/generated/foundation-client-types.ts`) is the only authoritative answer. The example does not show the actual return type and the comment is unverified prose. If the runtime returns the session object directly (not wrapped in `{ session }`) the example fails at `session.session.id`.
- Action: verify `OperatorMethodOutput<'sessions.create'>` shape against `session.session.id` access. If wrong, fix; if right, the comment is fine.

### MAJ-007 — `expo-quickstart.tsx` types depend on a hand-rolled shim, not real packages

- File: `examples/expo-quickstart.tsx`, `examples/react-expo-shims.d.ts`
- Evidence: `react-expo-shims.d.ts` declares stub `react` and `expo-secure-store` modules so the example typechecks without installing the real packages. `examples/package.json` lists `@types/react` and `expo-secure-store` as devDependencies but no `react` runtime dep. Result: typecheck passes against fake types; behavior at runtime in a real Expo app is whatever the real package does, which may differ from the shim. This decouples the example from the real surface it claims to demonstrate.
- Fix: install real `react` and rely on real `@types/react` and `expo-secure-store` types; delete the shim file. Or move the example outside the typecheck gate and document that.

### MAJ-008 — `docs/auth.md:8` cites `packages/sdk/src/platform/auth/token-store.ts` but `platform/auth` is not in the public dirs

- File: `docs/auth.md:7-9`
- Evidence: the prefix `packages/sdk/src/platform/auth/` does not appear in the public source tree. There is `_internal/platform/auth/` (private mirror) but no public `platform/auth/`. Source-of-truth for token stores is `packages/sdk/src/client-auth/`.
- Fix: replace the cited path with `packages/sdk/src/client-auth/token-store.ts`.

### MAJ-009 — `pairing.md` token storage path claim is presented as canonical

- File: `docs/pairing.md:39-43`
- Evidence: the doc states the daemon-home directory is `~/.goodvibes/daemon/operator-tokens.json` and the file is written 0600. That matches `packages/sdk/src/platform/pairing/companion-token.ts`, but the doc also claims `surface name (...) does not partition the token path`. Verify — the source signatures of `getOrCreateCompanionToken` (lines 84–91 of `companion-token.ts`) include three overloads, one of which takes `surface`. Without reading the body, the doc claim is unverified.
- Action: spot-check the implementation. If the claim is right, leave as-is; if wrong, correct.

### MAJ-010 — `companion-app-patterns.md:46` mentions `approvals.list()` polling cadence

- File: `docs/companion-app-patterns.md:46`
- Evidence: matches `packages/operator-sdk/src/client-core.ts:99-105`. Fine. But note: `companion-approvals-feed.ts:11` calls `sdk.operator.approvals.list()` on a `BrowserGoodVibesSdk`. Confirmed exists at the operator namespace level. OK.

### MAJ-011 — Examples README typecheck instructions are stale

- File: `examples/README.md:6-9`
- Evidence: instructions say `bun run build` then `bun --cwd examples run typecheck`. Note `examples/tsconfig.json` extends `../tsconfig.base.json` which is at the repo root. A user who only cloned `examples/` cannot typecheck. That is fine for a workspace, but should be stated.
- Fix: state "run from repo root".

### MAJ-012 — CHANGELOG "Unreleased" section is empty but recent commits suggest changes

- File: `CHANGELOG.md:7-19`
- Evidence: `## [Unreleased]` section has `none` for every category. Repository git status shows substantial uncommitted churn across docs and examples. If those changes are intended for the next release, the CHANGELOG must reflect them per `release-and-publishing.md:60`.
- Fix: populate `## [Unreleased]` before the next tag; or, if the changes shipped in 0.30.3, file them under that section retroactively.

---


## MAJOR — build+CI+config


### MAJ-001 — `engines.bun` declared on root + sdk only; missing on 7 sub-packages
**Files:** `package.json:7-10`, `packages/sdk/package.json:250-253` declare `"bun":"1.3.10"`. The other workspace packages (`packages/contracts/package.json:4-6`, `daemon-sdk:4-6`, `errors:4-6`, `operator-sdk:4-6`, `peer-sdk:4-6`, `transport-core:4-6`, `transport-http:4-6`, `transport-realtime:4-6`) declare ONLY `"node":">=20.0.0"`.

**Impact:** The published packages don't carry the bun engine pin. This is debatable — these are runtime-neutral packages. But if root + sdk pin bun, the policy is inconsistent: a consumer using bun installing `@pellux/goodvibes-contracts` directly gets no engine signal. Either remove `engines.bun` from sdk too (it is a published consumer artifact, not a build-only constraint) or apply consistently.

**Recommended fix:** Remove `engines.bun` from `packages/sdk/package.json:251` since bun is a build-time tool, not a runtime requirement for SDK consumers. Keep it on root.

---

### MAJ-002 — Root `package.json` engines.node `>=20.0.0` but `node-version: "22"` in workflows
**Files:** `package.json:9` (`"node":">=20.0.0"`), `.github/workflows/ci.yml:117,120,123,126,134,188,269` and `release.yml:54,118,166` (all `node-version: "22"`).

Running CI exclusively on Node 22 means Node 20 compatibility is never actually validated. The declared support floor is untested.

**Fix:** Either bump `engines.node` to `>=22.0.0` (matches what is tested) or add a Node 20 entry to `platform-matrix.include` so the floor is exercised.

---

### MAJ-003 — TypeScript devDependency at `^6.0.3` is a major version not yet GA at policy floor
**File:** `package.json:101` (`"typescript":"^6.0.3"`).

TypeScript 6.0.x is not part of the documented stable LTS line in `docs/semver-policy.md` (which the grep flagged). `^6.0.3` permits `7.x` upgrades on next install if 7 ships before lockfile is regenerated. The repo otherwise pins exact versions for build-critical tooling (`@arethetypeswrong/cli` `0.18.2`, `@cyclonedx/cyclonedx-npm` `4.2.1`, `publint` `0.3.18`, `wrangler` `4.87.0`) — TypeScript's caret range is inconsistent with that policy and is the highest-impact tool in the chain.

**Fix:** Pin to exact: `"typescript":"6.0.3"` (or whichever tested patch).

---

### MAJ-004 — Release workflow auto-publishes to GitHub Packages on tag push without explicit user gate
**File:** `.github/workflows/release.yml:144-195`

`publish-github-packages` job mirrors the npm publish but uses `secrets.GITHUB_TOKEN`, which is auto-issued and not subject to npm-style review. Lines 184-188:
```yaml
- name: Publish GitHub Packages copy
  if: github.event_name == 'push'
  env:
    GITHUB_PACKAGES_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: bun run release:publish
```
No `environment:` gate. Any tag push publishes.

**Fix:** Either share the `npm-publish-prod` environment with `publish-npm` (CRIT-002) or add a separate `github-packages-prod` environment.

---

### MAJ-005 — `release.yml` GitHub Packages job sets registry-url BEFORE checking event_name; dry-run uses GITHUB_TOKEN unnecessarily
**File:** `.github/workflows/release.yml:165-183`

For a `workflow_dispatch` dry run, the `Setup Node` step (line 165) configures `registry-url: "https://npm.pkg.github.com"` and the dry-run step (line 179-183) sets `GITHUB_PACKAGES_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Even though dry-run does not push, the token is exported into the env. Defense-in-depth: do not export auth in dry-run paths.

**Fix:** Wrap the `env: GITHUB_PACKAGES_TOKEN` in the same `if: github.event_name == 'push'` condition as the publish step, OR move the dry-run into a job without packages: write permission.

---

### MAJ-006 — `release-shared.ts:282-295` uses `execFileSync` with caller-controlled `command` string and array — no validation
**File:** `scripts/release-shared.ts:282-295`

```ts
export function run(command: string, args: readonly string[], cwd: string, options: RunOptions = {}): string {
  …
  return execFileSync(command, args, {
    cwd,
    env: childEnv,
    …
  });
}
```
The `command` and `args` are passed directly. Within this codebase the values are hardcoded literals (`'npm'`, `'tar'`, `'node'`), so this is not currently exploitable. However `options.env` is merged with `process.env` and used as the child environment. If `process.env` ever contains an attacker-controlled `NODE_OPTIONS`, `npm_config_*`, or `PATH`, the child process will inherit it. This is mitigated by `createAuthEnv` writing a temp `.npmrc` and pointing `NPM_CONFIG_USERCONFIG` at it (good), but `PATH` is still inherited unfiltered.

**Fix:** Document this contract (caller is responsible for sanitizing process.env) and consider scrubbing `NODE_OPTIONS`/`NODE_PATH`/`npm_config_*` before invoking `execFileSync` in release contexts.

---

### MAJ-007 — `verdaccio-dry-run.ts` uses `process.env.VERDACCIO_BIN` without validation
**File:** `scripts/verdaccio-dry-run.ts:123-131`

```ts
const configuredVerdaccioBin = process.env.VERDACCIO_BIN;
…
const verdaccioCommand = configuredVerdaccioBin ?? localVerdaccioBin;
…
const proc = spawn(verdaccioCommand, verdaccioArgs, { … });
```
If `VERDACCIO_BIN` is set (legitimate use case), there is no `existsSync` check, no executable-bit verification, and no allow-list of paths. A misconfigured CI runner with `VERDACCIO_BIN=/tmp/evil` would run an arbitrary binary. This is a developer-facing script (low blast radius) but the env-fallback path is silent.

**Fix:** Add `existsSync(configuredVerdaccioBin)` guard before `spawn`, and `console.log` the resolved path so misconfiguration is visible.

---

### MAJ-008 — Bundle budget rationale strings claim `* 1.2` but actual ratios drift up to `* 1.215`
**File:** `bundle-budgets.json:14-185`

The `_comment` (lines 1-13) declares the methodology: `gzip_bytes = max(ceil(actual * 1.2), actual + 50)`. Every entry's rationale claims `* 1.2`. Spot-checking:

| Entry | Stated | Computed `ceil(actual * 1.2)` | Match? |
|---|---|---|---|
| `./auth` (line 18-20) | budget 3200, `2747 B gzip * 1.15` | `ceil(2747*1.2)=3297` | **Rationale wrong**: claims 1.15 multiplier (not 1.2 per methodology) and budget 3200 < 3297. The 3200 budget is BELOW the 1.2 floor. |
| `./browser` (line 22-24) | budget 1197, `997 B gzip * 1.2` | `ceil(997*1.2)=1197` | OK |
| `./client-auth` (line 26-28) | budget 196, `163 B * 1.2` | `ceil(163*1.2)=196` | OK |
| `./contracts` (line 30-32) | budget 82, `68 B * 1.2` | `ceil(68*1.2)=82` (also `68+50=118`) | Methodology says `max(ceil*1.2, actual+50)` = 118, but budget is 82. **Floor violated** for ALL entries below ~250 B. |
| `./contracts/node` (line 34-36) | 103, `86*1.2` | `ceil(86*1.2)=104`, `86+50=136`. Budget 103 < both. | **Floor violated** |
| `./daemon` (line 38-40) | 78, `65*1.2` | `ceil(65*1.2)=78`, `65+50=115`. Budget 78 < 115. | **Floor violated** |
| `./errors`, `./operator`, `./peer`, `./platform/git`, `./platform/multimodal`, `./transport-core`, `./transport-http`, `./transport-realtime`, `./platform/knowledge/extensions` | … | All small entries below ~200 B violate the `actual+50` floor stated in the comment. | **Floor violated** for >12 entries |

Either the methodology comment lies (the `+50` floor is not actually applied) or many small-entry budgets are below the floor. This isn't a runtime risk, but it makes future budget bumps non-mechanical: a developer following the documented formula would set higher budgets than what's currently enforced.

**Fix:** Reconcile the `_comment` methodology with the actual data. Either:
1. Apply `actual + 50` as the floor (raises budgets for ~15 small entries by 30-50 B each), OR
2. Remove the `+50 floor` claim from `_comment` lines 4-5, 10.

Also fix `./auth` rationale (line 20) which says `* 1.15` — that contradicts the documented `* 1.2`.

---

### MAJ-009 — Setup composite action `actions/cache` step does not include `save-always` or version branch keys
**File:** `.github/actions/setup/action.yml:12-18`

```yaml
- name: Restore Bun install cache
  uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830
  with:
    path: ~/.bun/install/cache
    key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

No `save-always: true` — if a job fails, the cache is not saved and subsequent jobs miss the warm install. Not destructive, but slows CI on flaky builds.

**Fix:** Add `save-always: true` if cache poisoning is acceptable, OR split into separate `actions/cache/restore` + `actions/cache/save` (Always run save after install).

---


## MAJOR — public surface


### MAJ-01 — `__internal__` symbol is exported from the public root entrypoint
**File:** `etc/goodvibes-sdk.api.md:10-14`
**Severity:** Major (Surface leak)

```
// @internal
export const __internal__: {
    readonly buildSchemaRegistry: (methodIds: readonly string[], schemas: Record<string, unknown>) => Partial<Record<string, ZodType>>;
    readonly methodIdToSchemaName: (methodId: string) => string;
};
```

This symbol is tagged `@internal` but reaches the rolled-up public `index.d.ts`. Any consumer can write `import { __internal__ } from '@pellux/goodvibes-sdk'` and get full intellisense on internals. The semver policy (`docs/semver-policy.md:13`) commits that removing public exports requires a major bump; once consumers depend on `__internal__`, removing it would technically be a major. Either strip-internal at d.ts rollup or rename it so it cannot be imported by accident is the right move. (api-extractor `bundledPackages` is what is leaking the operator-sdk re-export here.)

### MAJ-02 — 27 event-shape types are referenced from the public surface but not exported (api-extractor `ae-forgotten-export` block)
**File:** `etc/goodvibes-sdk.api.md:94-120`
**Severity:** Major (Type-leak / surface drift)

Lines 94-120 of the api report contain 27 inline `// Warning: (ae-forgotten-export)` warnings for symbols that appear in public function/type signatures but are not themselves exported through the root `index.d.ts`:

`SessionEvent`, `TurnEvent`, `ProviderEvent`, `ToolEvent`, `TaskEvent`, `AgentEvent`, `WorkflowEvent`, `OrchestrationEvent`, `CommunicationEvent`, `PlannerEvent`, `PermissionEvent`, `PluginEvent`, `McpEvent`, `TransportEvent`, `CompactionEvent`, `UIEvent_2`, `OpsEvent`, `ForensicsEvent`, `SecurityEvent`, `AutomationEvent`, `RouteEvent`, `ControlPlaneEvent`, `DeliveryEvent`, `WatcherEvent`, `SurfaceEvent`, `KnowledgeEvent`, `WorkspaceEvent`.

These symbols are exported from `packages/sdk/src/events/index.ts` (line 1-66), but only reachable via the `./events` subpath — they don't bubble through `./` (root) even though signatures using them do. The result is that root-level callers can see types they can't name. This is a frequent cause of the "reference TypeScript error: cannot use private name" experience for consumers.

**Fix path:** Re-export the event union types from `packages/sdk/src/index.ts` (it already does `export * from './observer/index.js'` etc., add `export * from './events/index.js'`).

### MAJ-03 — 60+ additional `ae-forgotten-export` warnings throughout api.md (route-handler types and platform-Like interfaces)
**File:** `etc/goodvibes-sdk.api.md` lines 290, 343, 359, 375, 379, 560, 577, 588, 596, 607, 608, 619, 620, 650, 658, 669, 683, 758, 759, 918-925, 1069, 1073, 1091-1095, 1101, 1223, 1408, 1440, 1466, 1536, 1609, 1711, 1713, 1716, 2011, 2016, 2051, 2387, 2590, 2596, 2784, 2817, 12283, 13748, 13783, 13995, 14009, 14013, 14611, 14655, 14863, 14916, 14917, 14932, 14938, 15451, 15468 (and 14 trailing project-relative warnings at 15550-15563).
**Severity:** Major (Surface leak / type-naming gaps)

80+ symbols are referenced from public type signatures but not exported. Examples:
- `TokenStore`, `SessionManager`, `PermissionResolver`, `AutoRefreshCoordinator`, `AutoRefreshOptions` (auth surface — line 1711-1716, 619-620). Public-surface.md line 33 advertises these by name.
- `OperatorRemoteClientOptions`, `PeerRemoteClientOptions` (650, 658) — operator/peer client surface.
- `HttpJsonTransport`, `HttpJsonTransportOptions` (2011, 2016) — transport-http surface.
- `WatcherRecord`, `VoiceSynthesisStreamLike` (15468, 15451) — platform/voice + watcher surface.
- `ConversationMessageEnvelope`, `KnownMethodArgs`, `KnownStreamArgs`, `KnownEndpointArgs`, `KnownPathMethodArgs`, `KnownPathEndpointArgs` — operator/peer client typings.
- `JsonValue_2`, `KnowledgeUsageKind`, `KnowledgeCandidateStatus`, `AutomationSurfaceKind_2`, `SharedSessionRoutingIntent`, `AutomationRouteBinding`, `AgentRecordLike`, `AutomationJobLike`, `AutomationRunLike`, `ExecutionIntent`, `RuntimeTaskStateLike`, `WatcherSourceRecord` (trailing list 15550-15563) from contracts and daemon-sdk.

These typically come from sibling packages (`@pellux/goodvibes-daemon-sdk`, `@pellux/goodvibes-operator-sdk`, etc.) that are bundled by api-extractor (`api-extractor.json:8-17`) but whose own internal types aren't re-exported from the SDK root. This is a long-standing surface-hygiene issue, not new.

**Fix path:** Either (a) explicitly re-export each symbol from `packages/sdk/src/index.ts` or the appropriate subpath facade, or (b) hide the references behind a public alias type. Highest-priority leaks: auth (`TokenStore`, `SessionManager`, `PermissionResolver`, `AutoRefreshCoordinator`) — these are documented public concepts.

### MAJ-04 — `./client-auth` subpath is exported but undocumented in public-surface.md
**File:** `packages/sdk/package.json:64-67`, `docs/public-surface.md` (entire file), `docs/packages.md` (entire file)
**Severity:** Major (undocumented public path = unsupportable contract)

`packages/sdk/package.json:64-67` exposes `./client-auth` resolving to `./dist/client-auth/index.js`. Source exists at `packages/sdk/src/client-auth/index.ts` (16 lines). Neither `docs/public-surface.md` nor `docs/packages.md` mention it. Consumers cannot tell whether this is stable, beta, or preview, or what its stability contract is. The semver policy (`docs/semver-policy.md:13`) treats every exported subpath as a public commitment — if `./client-auth` were removed in a 0.31 minor, that would technically be a breaking change.

**Fix path:** Add a `./client-auth` section to `docs/public-surface.md` with explicit stability label and exported names; and add a row to the `docs/packages.md` entry-point matrix. If the path is internal-only, remove it from the exports map.

### MAJ-05 — `./observer` subpath is exported but undocumented
**File:** `packages/sdk/package.json:98-101`, `docs/public-surface.md`, `docs/packages.md`
**Severity:** Major (undocumented public path)

Same pattern as MAJ-04. `./observer` resolves to `./dist/observer/index.js`. Bundle budget allocates 2188 B gzip (`bundle-budgets.json:54-57`) — meaningfully sized for an undocumented public path. Public-surface.md does not mention it. The root `index.ts:46` does `export * from './observer/index.js'`, so it's already part of the root surface, but the dedicated subpath is undocumented. Either document it or remove the redundant subpath.

### MAJ-06 — `./events/*` wildcard subpath is exported but per-domain paths are uncommitted
**File:** `packages/sdk/package.json:90-93`, `docs/public-surface.md:92-99`
**Severity:** Major (Unbounded contract surface)

`./events/*` is a wildcard subpath resolving to `./dist/events/*.js`. There are 30 files in `packages/sdk/src/events/` (`agents`, `automation`, `communication`, `compaction`, `contracts`, `control-plane`, `deliveries`, `domain-map`, `forensics`, `index`, `knowledge`, `mcp`, `ops`, `orchestration`, `permissions`, `planner`, `plugins`, `providers`, `routes`, `security`, `session`, `surfaces`, `tasks`, `tools`, `transport`, `turn`, `ui`, `watchers`, `workflows`, `workspace`). The doc says "Use `./events/<domain>` for a single domain such as `@pellux/goodvibes-sdk/events/agents`" but does not enumerate the supported domain set. Internal modules like `events/contracts` and `events/domain-map` (which are intended primarily as building blocks of the aggregate `./events` index) are now public via the wildcard. Each one becomes a semver commitment.

**Fix path:** Replace `./events/*` with explicit per-domain entries for the documented domains, OR add a documented inventory and stability label to public-surface.md.

### MAJ-07 — semver-policy.md lists `node` as a supported runtime; runtime-boundary docs say full platform is not a supported Node consumer surface
**File:** `docs/semver-policy.md:19`, `docs/packages.md:47-50`
**Severity:** Major (Cross-doc contradiction)

`docs/semver-policy.md:19` declares: "Removing a supported runtime from the runtime matrix (currently: `bun`, `browser`, `react-native` / Hermes, `workers`)". Note: `node` is NOT in this list.

But `docs/packages.md:47-50` says: "Today the full surface is Bun-oriented; `platform/node` documents and guards Node-like runtime boundaries without making the full platform a supported Node consumer surface."

This is consistent on its face. However, `capabilities.ts:5-6` defines runtime surfaces `'node-runtime' | 'node-platform'`, and `bundle-budgets.json` baselines the dist bundles assuming Node compat for many platform paths. Consumers reasonably assume Node 20+ works (`packages/sdk/package.json:252` declares `"node": ">=20.0.0"` in `engines`). The semver policy should either (a) list `node-as-runtime` explicitly with whatever caveat, or (b) clarify that engines.node is for the build/Bun host only.

### MAJ-08 — semver-policy.md `SDKErrorKind` union may not match runtime values (test-only verification)
**File:** `docs/semver-policy.md:15`
**Severity:** Major (potential drift, not visually verified)

The doc commits to: `'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'protocol' | 'rate-limit' | 'service' | 'internal' | 'tool' | 'validation' | 'unknown'` (12 values). I did not exhaustively verify these against the live `SDKErrorKind` definition at `packages/errors/src/...` in this review, so this is flagged for human verification. If new kinds were added (e.g. for batch processing or workspace) without a doc update, every release that touched errors becomes mis-labeled.

---


---

# MINOR

## MINOR — sdk-core


### MIN-1 — `web.ts:7` — empty interface extension is a type-alias smell
**File:** `packages/sdk/src/web.ts:7`
```ts
export interface WebGoodVibesSdkOptions extends BrowserGoodVibesSdkOptions {}
```
Use `export type WebGoodVibesSdkOptions = BrowserGoodVibesSdkOptions;` instead, or add an explicit forward-compatibility comment.

### MIN-2 — `expo.ts:7` — same empty-interface pattern
**File:** `packages/sdk/src/expo.ts:7`

### MIN-3 — `client.ts:339` — `as T` cast bypasses structural check on auth options
**File:** `packages/sdk/src/client.ts:324-340`

`createClientOptions<T extends OperatorSdkOptions | PeerSdkOptions>` returns `... as T;`. Because `OperatorSdkOptions` and `PeerSdkOptions` may diverge in future minor versions, the cast erases TS's structural verification. Replace with two named factory helpers (`makeOperatorOptions`, `makePeerOptions`) that return concrete types.

### MIN-4 — `auth.ts:287` — `as unknown as ControlPlaneAuthSnapshot` double-cast
**File:** `packages/sdk/src/auth.ts:287`

The `permissionResolver` accepts a public `GoodVibesCurrentAuth` and double-casts to a private `ControlPlaneAuthSnapshot`. If the two types share enough structure for this to be safe, alias them; if not, convert via a mapping helper rather than a TS-eraser cast.

### MIN-5 — `auth.ts:320` — inconsistent `await`/`return` style for delegated reads
**File:** `packages/sdk/src/auth.ts:316-321`

```ts
async getToken(): Promise<string | null> {
  if (ts) {
    return ts.getToken();        // returns Promise directly
  }
  return await readToken(null, getAuthToken);  // explicit await
}
```
Cosmetic inconsistency — pick one style.

### MIN-6 — `client.ts:434, 442` — assignment to lazy holder happens after construction, but code documentation claims `let` is required
**File:** `packages/sdk/src/client.ts:403-404, 434, 442`

The lazy `operatorRequestJson` / `peerRequestJson` pattern works but is fragile. A small helper class (e.g. `LazyTransport`) would make the dependency-cycle reasoning explicit and enable a single null-check point.

### MIN-7 — `auth.ts:303` — observer `from` field hardcodes `'token'` after login regardless of token semantics
**File:** `packages/sdk/src/auth.ts:307-313`

The transition records `to: 'token'`, but the SDK's `AuthStateKind` also distinguishes `'session'`. Login outcomes that produce a session cookie (rather than a long-lived token) are reported as `'token'`, which contradicts the `AuthStateKind` JSDoc at `observer/index.ts:30-32`. Either narrow the JSDoc or branch on the response shape.

### MIN-8 — `react-native.ts:69-73` — duplicates retry default literal from `browser.ts:55-59`
**File:** `packages/sdk/src/react-native.ts:69-73`, `packages/sdk/src/browser.ts:55-59`

Three separate places hard-code retry defaults (`maxAttempts: 3`, `baseDelayMs: 200|250`, `maxDelayMs: 1_500|2_000`). Extract to a `defaults.ts` constant table.

### MIN-9 — `workers.ts:118, 265` — `console.warn` fallbacks bypass the SDK observer
**File:** `packages/sdk/src/workers.ts:118, 265`

Cloudflare Workers don't have an injected logger; `console.warn` is the pragmatic choice. Still, when Cloudflare bindings provide `tail` logs, structured logging (`{ at: 'goodvibes-cf-worker', stage: 'queue', error }`) is far more actionable than a plain string.

### MIN-10 — `workers.ts:238` — silent `JSON.parse` fallback returns `{}`
**File:** `packages/sdk/src/workers.ts:236-241`

If the body is invalid JSON, `optionalJson` returns `{}`. The previous `body.trim() ? parse : {}` branch already handles empty body; the catch should at least 4xx the request rather than silently treating malformed JSON as empty.

### MIN-11 — `workers.ts:212` — `allowUnauthenticated === true` bypasses worker-token gate
**File:** `packages/sdk/src/workers.ts:212`

```ts
if (!expected && options.allowUnauthenticated === true) return null;
```
Documented as opt-in, but the option doesn't propagate to `requireWorkerAuth`'s caller — the bypass is silent. Emit a `console.warn` once at startup when this is enabled.

### MIN-12 — `agents/worktree.ts:115-119` — `_hasChanges` swallows `rev-list` errors as "no changes"
**File:** `packages/sdk/src/platform/agents/worktree.ts:107-120`

Logged at `logger.debug` only. A genuine git error (corrupt repo, permission issue) is indistinguishable from a brand-new branch with no commits. Promote to `logger.warn` and surface via the runtime bus.

### MIN-13 — `agents/worktree.ts:1` — `import { existsSync } from 'fs'` (sync)
**File:** `packages/sdk/src/platform/agents/worktree.ts:1, 82`

Used at line 82 to short-circuit cleanup. `fs.promises.access` would suffice and keep the file fully async.

### MIN-14 — `git/service.ts:205` — `@ts-expect-error` for simple-git 3-arg commit signature
**File:** `packages/sdk/src/platform/git/service.ts:205`

Long-standing simple-git typing gap. Track the upstream issue or wrap the cast in a small helper (`commitWithFlags`) so the suppression is local.

### MIN-15 — `tools/read/media.ts:323` — `new Function('specifier', 'return import(...)')` to dodge CJS rewrite
**File:** `packages/sdk/src/platform/tools/read/media.ts:319-336`

Intentional and well-commented, but it's still a CSP-incompatible escape hatch. Add a fallback path for environments where `Function` is blocked (Cloudflare Workers with a strict CSP, browser extensions, deno-strict).

### MIN-16 — `daemon/facade.ts:362-368` — `(this.replyPoller as unknown as { unref?: () => void }).unref?.()` pattern repeats
**File:** `packages/sdk/src/platform/daemon/facade.ts:367`, `platform/core/orchestrator.ts:488`, `platform/automation/manager-runtime.ts` (multiple `setInterval`/`setTimeout` sites)

The NodeJS.Timeout `unref` cast appears 5+ times. Extract a `unrefTimer(timer)` utility.

### MIN-17 — `daemon/facade.ts:363` — 2 second polling interval is a magic number
**File:** `packages/sdk/src/platform/daemon/facade.ts:368`

`}, 2_000);` — surface reply poller. Promote to a named constant `SURFACE_REPLY_POLL_INTERVAL_MS` co-located with other polling cadences.

### MIN-18 — `agents/orchestrator-runner.ts:30-36` — magic-ish constants block
**File:** `packages/sdk/src/platform/agents/orchestrator-runner.ts:30`

`MAX_TURNS = 50`, `NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]`, `RATE_LIMIT_RETRY_DELAY_MS = 60_000`, `RATE_LIMIT_MAX_RETRIES = 3`, `MAX_CHAT_RETRY_ITERATIONS = ... + 4`, `CONTEXT_COMPACT_THRESHOLD = 0.85`, `MIN_WINDOW_FOR_LLM_COMPACT = 12_000`. The `+ 4` on line 33 is unexplained — what does the 4 represent?

### MIN-19 — `client-auth/{ios,expo,android}-*.ts` — `console.warn` for keychain feature-detection mismatch
**File:** `packages/sdk/src/client-auth/ios-keychain-token-store.ts:181`, `expo-secure-token-store.ts:170`, `android-keystore-token-store.ts:210, 219`
**Severity:** Minor (Observability)

When the underlying keychain library doesn't expose a requested ACCESSIBLE / ACCESS_CONTROL key, the SDK falls back silently with a `console.warn`. These are exactly the events the `SDKObserver.onError` hook was designed for — route them through the observer (or a dedicated `onCapability` callback) so consumers can surface them in their telemetry.

### MIN-20 — `core/orchestrator.ts:483` — animation `setInterval(80ms)` runs unconditionally
**File:** `packages/sdk/src/platform/core/orchestrator.ts:483-490`

80 ms thinking-spinner timer is fine when a TTY is attached, but the orchestrator runs in headless contexts too. Skip the interval when `process.stdout.isTTY === false` to avoid 12.5 wakeups/sec on a long agent run.

### MIN-21 — `runtime/permissions/divergence-dashboard.ts` — large doc comment but `console.error` example at line 138 mixes JSDoc and runtime guidance
**File:** `packages/sdk/src/platform/runtime/permissions/divergence-dashboard.ts:138`

Harmless (it's a JSDoc example), but readers diff'ing for `console.error` pick this up as a real call.

### MIN-22 — `observer/index.ts:142-167` — `eslint-disable-next-line no-console` repeats four times
**File:** `packages/sdk/src/observer/index.ts:142, 148, 158, 165`

A single file-level `/* eslint-disable no-console */` would cut noise.

### MIN-23 — `workflow/trigger-executor.ts:243-246` — two `eslint-disable-next-line eqeqeq` for `==`/`!=`
**File:** `packages/sdk/src/platform/workflow/trigger-executor.ts:243, 245`

The trigger DSL deliberately allows loose equality. Add a comment block above the switch explaining *why* (DSL parity with operators users type) so future contributors don't "fix" it.

### MIN-24 — `platform/scheduler/scheduler.ts:1-3` — uses Node's `setTimeout` overflow constant in JSDoc
**File:** `packages/sdk/src/platform/scheduler/scheduler.ts:71`

`MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;` is a 24 h cap. The comment says "Node.js overflows at ~24.8 days" — the actual `setTimeout` max is `2^31 - 1 ms ≈ 24.855 d`. Picking 24 h trades reschedule overhead for safety; that trade-off should be in the comment, not just the magnitude.

### MIN-25 — `daemon/cli.ts:118` — `process.exit(0)` inside `shutdown` skips Node's natural drain
**File:** `packages/sdk/src/platform/daemon/cli.ts:116-119`

Calling `process.exit(0)` after `Promise.allSettled` aborts any still-pending I/O (open log streams, kafka producers, etc.). Use `process.exitCode = 0` and let the loop drain naturally.

### MIN-26 — `client.ts:299` — `requireBaseUrl` error message is overly long for a single-line `throw`
**File:** `packages/sdk/src/client.ts:296-302`

A 178-char line that includes example URL. Wrap or extract to a constant.

### MIN-27 — `web.ts:14-16` — function with brace-only body (no comment) for trivial wrapper
**File:** `packages/sdk/src/web.ts:14-16`

The one-line `createWebGoodVibesSdk` is fine, but in a public-surface file the JSDoc on line 9-11 is detached from the actual function — TypeScript JSDoc tooling won't propagate it. Move the doc-comment immediately above `export function createWebGoodVibesSdk(...)`.

### MIN-28 — `expo.ts:9-11` — same misplaced JSDoc as web.ts
**File:** `packages/sdk/src/expo.ts:9-11`

The `@example` block above `forSession` is actually documenting `createExpoGoodVibesSdk` two lines later. Either combine into a single block on the function or reorder.

### MIN-29 — `runtime/sandbox/qemu-wrapper-template.ts:52,57,72,...` — many loose `==` inside generated template
**File:** `packages/sdk/src/platform/runtime/sandbox/qemu-wrapper-template.ts:52, 57, 72, 125, 138, 208`

The file is a template string emitted into a guest VM; loose equality is fine. Add a top-level `// Template content — strict equality is intentionally avoided here for shell-script semantics.` so reviewers don't churn on it.

### MIN-30 — `agents/orchestrator-runner.ts:1-30` — 27 imports including 6 `import type` declarations
**File:** `packages/sdk/src/platform/agents/orchestrator-runner.ts:1-30`

Long import list signals the file is a coordinator. Combine into barrel imports per concern (`../runtime/index.js`, `../tools/index.js`).

---


## MINOR — packages


### MIN-1 — `composeMiddleware` recursion guard counts `i` not call depth

**File:** `packages/transport-core/src/middleware.ts:99-106`

```ts
if (i > MAX_MIDDLEWARE_DEPTH) { throw ... 'recursion exceeded' }
```

`i` is the chain index, not a recursion counter. With `MAX_MIDDLEWARE_DEPTH=128`, the line-89 length guard already prevents `i` from exceeding 128 in the normal forward walk. The guard fires only via the `if (i <= index)` path, which throws a different error first. The check is effectively dead.

Fix: either remove the dead guard or repurpose it to count actual `dispatch` invocations (re-entrant calls) rather than reusing `i`.

### MIN-2 — `firstJsonSchemaFailure` does not pass `_depth` into recursive object/array branches

**File:** `packages/transport-http/src/client-plumbing.ts:142-176`

The outer call sites correctly pass `_depth + 1` into `allOf`/`anyOf`/`oneOf` recursion (lines 94/99/104), but the array-item recursion on line 146 and the property recursion on line 167 omit the `_depth` argument, defaulting to `0`. A schema with deeply nested object properties via `allOf` then `properties` can bypass `MAX_SCHEMA_WALK_DEPTH=32` because depth resets each time recursion hops through a property.

Fix: pass `_depth + 1` consistently into every recursive call.

### MIN-3 — `WebSocketTransportError` `Symbol.hasInstance` accepts arbitrary `WS_*` codes

**File:** `packages/transport-realtime/src/runtime-events.ts:125-139`

The instance brand passes for any code starting with `WS_`. A plain object `{ code: 'WS_FOO_BAR' }` paired with the GoodVibesSdkError brand would pass. The base brand (`Symbol.for('pellux.goodvibes.sdk.error')`) requires the symbol be set, which guards against plain objects, but a constructed `GoodVibesSdkError` with code `WS_*` (a hand-thrown SDK error that happens to use that prefix) would falsely register as a `WebSocketTransportError`.

Fix: replace the prefix check with an explicit allowlist matching the comment on lines 113-116 (`WS_CLOSE_ABNORMAL`, `WS_EVENT_ERROR`, `WS_QUEUE_OVERFLOW`, `WS_REMOTE_ERROR`, `WS_FRAME_TOO_LARGE`).

### MIN-4 — `normalizeBaseUrl` accepts any protocol that starts with `http`/`ws`

**File:** `packages/transport-http/src/paths.ts:48-55`

The protocol check is correct (`http:`, `https:`, `ws:`, `wss:`). However `buildWebSocketUrl` in `runtime-events.ts:182-203` calls `normalizeBaseUrl` and then mutates `url.protocol`, throwing on unsupported. Two places enforce the same rule with subtly different error messages and codes — refactoring one forgets the other.

Fix: extract a single `normalizeWebSocketBaseUrl` helper, or have `buildWebSocketUrl` reuse the protocol set and error from `paths.ts`.

### MIN-5 — `addQueryValue` JSON-stringifies object query params, drifting from server expectation

**File:** `packages/transport-http/src/http-core.ts:199-221`

The comment on lines 211-216 acknowledges the issue: object query values are emitted as `JSON.stringify(value)`, which servers must JSON-parse back. No daemon route in `daemon-sdk/src/*-routes.ts` actually parses object-shaped query strings, so any contract that allows object query values is silently broken end-to-end. Consumers cannot tell from types alone.

Fix: throw `ContractError` for object query values rather than silently serialising, or document the contract requirement ("query parameters must be primitive or repeated primitive") and validate at the contract layer.

### MIN-6 — `inferCategoryFromMessage` regex set runs on user-provided error strings

**File:** `packages/daemon-sdk/src/error-response.ts:141-160`

The length cap (`MAX_INFER_MESSAGE_LENGTH=2000`) protects against catastrophic regex blow-up but not regex backtracking on adversarial sub-2000 char strings. The patterns are simple alternations so unlikely to ReDoS, but the function is called on every error response built from any thrown value, and several patterns use `\s` and `?` quantifiers that with crafted input could allocate noticeably. Fingerprintable: a caller can probe which category their error message lands in.

Fix: pre-anchor with `\b` boundaries (already done for some patterns) and add a fast-path lookup table (e.g. `Set<string>` of common error codes) before falling through to regex.

### MIN-7 — `splitContractInput` regex allows leading digits via `[A-Za-z_]`

**File:** `packages/transport-http/src/http-core.ts:233`

The path-param matcher `\{([A-Za-z_][A-Za-z0-9_.-]*)\}` is fine, but the post-check on line 242 only flags unbalanced braces (`/[{}]/`). Names containing dots like `{foo.bar}` are accepted and treated as flat keys against `remaining["foo.bar"]` rather than nested. No daemon contract uses dotted path params, so this is latent — but the type system doesn't prevent contract authors from emitting one.

Fix: forbid `.` in path-param names (`[A-Za-z_][A-Za-z0-9_-]*`) and call this out in the contract generator.

### MIN-8 — `validateJsonSchemaResponse` runs even when typed-schema validation succeeded

**File:** `packages/operator-sdk/src/client-core.ts:194-205`

When `schema` is provided (Zod), `invokeContractRoute` validates the body and returns it. Then the `.then()` callback checks `if (!schema && clientOptions.validateResponses !== false) validateJsonSchemaResponse(method, body)` — fine. But when `validateResponses: false` and `getResponseSchema` returns `undefined` AND a per-call `responseSchema` is supplied, the JSON-schema fallback is skipped (correct). When `validateResponses: true` is the default and `getResponseSchema` returns a Zod schema, JSON-schema validation is also skipped (correct, double-validation avoided). The control flow is correct but easy to break — there's no test asserting the four-state matrix (typed-schema × json-schema × validateResponses × per-call override).

Fix: add a brief truth table comment above the call, or refactor to a `decideValidator` function that returns the single validator to apply.

### MIN-9 — `_methodIdToSchemaName` silently produces wrong names for IDs with consecutive underscores

**File:** `packages/operator-sdk/src/client.ts:65-72`

`'foo__bar.baz'.split('.').flatMap(s => s.split('_'))` → `['foo','','bar','baz']`, mapped to `['Foo','','Bar','Baz']`, joined to `'FooBarBaz'`. The empty string round-trips to empty PascalCase chunk — no error, just an invisible collapse. If two contract IDs differ only by a `__` vs `_` segment, they collide silently in the registry.

Fix: throw if any segment is empty, since contract IDs should never contain `__` or leading/trailing `_`.

---


## MINOR — tests


### MIN-01 — `test/smoke.test.ts:15` regex `^0\.\d+\.\d+$` rejects valid prerelease versions
When the SDK enters a `0.x.y-rc.1` release branch, this regex will fail. Prefer `/^\d+\.\d+\.\d+(-[\w.]+)?$/` or use `semver.valid()`.

### MIN-02 — `test/version-sync.test.ts:13` regex parses TS source
Reading `version.ts` with `match(/let version = '([^']+)'/)` is brittle. If someone reformats to `let version = "…"` or template literal, the test breaks despite no behaviour change. Either import the module and read `FOUNDATION_METADATA.productVersion`, or generate `version.ts` from a JSON sidecar that the test can `JSON.parse`.

### MIN-03 — Hermes runner asserts `Object.hasOwn` exists then exits — but a generic `expect(...).toBe(...)` runner may be too lax
**File:** `test/hermes/hermes-runner.js:60-110`

The inline `expect()` shim only supports a handful of matchers (`toBe`, `toEqual`, `toBeDefined`, `toBeNull`, `toBeTruthy`, `toBeFalsy`, `toBeInstanceOf`, `toThrow`, `toContain`). Several Hermes test cases would benefit from `toMatch(regex)` (line 178 lookbehind test still does `match[0] === 'bar'` and verifies the array index manually). It's not buggy, but the shim could `print(...)` the failing actual/expected when matcher missing instead of silently degrading.

### MIN-04 — `test/perf-07-interval-unref.test.ts:67` uses `node:fs/promises#glob`
`glob` from `node:fs/promises` was added in Node 22 and is still experimental in some runners. CI matrix should pin Node ≥22 explicitly. Alternative: use the existing `precision_glob`-equivalent in `bun` builtins or `globby`.

### MIN-05 — `test/scan-modes.test.ts` — fixture content includes `console.log('I am unreferenced')`
**File:** `test/scan-modes.test.ts:108, 114, 140`

The fixture functions log to console; if run under a reporter that captures stdout, the test logs leak into reporter output. Fixture should use a pure expression like `Math.PI * 2` or a no-op.

### MIN-06 — `test/observer-coverage.test.ts:93` — the `String(capture.messages[0][0])` chain converts `unknown` via `String()` which can mask bugs in upstream stringification
If a future console-observer ever passes an object with a custom `toString`, `String(obj)` returns `[object Object]` and the regex `/rate-limit/` may fail in surprising ways. Prefer `expect(capture.messages[0][0]).toContain('rate-limit')` and let bun's matcher format the diff.

### MIN-07 — `test/auth-auto-refresh-transport-integration.test.ts:9` carries discipline pledge as a comment
The header comment (`Wave 6/8 discipline: exact literal assertions, no regex unions, no auto-pass, no \`.catch(() => {})\`, no \`test.skip\`, no \`test.todo\``) is human-enforceable only. The `scripts/no-skipped-tests.ts` linter (`scripts/no-skipped-tests.ts:8`) only blocks `(?:describe|test|it)\.(?:skip|todo)` — not `.catch(() => {})` or regex unions. The pledge is enforced by humans, not by a script. Either add lint rules or drop the prose claim.

### MIN-08 — `test/_helpers/router-requests.ts` is 14 lines and only abstracts `JSON.stringify`
The helper saves ~3 lines per test caller. With 100+ call sites it's worth keeping, but the file's 5-line docstring (lines 1-6) outweighs the implementation. Consolidate into `_helpers/index.ts` with one-line exports.

### MIN-09 — `test/types/typed-client-usage.ts` uses `void` operator to suppress unused-var warnings
Lines 41-45 do `void token; void authenticated; …`. This file is invoked via `bun run types:check` (`package.json:42`) and the `void`s are an unusual idiom; a `// @ts-expect-error unused` or simple destructure-with-rest would be more idiomatic. Not a defect, just an inconsistency with the rest of the test suite which uses `_` prefix for unused.

### MIN-10 — `test/integration/_shared/arbitraries.ts` is 605 LOC and 43KB
Does not use lazy fast-check generators where it could (e.g. for events that are never sampled in some tests). Could drop ~20% by using `fc.option(arb)` instead of explicitly building unions of `arb` and `null`.

### MIN-11 — `test/version-consistency.test.ts:11` invokes `spawnSync('bun', [SCRIPT])` without forcing pristine env
The child inherits CWD and full process env. If a developer has `WORKSPACE_PACKAGES_JSON` set in their shell, the "green" test exits 0 not because the workspace is consistent but because of the leaked env. Test 2 (line 49-54) also passes `...process.env` explicitly which inherits anything. Pin to a minimal env.

### MIN-12 — `test/workers/workers.test.ts:64-83` relies on `bunx esbuild` from PATH at test time
If the lock-file's esbuild differs from the shell's `bunx` cache, tests can use unexpected versions. Pin via `node_modules/.bin/esbuild` or a Bun.build call.

### MIN-13 — `test/workers/workers.test.ts:248-257` test "EventSource availability (Miniflare injects it, real Workers does not)" only asserts `globals.EventSource === true`
The test name documents a gap that is impossible to verify locally, then asserts the trivial truth. A reviewer reading the title expects the test to demonstrate production absence; instead it pins the local present-ness. Rename to something honest like "EventSource is injected by Miniflare" and move the production-gap doc to FINDINGS.md only.

### MIN-14 — `test/workers-wrangler/wrangler.test.ts:159` — `setTimeout` in `sleep()` keeps process alive without `.unref()`
Line 159: `const timer = setTimeout(resolve, ms); timer.unref?.();` — actually it DOES unref. False alarm; this is correct. (Self-correction; leaving the entry to document I checked.)

### MIN-15 — `test/auth-auto-refresh.test.ts` 21 occurrences of `Date.now()` reads despite `installFrozenNow`
**File:** `test/auth-auto-refresh.test.ts:84, 101, 122, 171, 190, 226, 260, 302, 340, 363, 376, 437, 461, 501, 510, 520, 529, 545, 558, 568, 569`

The suite installs `installFrozenNow(TEST_NOW_MS)` in `beforeEach` (line 30) so every `Date.now()` returns the frozen value. The 21 reads are legitimate (asserting expirations are computed off the frozen clock), but it would be cleaner to read `TEST_NOW_MS` directly to make the dependence on the frozen clock obvious. Currently it looks like wall-clock reads.

### MIN-16 — Two test files still hand-roll `console.log`/`console.debug` overrides instead of using `_helpers/test-timeout.ts#captureConsole`
`captureConsole` exists at `test/_helpers/test-timeout.ts:52-64` and `test/observer-coverage.test.ts` was migrated. Confirm any remaining hand-rolled overrides are migrated. Search for `console.debug =` returned only the migrated file; this is mostly cleaned up. Mark closed unless other instances exist.

### MIN-17 — `test/sdk-platforms.test.ts` mutates `globalThis.location` (lines 36, 55)
Uses `previousLocation = globalThis.location; globalThis.location = ...; … globalThis.location = previousLocation`. Without a `try/finally`, a thrown assertion leaves `globalThis.location` in the stub state — the next test in the file (or in the next file under Bun's parallel-by-default execution) may observe the leak. Wrap in `try/finally`.

### MIN-18 — `provider-routes-secrets-skipped.test.ts:74-92` uses two near-identical tests that differ only by `null` vs `undefined`
Both tests assert `secretsResolutionSkipped: true`. Could be `it.each([['null', null], ['undefined', undefined]])`. Minor DRY.

---


## MINOR — docs+examples


### MIN-001 — README capabilities table is duplicated by `docs/packages.md` and `getting-started.md`

- File: `README.md:124-145`, `docs/getting-started.md:212-221`, `docs/packages.md:13-24`
- Evidence: same table of entrypoints, three different shapes, slightly different prose. Minor drift potential.
- Fix: pick one canonical doc and have the other two link to it.

### MIN-002 — `examples/operator-http-quickstart.mjs:1-2` minimal docstring

- File: `examples/operator-http-quickstart.mjs:1-3`
- Evidence: example is missing the prerequisites/run sections that `submit-turn-quickstart.mjs` has. Inconsistent docstring quality across the example set.
- Fix: add a uniform header (purpose, prerequisites, run command).

### MIN-003 — Inline JSDoc absent on most `examples/*.mjs|.ts` exports

- File: `examples/auth-login-and-token-store.ts`, `examples/realtime-events-quickstart.mjs`, etc.
- Evidence: most examples have a one-line file-level docstring and no per-function comments. For runnable examples that is usually fine; but `examples/daemon-fetch-handler-quickstart.ts` exports `handleRequest` without a JSDoc.
- Fix: add a one-line JSDoc to exported symbols in examples, or delete the export when it’s only an example.

### MIN-004 — Code-block language tags inconsistent

- File: `examples/README.md:6` uses `sh`; most other docs use `bash`.
- File: `pairing.md:50-58` uses `json`, but the docs commonly use no tag for embedded JSON snippets.
- Fix: standardize on `bash` for shell, `ts` for TypeScript, `json` for JSON.

### MIN-005 — Mixed terminology: "GoodVibes SDK" vs "goodvibes-sdk" vs "@pellux/goodvibes-sdk"

- File: README, CHANGELOG, multiple docs.
- Evidence: `README.md:1` "GoodVibes SDK"; `CONTRIBUTING.md:5` "`goodvibes-sdk` is a standalone TypeScript SDK workspace" (refers to repo); `package.json:2` `"name": "goodvibes-sdk"` (workspace root). The published package is `@pellux/goodvibes-sdk`. Three names floating around makes it unclear what the canonical brand string is.
- Fix: pick a single brand string for prose and stick to it; reserve `@pellux/goodvibes-sdk` for code, "GoodVibes SDK" for prose.

### MIN-006 — `examples/peer-http-quickstart.mjs:11` shape vs `examples/operator-http-quickstart.mjs:11` shape

- File: `examples/peer-http-quickstart.mjs:11`, `examples/operator-http-quickstart.mjs:11`
- Evidence: peer SDK uses `sdk.operator.snapshot()` (one level deep), operator SDK uses `sdk.operator.control.snapshot()` (two levels deep). Both correct against source. But the symmetry is misleading: a reader may assume the peer SDK is missing `control`. Add a one-line comment in `peer-http-quickstart.mjs` clarifying that the peer client surface has its `operator` namespace at the top level, not nested under `control`.

### MIN-007 — `troubleshooting.md:5` claim about "or use the browser/web entrypoint" depends on `location.origin`

- File: `docs/troubleshooting.md:5`
- Evidence: `createWebGoodVibesSdk(options: WebGoodVibesSdkOptions = {})` (`packages/sdk/src/web.ts:14`) — requires verification that this default actually reads `location.origin`. If yes, fine. If no, the troubleshooting hint is wrong.
- Action: trace the default `baseUrl` resolution in `web.ts`/`browser.ts` and confirm.

### MIN-008 — `getting-started.md:13` and `defaults.md:6` both reference HTTP retry behavior; thresholds differ slightly

- File: `docs/getting-started.md:127`, `docs/defaults.md:9-17`
- Evidence: `defaults.md` has the authoritative default table. `retries-and-reconnect.md:11-23` shows an example with `maxAttempts: 4`, `baseDelayMs: 250`, `maxDelayMs: 2_500`. Clarifies it is opt-in. OK individually. Cross-doc cohesion would be improved by linking from `getting-started.md` to `defaults.md`.

### MIN-009 — `pairing.md:80` and `pairing.md:307` use different capitalization for `'com.example.gv'` vs `'com.example.goodvibes'`

- File: `docs/pairing.md:182, 307`
- Evidence: cosmetic.
- Fix: pick one example bundle id.

### MIN-010 — `submit-turn-quickstart.mjs` has the only quickstart with a 60s safety timeout

- File: `examples/submit-turn-quickstart.mjs:59-63`
- Evidence: other quickstarts (`realtime-events-quickstart.mjs`, `retry-and-reconnect.mjs`) use unconditional `setTimeout` and `unref()`. The submit-turn example races a Promise. Inconsistent shutdown patterns across examples.
- Fix: pick one cleanup pattern and use it across all `.mjs` quickstarts.

### MIN-011 — `getting-started.md:51` sample is one line of import with no usage

- File: `docs/getting-started.md:50-52`
- Evidence: shows `import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-sdk/daemon';` and stops. Verified that `dispatchDaemonApiRoutes` is exported from `@pellux/goodvibes-daemon-sdk:27` and re-exported via `packages/sdk/src/daemon.ts:1` (`export * from '@pellux/goodvibes-daemon-sdk';`). Import is valid. But the doc gives no usage; readers must follow the example file. Add a one-line code completion or a link directly to `daemon-fetch-handler-quickstart.ts`.

### MIN-012 — `surfaces.md:64` enforcement claim mentions `test/rn-bundle-node-imports.test.ts`; verify path

- File: `docs/surfaces.md:64`
- Evidence: claim is reasonable; no source evidence cited here. Spot-check that the test file exists at the path claimed. If it has been moved, update.

### MIN-013 — `defaults.md:118-127` cites `DEFAULT_WS_MAX_ATTEMPTS` with no evidence path

- File: `docs/defaults.md:122`
- Evidence: doc cites `DEFAULT_WS_MAX_ATTEMPTS` but does not state which file owns it; the package is `@pellux/goodvibes-sdk/transport-realtime`. Add a `(source: ...)` note for each table for traceability.

### MIN-014 — `error-kinds.md:202` recommends `err.kind` for retry guidance, but the kind table marks `service: Sometimes`, while `error-handling.md:28-31` switches on `service` and treats it like `network`

- File: `docs/error-kinds.md:106-112`, `docs/error-handling.md:27-31`
- Evidence: minor mismatch — `error-handling.md` collapses `network|service` into one branch with `if (err.recoverable)`. That is fine semantically, but the doc collapses two `kind` values on one line, and a reader scanning for `service` sees `network` as well. Cosmetic.

### MIN-015 — `web-ui-integration.md:30-32` says `/browser` and `/web` are equivalent; `surfaces.md:38` says they share the same runtime contract

- File: `docs/web-ui-integration.md:30-32`, `docs/surfaces.md:38`
- Evidence: confirmed by reading `packages/sdk/src/{browser,web}.ts` — both build the SDK; only the option-defaults differ. Doc is internally consistent on this point.

### MIN-016 — `pairing.md:305` parenthetical aside lives inside a code block that won’t typecheck

- File: `docs/pairing.md:301-323`
- Evidence: code block declares `tokenStore = createIOSKeychainTokenStore({ service: 'com.example.goodvibes' })` and the surrounding comment claims `createAndroidKeystoreTokenStore` exists too. Both are real (`packages/sdk/src/react-native.ts:127,134`).
- No defect, just a note: this code is presented as runnable in a React Native app context but the prose is ambiguous about whether `usePairedSdk` re-creates the SDK each call.

### MIN-017 — `companion-message-routing.md:138` calls out a route enumeration but instructs running `GET /api/control-plane/methods` — duplicates `tools.md` / `reference-operator.md`

- File: `docs/companion-message-routing.md:138`
- Evidence: cosmetic.

### MIN-018 — `CHANGELOG.md` `0.30.3` section dated `2026-05-03` — same date as `0.30.2` and `0.30.1`

- File: `CHANGELOG.md:23,54,88`
- Evidence: three patch releases stamped the same day. That is permitted, but unusual. If real, fine. If the dates were copied without updating, fix.

### MIN-019 — `examples/auth-login-and-token-store.ts:14-17` hardcodes `username: 'local-user'` and `password: 'local-password'` as defaults

- File: `examples/auth-login-and-token-store.ts:14-17`
- Evidence: literal credentials in the source. Even with `process.env.GOODVIBES_USERNAME ?? 'local-user'` the fallback is a literal credential pair. Per `examples/README.md:11-13` and `auth.md:56`: "Examples must not print tokens or hardcode real credentials. Test credentials should be local placeholders or environment-driven." These are placeholders, not real, but a code scanner sees `password: ... = '...'` and may flag it.
- Fix: drop the fallback and require the env vars; or use sentinel `'<set GOODVIBES_USERNAME>'`.

### MIN-020 — `daemon-fetch-handler-quickstart.ts:23` returns SSE without a real stream

- File: `examples/daemon-fetch-handler-quickstart.ts:23-25`
- Evidence: returns a single `event: ready\ndata: {"ok":true}` chunk. Acceptable as a placeholder but the surrounding prose calls this a "minimal example" — readers may assume this is a viable production stream. Add a `// PLACEHOLDER:` marker.

---


## MINOR — build+CI+config


### MIN-001 — `tsconfig.base.json` does not enable `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, or `noImplicitOverride`
**File:** `tsconfig.base.json:13-22`

`strict: true` is on, but the strict-adjacent flags that catch high-value bugs are off. For a publicly published SDK this is below state-of-the-art.

**Fix:** Audit and enable progressively.

---

### MIN-002 — `tsconfig.base.json` lib includes `ESNext.Disposable` with `target: ES2024`
**File:** `tsconfig.base.json:3,11`

The comment explains why (Symbol.dispose stubs without changing emit), but `lib: ["ES2024", "ESNext.Disposable"]` will silently start emitting newer features if a future TS compiler reinterprets `ESNext.Disposable` as inheriting from `ESNext`. Lock to the explicit lib list `"ES2023.Disposable"` once available, or add a comment noting the version that was tested.

---

### MIN-003 — `api-extractor.json` silences `ae-missing-release-tag` globally
**File:** `api-extractor.json:59-61`

```json
"ae-missing-release-tag": { "logLevel": "none" }
```
For a public SDK, missing `@public`/`@beta`/`@alpha` tags should at minimum be a warning. Setting to `none` permanently means new exports never get release-tagged.

**Fix:** Set to `"warning"` once existing exports are tagged.

---

### MIN-004 — `bundle-budget.ts:147-149` runs `bun run build` if `--build` flag is passed AND dist is stale, but no warning if dist is missing AND `--build` was not passed (silent rebuild)
**File:** `scripts/bundle-budget.ts:144-155`

Lines 144-146 silently call `runBuild()` when dist is missing. CI relies on the artifact being present from the upstream `build` job — silently rebuilding masks an artifact-download failure. A failed download would result in an unrelated build running, possibly with stale source, and the budget check would pass against the wrong bytes.

**Fix:** Add a `--no-build` flag (used in CI) that errors instead of rebuilding when dist is missing. CI's `bundle-budget-check` job should pass `--no-build` to enforce "check the downloaded artifact only".

---

### MIN-005 — `flake-detect.ts` uses `process.env['FLAKE_RUNS']` access without explicit non-null check before `parseInt`
**File:** `scripts/flake-detect.ts:31-42`

```ts
const env = process.env['FLAKE_RUNS'];
if (env !== undefined) {
  const n = parseInt(env, 10);
  if (!Number.isInteger(n) || n < 1) { … exit 1 }
  return n;
}
return 5;
```
Fine in practice. But `parseInt('3abc', 10)` returns 3 (valid) — `FLAKE_RUNS=3abc` would silently accept 3. Use `Number.parseInt` with explicit check that `String(n) === env.trim()`.

---

### MIN-006 — `release-shared.ts:101 shouldCopyPath` only excludes `node_modules`, not `.git` / `dist` / cache dirs
**File:** `scripts/release-shared.ts:100-102`

```ts
function shouldCopyPath(path: string): boolean {
  return !path.split('/').includes('node_modules');
}
```
Staging copies the whole package directory; if a source dir contains `.tsbuildinfo` or stale `dist/` from a prior build that wasn't cleaned, those land in the staged tarball before the published `package.json` `files:` filter is applied at `npm publish` time. This is double-mitigated by `files:` in each manifest, but defense-in-depth says the staging copy should also exclude `.git`, `coverage/`, `*.tsbuildinfo`.

**Fix:** Expand exclusions:
```ts
function shouldCopyPath(path: string): boolean {
  const parts = path.split('/');
  return !parts.some((p) => p === 'node_modules' || p === '.git' || p === 'coverage') && !path.endsWith('.tsbuildinfo');
}
```

---

### MIN-007 — `release.yml:218-237` changelog excerpt extraction uses awk regex with version directly interpolated
**File:** `.github/workflows/release.yml:218-237`

```yaml
- name: Extract version
  id: version
  run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
…
- name: Extract changelog excerpt
  run: |
    VERSION="${{ steps.version.outputs.version }}"
    …
    EXCERPT=$(awk -v version="$VERSION" '…' CHANGELOG.md)
```
The `${{ steps.version.outputs.version }}` interpolation is in a `run:` block. `version` is sourced from `GITHUB_REF_NAME` (controlled — only repo collaborators with write access can push tags), so this is not user-controllable injection. However, GitHub's recommendation is to **never** inline `${{ }}` into a shell `run:` block — always use `env:`. A malicious tag like `v1; rm -rf /` would not be caught at the verify-tag-version step (which only checks `tagName === expectedTag`, not shape).

**Fix:**
```yaml
- name: Extract changelog excerpt
  env:
    VERSION: ${{ steps.version.outputs.version }}
  run: |
    RELEASE_DOC="docs/releases/${VERSION}.md"
    …
```

---

### MIN-008 — `release.yml:154` uses `format()` to build env value with `github.repository_owner` interpolation in `env:` block — fine, but inconsistent with the rest of the workflow
**File:** `.github/workflows/release.yml:153-155`

```yaml
env:
  GOODVIBES_PUBLIC_PACKAGE_NAME: ${{ format('@{0}/goodvibes-sdk', github.repository_owner) }}
```
This is a job-level env. `github.repository_owner` is GitHub-controlled, not user-controlled, so safe. Note for documentation: a fork running this workflow would publish under `@<fork-owner>/goodvibes-sdk`, which is intentional but should be documented.

---

### MIN-009 — `verify-published-packages.ts:12-19` env-var validation is duplicated
**File:** `scripts/verify-published-packages.ts:12-19`

```ts
const MAX_ATTEMPTS = Number.parseInt(process.env.GOODVIBES_VERIFY_ATTEMPTS || '48', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.GOODVIBES_VERIFY_DELAY_MS || '5000', 10);
if (!Number.isInteger(MAX_ATTEMPTS) || MAX_ATTEMPTS <= 0) { throw … }
if (!Number.isInteger(RETRY_DELAY_MS) || RETRY_DELAY_MS <= 0) { throw … }
```
Good validation. Minor: `Number.parseInt('48abc', 10) === 48` so `GOODVIBES_VERIFY_ATTEMPTS=48abc` silently passes. Use stricter regex check `/^\d+$/` first.

---

### MIN-010 — `sbom-generate.ts:55-56` PATH split tolerates Windows but other scripts don't
**File:** `scripts/sbom-generate.ts:55, 117` (`process.platform === 'win32'`)

`sbom-generate.ts` handles Windows; `bundle-budget.ts`, `flake-detect.ts`, `release-shared.ts` (which uses `tar -xOf`) implicitly assume POSIX. The `tar` invocation in `release-shared.ts:309, 318, 329` requires GNU/BSD tar; Windows users running release tooling will fail mysteriously.

**Fix:** Document Windows non-support in `docs/release-and-publishing.md`, or use a JS-native tar parser (`tar` npm package) for cross-platform.

---

### MIN-011 — `package.json:60` `types:resolution-check` runs `release:dry-run` (full publish staging) when only `attw` is needed
**File:** `package.json:60`

```json
"types:resolution-check": "bun run release:dry-run && bunx attw --pack packages/sdk --ignore-rules no-resolution cjs-resolves-to-esm"
```
Full dry-run takes minutes; just running `attw --pack` directly takes seconds. The dry-run dependency makes the script slow.

**Fix:** Drop `release:dry-run` from this script — the `pack:check` script already validates pack output. CI runs `bunx attw --pack packages/sdk` directly (ci.yml:197).

---

### MIN-012 — `examples/typecheck` invoked from validate but not from CI's `examples-typecheck` matrix-job dependencies
**Files:** `scripts/validate.ts:25`, `.github/workflows/ci.yml:140-152`

Validate runs `bun run --cwd examples typecheck`. CI's separate `examples-typecheck` job duplicates this. Two run. Slow.

**Fix:** Either remove from `validate.ts` (rely on CI matrix) or remove the CI job. Currently both block CI green light.

---

### MIN-013 — No `.nvmrc` file, no `bunfig.toml`, no `.npmignore`
**Files:** absent

- No `.nvmrc` despite Node engine constraint. Tools like `nvm`/`fnm` cannot auto-switch.
- No `bunfig.toml` despite `packageManager: bun@1.3.10`. Default Bun config is used silently.
- No root `.npmignore`. The publish flow stages individual packages so it isn't critical, but absence means accidental `npm publish` from root would publish whatever is in `files:` of the root manifest — root is `private: true` (package.json:3) so this is mitigated.

**Fix:** Add `.nvmrc` matching `engines.node` minimum (`22` or `20.18` based on policy). Optional: add `bunfig.toml` to lock install behavior.

---

### MIN-014 — `.gitignore:7` `sbom.cdx.json*` glob will also ignore `sbom.cdx.json.bak` etc.
**File:** `.gitignore:7`

`sbom.cdx.json*` is intentionally broad. Fine but worth noting — collateral matches.

---

### MIN-015 — `dependabot.yml:20-33` opens up to 2 GitHub-actions PRs but groups all minor/major together
**File:** `.github/dependabot.yml:21-36`

The `github-actions` group includes both minor AND major updates. A major action upgrade (e.g. `actions/checkout@v6` removing a feature) would be grouped with safe minor bumps and merged together, masking the breaking change.

**Fix:** Split major into its own group:
```yaml
github-actions-major:
  update-types: ["version-update:semver-major"]
github-actions-minor:
  update-types: ["version-update:semver-minor"]
```

---

### MIN-016 — `dependabot.yml` does not include `vendor/bash-language-server` or `vendor/uuid-cjs` in any update tracking
**Files:** `package.json:107-121` (vendored), `.github/dependabot.yml`

The vendored copies will silently fall behind upstream. There's no automation to detect when bash-language-server v5.7+ ships and the vendored copy needs refresh. Currently a manual concern documented in `vendor/bash-language-server/GOODVIBES_PATCH.md`.

**Fix:** Add a scheduled workflow that pings npm for bash-language-server upstream and opens a tracking issue, OR add a comment in `package.json` overrides linking to the vendor refresh runbook.

---

### MIN-017 — `tsconfig.json` (root) declares `composite: true` on a project with `files: []` and only references — the `composite` flag has no effect here
**File:** `tsconfig.json:3`

`composite: true` requires `files`/`include` to be non-empty to actually compose. With `files: []` this is a no-op. Cosmetic.

---

### MIN-018 — `release-shared.ts:339` `escapeRegExp` excludes `-` and `+` (not used in regex special) but also skips `/` — fine but inconsistent with other regex escapes in codebase
**File:** `scripts/release-shared.ts:340-342`

Regex `[.*+?^${}()|[\]\\]` is correct for JS regex special chars. Cosmetic.

---

### MIN-019 — `bundle-budget.ts:144-155` warning text says "may be stale" when it is unambiguously stale
**File:** `scripts/bundle-budget.ts:151-154`

`isStale()` (line 69-74) compares mtimes deterministically. The user-facing string `WARN: dist/ may be stale` should be `dist/ is stale`.

---

### MIN-020 — `verdaccio-dry-run.ts:362-446` cleanup duplicates between `cleanup()` and the `main().catch()` handler
**File:** `scripts/verdaccio-dry-run.ts:380-393, 429-441`

The `cleanup()` function and the `.catch()` handler both call `removePathBestEffort` for storage/config dirs. If main throws after `cleanup()` runs but before the verdaccio `stop()` resolves, double cleanup occurs (mitigated by `force: true`, but ugly).

---


## MINOR — public surface


### MIN-01 — Capability entrypoint registry covers only 8 of 28 platform subpaths
**File:** `packages/sdk/src/platform/node/capabilities.ts:38-46`
**Severity:** Minor (Incomplete metadata)

`GOODVIBES_NODE_RUNTIME_ENTRYPOINTS` lists 7 paths: `/platform`, `/platform/node`, `/platform/runtime`, `/platform/knowledge`, `/platform/providers`, `/platform/tools`, `/platform/integrations`. The actual exports map exposes 28+ `./platform/...` subpaths (config, core, daemon, git, intelligence, knowledge/extensions, knowledge/home-graph, multimodal, node/runtime-boundary, pairing, runtime/observability, runtime/state, runtime/store, runtime/ui, utils, voice). Tests at `test/sdk-runtime-boundaries.test.ts:45-47` only verify each capability entrypoint is in the exports map — they don't verify the inverse (that every node-only export is in a capability registry).

**Fix path:** Either expand the registry to exhaustively cover the export surface, or add a doc comment clarifying that the registry is a curated subset.

### MIN-02 — runtime-boundaries test forbids `platform/node` substring in client files but allows `platform/node/runtime-boundary` re-export
**File:** `test/sdk-runtime-boundaries.test.ts:83`
**Severity:** Minor (Test regex is brittle)

The regex `/\bfrom ['"]node:|import\(['"]node:|platform\/node/` matches the substring `platform/node` anywhere. This will reject any future client-safe re-export from `@pellux/goodvibes-sdk/platform/node/runtime-boundary` even though that subpath is intentionally split out (per `package.json:158-161`) precisely because `runtime-boundary.ts` is client-safe (`packages/sdk/src/platform/node/runtime-boundary.ts:1-57` only imports `@pellux/goodvibes-errors` and uses `globalThis`). The split is currently unused by client files, so the test doesn't fail today, but it constrains future ergonomic improvements.

**Fix path:** Tighten regex to `\bfrom ['"]node:|import\(['"]node:|platform\/node\/(?!runtime-boundary)|platform\/node['"]/` so the runtime-boundary subpath remains importable from client surfaces.

### MIN-03 — `platform/runtime/ui` resolves to a file named `ui-surface.d.ts`, not `ui/index.d.ts`
**File:** `packages/sdk/package.json:186-189`
**Severity:** Minor (Resolution surprise)

```json
"./platform/runtime/ui": {
  "types": "./dist/platform/runtime/ui-surface.d.ts",
  "import": "./dist/platform/runtime/ui-surface.js"
}
```

Every other `./platform/runtime/<x>` subpath resolves to either `<x>.d.ts` or `<x>/index.d.ts`. This one resolves to a deliberately renamed `ui-surface` file because `dist/platform/runtime/ui/` is also a directory (model-picker, provider-health subdirs). The mapping works, but the inconsistency makes audits harder. The bundle-budgets entry (`bundle-budgets.json:142-145`) and api-extractor are unaffected, but the public-surface.md entry implies the path is `./platform/runtime/ui` with no hint that it's a curated surface, not a barrel.

**Fix path:** Add a one-line note in public-surface.md (or a comment in package.json via JSON5/sibling) clarifying that `./platform/runtime/ui` is a curated surface, not a barrel of the `ui/` directory.

### MIN-04 — `./contracts/operator-contract.json` and `./contracts/peer-contract.json` are not in `bundle-budgets.json`
**File:** `packages/sdk/package.json:76-77`, `bundle-budgets.json:14-186`
**Severity:** Minor (Budget coverage gap)

The two JSON contract artifacts are exported as direct files. The bundle-budget comment (`bundle-budgets.json:12`) says "Entry keys must match the `exports` map keys in `packages/sdk/package.json` exactly." Strictly that's broken; in practice, JSON files are not gzipped JS bundles, and ignoring them is reasonable. Document this exception in the comment block.

### MIN-05 — `./package.json` and `./events/*` are not in `bundle-budgets.json`
**File:** `bundle-budgets.json`
**Severity:** Minor (Budget coverage gap)

Same pattern as MIN-04. `./package.json` (a static asset) is reasonably out of scope. `./events/*` is wildcard and per-domain budgets would be ideal but not yet present. Document in the comment.

### MIN-06 — `docs/packages.md:9` references `./surfaces.md`; surfaces.md may be missing
**File:** `docs/packages.md:9`, `docs/public-surface.md:3`
**Severity:** Minor (Broken doc link)

Both files reference `./surfaces.md`. The git status at the top of this session shows a deletion of `docs/compatibility.md` but no creation of `docs/surfaces.md`. If `docs/surfaces.md` does not exist, the docs ship a broken link. (Not verified in this review since I didn't glob for it; quick check before merge recommended.)

### MIN-07 — `runtime-boundary.ts` uses a typeof+globalThis cast that cannot be unit-tested for non-node-no-process runtimes
**File:** `packages/sdk/src/platform/node/runtime-boundary.ts:27-44`
**Severity:** Minor (Test coverage gap)

The test at `test/sdk-runtime-boundaries.test.ts:91-105` covers the node and empty-object cases. It does NOT cover the case where `process` is present but `process.versions.node` is undefined (Bun: present + undefined; Deno: undefined). The fallback (`runtimeName = 'unknown'`) is plausible but is not exercised. Add a test case for `{ process: { versions: {} } }` and `{ process: { release: { name: 'workerd' } } }`.

### MIN-08 — `examples/tsconfig.json` and various examples are listed as modified; nothing was sampled for entrypoint accuracy
**File:** `examples/*.{ts,mjs,tsx,kt,swift}`
**Severity:** Minor (Example drift not audited)

Git status shows all examples modified. Not sampled in this review. If any of them import deleted or moved subpaths, the type-test won't catch it because examples aren't compiled by the type-tests directory.

### MIN-09 — `package.json:235-237` (`files: ["dist"]`) excludes the LICENSE/README/CHANGELOG files
**File:** `packages/sdk/package.json:235-237`
**Severity:** Minor (Distribution polish)

Not directly a surface issue, but consumer ergonomics: only `dist` is shipped. README.md and LICENSE are absent from the published tarball, which surfaces as warnings in `npm install` provenance checks and on the npmjs.com listing. Add `README.md`, `LICENSE`, and (optionally) `CHANGELOG.md` to the `files` array.

---


---

# NITPICK

## NITPICK — sdk-core


### NIT-1 — `index.ts:8` — public re-exports are only one place removed from underlying packages
**File:** `packages/sdk/src/index.ts:8`

For `createGoodVibesSdk`, the SDK adds value (browser/RN factories, observer, auto-refresh). For `errors.ts` / `contracts.ts` / `daemon.ts` / `operator.ts` / `peer.ts`, the local file is a one-line `export * from '...';`. If these files exist *only* to make build paths work, document why; if they are intentional public surfaces, add a comment about what value the indirection provides.

### NIT-2 — `client.ts:299` — error message contains the literal example URL `"https://my-daemon.example.com"`
**File:** `packages/sdk/src/client.ts:299`

Minor — examples in error strings can confuse log scrapers. Prefer a doc-link.

### NIT-3 — `auth.ts:24-26` — multi-paragraph comment block could be a JSDoc `@remarks`
**File:** `packages/sdk/src/auth.ts:22-26`

The rationale for omitting `OAuthClient` is great; consider promoting to JSDoc on the export so it shows up in IDE hover.

### NIT-4 — `react-native.ts:62` — `forSession` re-export is buried under JSDoc for the factory
**File:** `packages/sdk/src/react-native.ts:62`

Same pattern as web.ts/expo.ts (MIN-27/28).

### NIT-5 — `client.ts:175-184` — JSDoc example uses `crypto.randomUUID()` without import context
**File:** `packages/sdk/src/client.ts:180`

The example assumes browser/Node 19+ globals; add a one-line note.

### NIT-6 — `observer/index.ts:20` — `SPAN_STATUS_ERROR = 2 as const` magic number with sidecar comment
**File:** `packages/sdk/src/observer/index.ts:20`

The comment says "OpenTelemetry SpanStatusCode.ERROR". Importing the upstream constant via a `type-only` import would make the link enforced.

### NIT-7 — `client-auth/android-keystore-token-store.ts:209-220` — duplicated `console.warn` template strings
**File:** `packages/sdk/src/client-auth/android-keystore-token-store.ts:209-220`

The `[pellux/goodvibes-sdk] react-native-keychain does not expose ...` strings can collapse into a `formatKeychainCapabilityWarning(kind, key)` helper.

### NIT-8 — `auth.ts:158, 176` — `value && value.trim() ? value : null` repeated
**File:** `packages/sdk/src/auth.ts:158, 176`

Minor duplication; extract `nonEmpty(s) ? s : null`.

### NIT-9 — `workers.ts:209-222` — `requireWorkerAuth` mixes two responsibilities (configuration check + auth header check)
**File:** `packages/sdk/src/workers.ts:209-222`

Split into `validateWorkerAuthConfig(env, options)` returning a 503 once, and `validateWorkerAuthHeader(request, expected)` returning a 401 per request, so the 503 path can be skipped after first check.

### NIT-10 — `platform/automation/manager-runtime.ts:128-131` — back-to-back `private deliveryManager`, `private deliveryInFlight`, `private runtimeDispatch`, `private runtimeBus` initialised with `null`
**File:** `packages/sdk/src/platform/automation/manager-runtime.ts:128-131`

`null`-init properties for things that will be assigned later are exactly what the WeakRef / lazy-init pattern is for. Cosmetic.

### NIT-11 — `core/orchestrator.ts:480-490` — `(this.animInterval as unknown as { unref?: () => void }).unref?.();`
**File:** `packages/sdk/src/platform/core/orchestrator.ts:488`

See MIN-16.

### NIT-12 — `well-known-endpoints.ts:25-31` — hardcoded localhost URLs for ollama/lmstudio/llamaCpp/liteLLM
**File:** `packages/sdk/src/platform/providers/well-known-endpoints.ts:25-31`

Likely intentional (these are dev-only defaults), but document as such above the constant.

### NIT-13 — `client.ts:400-402` — duplicate paragraph commentary above `let operatorRequestJson`
**File:** `packages/sdk/src/client.ts:392-404`

Lines 391-399 explain the lazy proxy, then lines 400-402 explain it again with similar wording. Trim.

### NIT-14 — `auth.ts:25` — comment contains "client-safe surface" — typo-resistant phrase
**File:** `packages/sdk/src/auth.ts:25`

Not a bug; just `client-safe` is hyphenless in some companion docs. Pick a spelling and apply repo-wide.

### NIT-15 — `observer/index.ts:60` — interface extends `TransportObserver` without explicitly listing inherited members
**File:** `packages/sdk/src/observer/index.ts:60`

Intentional, but documenting which members come from `TransportObserver` saves IDE-less readers a hop.

---


## NITPICK — packages


### NIT-1 — `EventEnvelope.ts:traceId` lazily generated when not supplied

**File:** `packages/transport-core/src/event-envelope.ts:24-43`

The `createEventEnvelope` helper auto-fills `traceId` with a fresh UUID v4 when none is supplied. This is convenient for fan-out but burns crypto entropy on every event. For high-volume callers (telemetry, streaming deltas) this is measurable overhead.

Fix: only generate when an OTel span is *not* available (delegate to `injectTraceparentAsync` style), or accept a `correlationIdGenerator` option. Document the cost.

### NIT-2 — `dispatchDaemonApiRoutes` `result` shadowing

**File:** `packages/daemon-sdk/src/api-router.ts:23-37`

```ts
let result = await dispatchRemoteRoutes(...);
...
if (extensions) {
  for (const extension of extensions) {
    const result = await extension(req); // shadow
```

Inner `const result` shadows the outer `let result`. Functionally correct but trivially confusing.

Fix: rename inner to `extResult` or hoist the loop into a helper.

### NIT-3 — `ConfigurationError`/`HttpStatusError`/`ContractError` brand check uses `code` only

**File:** `packages/errors/src/index.ts:325-446`

Each subclass's `Symbol.hasInstance` check requires the SDK brand AND a specific `code` literal. A user who constructs `new GoodVibesSdkError(..., { code: 'SDK_HTTP_STATUS_ERROR' })` directly will pass `instanceof HttpStatusError` even though the prototype chain is just `GoodVibesSdkError`. This is intentional per the comments, but the surface implication is that callers who pattern-match on `instanceof` get a brittle test.

Fix: document the brand contract on each subclass JSDoc explicitly ("code is the source of truth, not the prototype chain").

### NIT-4 — `accounts.ts` schema uses `.catchall(z.unknown())` losing strictness

**File:** `packages/contracts/src/zod-schemas/accounts.ts:40`

`ProviderSnapshotSchema.catchall(z.unknown())` accepts any extra keys silently. For a snapshot response this is forward-compat-friendly but means a typo in the daemon (`activeRouteReson` vs `activeRouteReason`) parses cleanly with the typo'd value sitting in `[unknown]` and the typed field undefined. The typed access then sees `undefined` with no error.

Fix: drop `catchall` for response schemas, or use `.passthrough()` only on specific evolution-prone fields.

### NIT-5 — `RuntimeEventRecordSchema` accepts any object with a string `type`

**File:** `packages/contracts/src/zod-schemas/events.ts:24-26`

No enum/literal narrowing on `type`. Combined with `TypedSerializedEventEnvelopeSchema`, anything with a `type: string` validates. The type-system narrows, but runtime validation is permissive. For inbound WS frames this is the only validation step.

Fix: optionally accept a generator-supplied `z.enum([...domain event types])` schema for stricter inbound validation when the contract is known.

### NIT-6 — `getOperatorContractPath`/`getPeerContractPath` rely on `import.meta.url` resolution

**File:** `packages/contracts/src/node.ts:3-9`

These helpers compute the artifact path relative to the *bundled* `import.meta.url`, which works when consumers import the published package but breaks if a consumer's bundler inlines the contracts module without copying `artifacts/*.json`. No runtime check that the resolved path exists.

Fix: in dev/Node, `try/catch` the `fileURLToPath` and throw a `ConfigurationError` pointing at the npm pack contents; in browser builds, throw immediately rather than returning a path that won't resolve.

---


## NITPICK — tests


### NIT-01 — `vitest.*.config.ts` and `bunfig.toml` do not exist
The scope mentioned them. The project uses Bun's native test runner via `scripts/test.ts:38` (`execFileSync('bun', ['test', ...])`). No vitest, no bunfig — confirmed. The codebase is consistent here. Consider adding a `bunfig.toml` to pin runner flags (`--preload`, timeout, etc.) instead of relying on Bun defaults.

### NIT-02 — `test/smoke.test.ts:1` imports from `'bun:test'` but file has frontmatter `framework: vitest` per file_type detection
This is a precision_engine classifier artifact, not a bug — there's no vitest dep. Logged for completeness.

### NIT-03 — `test/perf-07-interval-unref.test.ts:53` arbitrary 20-line look-ahead
Magic number. A class with a `setInterval` in its constructor and `.unref()` 21 lines later (e.g. after a long inline JSDoc) would silently slip through. Make the window configurable or AST-bounded.

### NIT-04 — `test/_helpers/test-timeout.ts:1` exports `EVENT_SETTLE_MS = 50`
Good that it's centralised. But 14 callers use `settleEvents()` (default 50ms) which is enough to cause CPU-bound CI flakes. Consider making it `process.env.SETTLE_MS ?? 50` so CI can crank it up.

### NIT-05 — `package.json` lacks `bunfig.toml` reference and no `pretest:workers`/`pretest:rn` chains
`test:rn` and `test:workers` (`package.json:45-46`) do `bun run build && …` inline. If `pretest` ever pre-builds, this becomes redundant. Minor.

### NIT-06 — `test/hermes/dist/hermes-test-bundle.js` is checked-in build output
Generated by `test/hermes/bundle-for-hermes.ts:32`. The file is 100KB+ of esbuild IIFE. If it's regenerated per CI run, it should be `.gitignore`d; if it's a sentinel for environments without esbuild, it should be flagged in README. Currently neither.

### NIT-07 — `scripts/test.ts:23` regex `/\.test\.(ts|tsx|mjs)$/` differs from `scripts/no-skipped-tests.ts:7` (same)
Consistent — good.

### NIT-08 — `scripts/no-skipped-tests.ts:8` `/\b(?:describe|test|it)\.(?:skip|todo)\s*\(/` does NOT block `.skip.if`, `.skipIf`, `it.each.skip`
Bun supports `.skipIf(cond)` and `.skip.if`. The regex would miss them. No instances exist in the repo today, but the lint is shallower than its name implies. Update regex to `\.(?:skip(?:If|\.if)?|todo)\b`.

### NIT-09 — `test/integration/_shared/arbitraries.ts` not co-located with consumer tests
Most SDKs put fast-check helpers next to the property tests that use them. Two consumers, both under `test/integration/`, so this is consistent.

### NIT-10 — Hermes bundle path is `test/hermes/dist/hermes-test-bundle.js` — `dist/` collides with package `dist/` semantics
Low-cost rename to `test/hermes/build/` would avoid confusion when grepping.

---


## NITPICK — docs+examples


### NIT-001 — Em-dashes vs hyphens are inconsistent across docs

- File: `docs/getting-started.md`, `docs/error-kinds.md`, etc.
- Evidence: mixed use of `—` and `--` and `-`.
- Fix: pick one and run a sweep.

### NIT-002 — `getting-started.md:154-159` uses `...` placeholders inside live code blocks

- File: `docs/getting-started.md:156-159`
- Evidence: `(event) => { ... }` will not compile if a reader copy-pastes. Use `/* handle */` or a real one-liner.

### NIT-003 — `error-handling.md:17` uses `if (!(err instanceof GoodVibesSdkError)) throw err;` then continues with `switch (err.kind)`. Inside the `if` the type narrows to `unknown`, but the `throw` exits, so the subsequent `err` is narrowed to `GoodVibesSdkError`. Correct, but subtle for a quickstart.

- Fix: lead with `if (err instanceof GoodVibesSdkError) { switch (err.kind) { ... } } else { throw err; }` for readability.

### NIT-004 — Headings in `pairing.md` mix sentence-case ("## QR Code Flow") and Title Case ("### Step 1: Host generates a companion token")

- Fix: pick one.

### NIT-005 — `examples/realtime-events-quickstart.mjs:21` calls `unsubscribeTimer.unref?.()` without explanation

- File: `examples/realtime-events-quickstart.mjs:17-21`
- Evidence: unrefing the timer prevents Bun/Node from staying alive on the timer alone. Add a one-line comment so readers can copy with intent.

### NIT-006 — `defaults.md:107-116` table for TTS uses `tts.provider` default `elevenlabs` — quote/case style is inconsistent with other tables

- Fix: cosmetic.

### NIT-007 — `README.md:27` registry example uses `YOUR_GITHUB_TOKEN` placeholder; surrounding text does not warn against committing

- Fix: add a one-line warning.

### NIT-008 — `CONTRIBUTING.md:3` says "Bun 1.0+"; `package.json:8` pins `"bun": "1.3.10"` exactly; `engines.bun` is `1.3.10`

- File: `CONTRIBUTING.md:3`
- Evidence: prose says 1.0+, manifest pins 1.3.10. Consumers who try to develop with Bun 1.2 will hit `engines` failures despite the doc.
- Fix: update the prose to match the pinned engine version.

### NIT-009 — `SECURITY.md:5-7` supported version table format vs `SECURITY.md:7` says `0.30.x` is supported and `< 0.30.0` is not — fine, but no mention of 1.0 timeline

- Cosmetic.

### NIT-010 — `examples/companion-approvals-feed.ts:21` comment "browser-only example; window is guaranteed by the surrounding HTML host" — but the file imports from `/browser` and the example is checked by Bun typecheck

- File: `examples/companion-approvals-feed.ts:21-24`
- Evidence: `tsconfig.json` includes `lib: ['ES2024', 'DOM']`. So `window` is typed. Fine. Comment is misleading: window is provided by the `lib: 'DOM'` config, not by an HTML host.

### NIT-011 — `auth.md:56` rule "Examples must not print tokens" is repeated in `examples/README.md:12` and `SECURITY.md:104` — three near-duplicates of the same rule

- Fix: pick one canonical location and link to it from the others.

### NIT-012 — Several docs end without a trailing newline (cannot verify here without raw byte inspection)

- Cosmetic; lint job should catch it.

### NIT-013 — `architecture.md` and `architecture-platform.md` not read in full for this review (size budget); spot-check before next release

- Note for next review pass.

---


## NITPICK — build+CI+config


### NIT-001 — `release.yml:200` `# Run if npm publish succeeded` comment uses passive voice that obscures the gate
Replace with explicit description of the precondition.

### NIT-002 — `bundle-budgets.json:15` rationale says "235 B gzip + 50 B floor" but no other entry uses that phrasing
Non-uniform style; one entry follows the floor methodology, the rest do `* 1.2`.

### NIT-003 — `package.json:31-75` script names alphabetized inconsistently; `build` is mid-list (line 41), `validate` after `release:verify:published` (line 55-56). Suggest grouping by lifecycle stage.

### NIT-004 — `scripts/refresh-contract-artifacts.ts:1` `#!/usr/bin/env bun` shebang but file never marked executable in repo (no `chmod +x` reflected). Either remove the shebang or make executable.

### NIT-005 — `release.yml:18` concurrency group ID `sdk-release-${{ github.event.inputs.ref || github.ref_name || github.run_id }}` falls back to `run_id` which is unique per run — concurrent same-tag pushes get distinct groups, defeating cancel-in-progress.

### NIT-006 — `release-shared.ts:138-150` function name `addSdkSecurityMitigationManifestFields` is descriptive but 9 words long; `applySdkVendorMitigations` is shorter.

### NIT-007 — `tsconfig.base.json:8-11` comment about `ESNext.Disposable` is helpful; consider adding a `// SOURCE:` link to TC39 proposal for posterity.

### NIT-008 — `flake-detect.ts:64` timeout `10 * 60 * 1000` is hardcoded; expose via env var like `FLAKE_TIMEOUT_MS`.

### NIT-009 — `package-metadata-check.ts:8-19` package list duplicated from `release-shared.ts:11-21`. Single source of truth would prevent drift.

### NIT-010 — `validate.ts` lacks any progress logging beyond what each subscript prints. A long validate (15+ minutes locally) shows no "step N/M" indicator.

### NIT-011 — `dependabot.yml:7` `open-pull-requests-limit: 5` for npm but only `2` for github-actions — npm has more deps but 5 may stack up. Document tradeoff.

---


## NITPICK — public surface


### NIT-01 — `packages/sdk/package.json` fields are alphabetized inconsistently
**File:** `packages/sdk/package.json`
**Severity:** Nitpick

The object key order is: `name`, `version`, `repository`, `main`, `dependencies`, `optionalDependencies`, `exports`, `bugs`, `description`, `files`, ... This is neither alphabetical nor follows the npm convention (`name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `repository`, `main`, `types`, `exports`, ...). Re-order for consistency on the next pass.

### NIT-02 — capabilities.ts wildcard string `'@pellux/goodvibes-transport-*'` is opaque
**File:** `packages/sdk/src/platform/node/capabilities.ts:56`
**Severity:** Nitpick

The `dependencyFamilies` array uses literal strings with `*` (e.g. `'@pellux/goodvibes-transport-*'`, `'tree-sitter-*'`). These are documentation-only patterns. A consumer who programmatically reads them might mistake them for actual glob patterns. Add a JSDoc comment noting they are display strings.

### NIT-03 — `etc/goodvibes-sdk.api.md` uses CRLF line endings
**File:** `etc/goodvibes-sdk.api.md`
**Severity:** Nitpick

The file has `\r\n` line endings (visible as `\r` in grep output). Other repository files appear to use LF. Confirms api-extractor is being run on a Windows or auto-CRLF host, or the file was committed once with CRLF. Normalize to LF for diff hygiene.

### NIT-04 — `docs/public-surface.md` uses a mix of "stable" and "Stability:" wording
**File:** `docs/public-surface.md`
**Severity:** Nitpick

"Stability contract" appears at lines 35 and 167 with slightly different shapes. Lines 19, 31, etc. use bare "**Status:** stable". Consistency improves scannability.

---


---

# COVERAGE GAPS — tests

## Coverage gaps — features without an obvious dedicated test

Reality-checked by sampling `packages/sdk/src/_internal/platform/` directories vs root-level test files:

| Feature area | Test? |
|---|---|
| `platform/intelligence/lsp/` (LSP server integration) | Only `test/lsp-bash-bundled.test.ts` — covers a single bundled language server, not the LSP protocol surface. |
| `platform/discovery/` | No `test/discovery-*.test.ts` found. |
| `platform/git/` | No dedicated test (verified via grep — git ops appear only as setup helpers in worktree tests). |
| `platform/multimodal/` | `multimodalService` is stubbed in `daemon-stub-handlers.ts:228-232` but no unit test. |
| `platform/voice/providers/` | `test/voice-tts-stream.test.ts` covers TTS streaming only; no STT, no realtime session. |
| `platform/runtime/forensics/` | No `test/forensics-*.test.ts`. |
| `platform/runtime/eval/` | No `test/eval-*.test.ts` (the directory exists with multiple files). |
| `platform/runtime/sandbox/` | No `test/sandbox-*.test.ts`. |
| `platform/runtime/network/` | No `test/network-*.test.ts`. |
| `platform/runtime/inspection/state-inspector/` | No dedicated state-inspector test. |
| `platform/templates/` | No `test/templates-*.test.ts`. |
| `platform/scheduler/` | `test/scheduler-capacity.test.ts` exists; covers capacity only. |
| `platform/runtime/store/domains/` | Domain-by-domain reducers exist but only smoke-covered via `cache-invariants.test.ts`. |
| `platform/security/` | Mostly covered by `sec-*` tests, but `sec-04`, `sec-09`, `sec-10` are flagged missing in `test/COVERAGE.md`. |
| `platform/runtime/permissions/normalization/` and `rules/` | Some coverage via `auth-permission-resolver.test.ts`, but normalization rules tree (4+ files) has no dedicated test. |
| `platform/runtime/orchestration/` | No `test/orchestration-*.test.ts`. |
| `platform/web-search/providers/` | `test/openai-compatible-routes.test.ts` only; no per-provider test. |

**Note:** "No dedicated test" does NOT mean uncovered — many of these are exercised transitively through router-e2e tests or the operator/peer SDK coverage suites. But the absence of a directly-named test means a regression in one of these subsystems will only surface as a downstream router-test failure with confusing root cause.

---

