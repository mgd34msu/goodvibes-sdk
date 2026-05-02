# Full Codebase Review — goodvibes-sdk

**Date:** 2026-05-02
**Mode:** Inventory-only — no fixes applied. Six parallel reviewer agents covered distinct areas.
**Branch:** `main` @ `b114b9a` (with uncommitted changes per `git status`)

---

## Executive Summary

| Area | Score | Critical | Major | Minor | Nitpick | Total |
|---|---:|---:|---:|---:|---:|---:|
| **packages/sdk core** (incl. recent home-graph/semantic/webhooks) | 5.0/10 | 8 | ~110 | ~85 | ~15 | ~218 |
| **Supporting packages** (contracts, errors, transport-*) | 6.8/10 | 4 | 18 | 25 | 16 | 63 |
| **SDK packages** (peer-sdk, operator-sdk, daemon-sdk) | 7.4/10 | 0 | 24 | 36 | 10 | 70 |
| **Test suite** | 7.4/10 | 0 | 6 | 9 | 7 | 22 |
| **Build / tooling / config** | 5.5/10 | 6 | 11 | 9 | 5 | 31 |
| **Docs / security / examples** | 8.2/10 | 0 | 2 | 9 | 11 | 22 |
| **TOTAL** | — | **18** | **~171** | **~173** | **~64** | **~426** |

### Top systemic concerns (cross-cutting)

1. **Massive package duplication** — every workspace package (`contracts`, `errors`, `transport-*`) is mirrored byte-for-byte under `packages/sdk/src/_internal/`. Two sources of truth for every type. (Supporting packages C1)
2. **Published `packages/sdk` declares ~30 unrelated runtime dependencies** (`pyright`, `bash-language-server`, `tree-sitter-*`, `pdfjs-dist`, `jsdom`, etc.) that don't appear used by SDK source — a publish would balloon consumer installs to hundreds of MB. (Build C1, SDK package.json MAJOR)
3. **Empty `catch {}` proliferation + `void p.catch(() => {})` fire-and-forget** — 23+ silent error suppressions across the knowledge module alone, plus 12+ fire-and-forget chains. Errors are invisible. (SDK Cross-cutting CRITICAL)
4. **`setTimeout` without `.unref()`** regression — 6+ new instances in modified files; previously fixed under memory `wave-2-perf-07-missing-unref`. Process exit blocked. (SDK Cross-cutting CRITICAL)
5. **Repo hygiene rot** — 1.1 GB of leaked `.tmp/` (383 dirs), committed 1.9 MB `sbom.cdx.json`, leaked `:memory:` test artifact whose underlying SQLite-path bug still exists in source.
6. **No CI security gates** — no `bun audit`, no secret scan, no Dependabot/Renovate, no license check.
7. **LG-TV-specific editorial knowledge embedded in code** — `repair-profile.ts`, `fact-quality.ts`, `answer-quality.ts`, `page-quality.ts` all contain hardcoded vendor blocklists/allowlists and TV-specific regexes masquerading as generic helpers.
8. **God files / God interfaces** — `home-graph/service.ts` (943L), `semantic/answer.ts` (1119L), `daemon-sdk/context.ts` `DaemonApiRouteHandlers` (222 methods, severe ISP violation).
9. **Helper duplication everywhere** — `readHomeAssistantObjectId` (4 copies), `readString`/`uniqueStrings`/`mergeSourceStatus` repeated; `MethodArgs`/`splitArgs`/`WithoutKeys` duplicated verbatim between peer-sdk and operator-sdk.
10. **No `engines` declaration** in any package; native binaries declared as runtime deps in browser/RN-targeted package.

---

## 1 — packages/sdk core (Score: 5.0/10)

Recent work touched `webhooks.ts`, `home-graph/*` (incl. new `page-quality.ts`), `semantic/*`, and `ingest-compile.ts`. ~218 findings.

### CRITICAL

| # | File:Line | Finding |
|---|---|---|
| C1 | `home-graph/service.ts:532-582` | `ingestCreatedArtifact` uses `setTimeout(() => { void this.enrichAndImproveSource(...).catch(() => {}); }, 0)` — handle not stored, errors swallowed, no concurrency cap, work in flight lost on shutdown. |
| C2 | `home-graph/service.ts:719-727` | `scheduleSyncSelfImprovement` `setTimeout(... 5_000)` without `.unref()`. Regresses memory `wave-2-perf-07-missing-unref`. |
| C3 | `home-graph/service.ts:742` | `await new Promise(r => setTimeout(r, 10_000))` × 4 rounds = up to 40s blocking with no AbortSignal. |
| C4 | `generated-pages.ts:113-177` | Fully sequential N+1 store I/O: 32 devices × 8 sources × ~7 facts × 3 ops = 1700+ sequential roundtrips. Explains the 15s deadline. |
| C5 | `fact-quality.ts:32-186` | `isLowValueFeatureOrSpecText` — 154-line function, 30+ regex evaluations per fact, called per-fact in tight loops. |
| C6 | `fact-quality.ts` | Editorial vendor blocklist embedded in code (Crutchfield, SpeakerCompare, LG nano90 specifics, magic remote idioms). |
| C7 | `repair-profile.ts:25-134` | `PROFILE_RULES` is LG-TV-specific (86" displays, ThinQ, NanoCell, TruMotion 240). Function name implies generic; called from `generated-pages.ts:558` for any device class. |
| C8 | Cross-cutting | 23+ empty `catch {}`, 12+ `void p.catch(() => {})`, 6+ `setTimeout` without `.unref()` across knowledge module. |

### MAJOR (selected — full list ~110)

**`webhooks.ts`:**
- `:26-28, 197-202` — `timeoutMs` floor of 1ms produces undebuggable `AbortError`.
- `:89-99` — Unbounded `Promise.allSettled` fan-out; 500 webhooks = 500 parallel requests per event.
- `:184` — `AbortSignal.timeout()` not supported on RN <0.74; no fallback despite `./react-native` export.
- `:60-63` — `setUrls` skips URL validation that `addUrl` performs.
- No HMAC/signing — receivers cannot verify origin.
- No body-size cap — 1MB error string becomes 1MB POST.

**`ask-page-refresh.ts`:**
- `:33-35, 52-54` — empty catch with comment-only excuse.
- `:23, 70, 76` — magic slice constants (`2`, `16`, `8`) without named constants.
- `:84, 140, 152` — magic edge weights `0.82`, `0.8`, `0.78`, `0.76`.
- `:227-235, 247-257` — `readHomeAssistantObjectId` / `readString` / `uniqueStrings` re-implemented locally.

**`page-quality.ts` (NEW):**
- `:28` — `Math.min(0.98, Math.max(0.55, quality / 260))`. The `/260` divisor likely causes the floor `0.55` to win 100% of cases. Untested.
- `:31-41` — magic constants `24/5/10/6/120` for source quality scoring.
- `:43-66` — concatenated lowercased text + 3 regex tests against hardcoded vendor names.
- `:62` — `\bamzn\.to\b` regex word-boundary semantics suspect.
- `:68-86` — `mergeSourceStatusForQuality` / `sourceStatusRank` exact dups of ask-page-refresh.ts.

**`generated-pages.ts`:**
- `:215-229` — `refreshedAt: Date.now()` written every refresh, no content-hash gate.
- `:250, 295, 331` — repeated tag literal arrays.
- `:460-462` — magic scoring constants for prioritization.
- `:617-632` — `extractedPageSourceText` concatenates 9 fields; megabyte-scale concatenations on big PDFs.
- `:651` — 3rd copy of `readHomeAssistantObjectId`.

**`pages.ts`:**
- `:22-46` — sequential `await readMarkdown` per page; not parallelized.
- `:117-130` — `pageNeighbors` quadratic over edges.
- `:188-195` — `generatedPagePriority` collides with same-named function in `generated-pages.ts:452`.
- `:198-205` — `readMarkdown` swallows errors silently.

**`home-graph/service.ts`:**
- `:611, 821` — empty catch.
- `:477-491` — `importSpace` does sequential writes with no transaction; partial failure leaves inconsistent state.
- `:706-713` — `linkSnapshotObjectRelations` is a 1-line wrapper for no clear reason.
- `:842-874` — node-id slugification can collide for inputs differing only in punctuation.
- `:930-937` — 4th copy of `readHomeAssistantObjectId`.

**`ingest-compile.ts`:**
- `:90` — `void Promise.resolve(...).catch(() => {})` enrichment; same anti-pattern.
- `:130-137` — PDFs always re-extract because predicate always returns true.
- `:155-186` — magic thresholds (`0.18`, `0.78`, `0.42`, `0.08`) for binary detection, no tests.
- `:188-340` — 153-line `compileKnowledgeSource` with sequential N+1 writes, deeply nested.
- `:286-321` — magic limits `12` sections / `24` links.
- `:426-449` — magic `slice(0, 8)` × 7 entity kinds = up to 112 sequential calls/source.

**`semantic/answer-quality.ts`:**
- `:17, 22, 50` — magic thresholds.
- `:21` — vendor allowlist regex (`zkelectronics`, `fullspecs`, `manualsnet`, `manua.ls`).
- `:28-45` — destructive `cleanSynthesizedAnswer` with hardcoded English fallback (i18n fail).
- `:54-72` — TV-display-tech-centric feature regex families.

**`semantic/fact-quality.ts`:**
- `:36` — facts ending in `?` summarily rejected.
- `:50-58` — fragile line-shape heuristics for table fragments.
- `:63` — any text with ellipsis rejected (overzealous).
- `:209-222` — O(n²) `hasRepeatedLeadingPhrase` in hot path.
- `:228-245` — silent rejection if upstream forgets to set `metadata.semanticKind`.
- `:240-243` — magic confidence threshold `60` + kind whitelist.

**`semantic/repair-profile.ts`:**
- `:34, 70-75, 113` — LG-specific literals (`86-inch class screen`, webOS, ThinQ, AirPlay, `2 x 10W speakers`).
- `:144` — broad-intent flag bypasses per-rule term matching entirely.
- `:152, 159` — synthetic English summary masquerading as `evidence` (misleading field).

**`semantic/answer.ts`** (1119 lines, outline only): structural smell, multiple concerns in one file.
**`semantic/self-improvement.ts`** (824 lines, outline only): 240-line god function `runKnowledgeSemanticSelfImprovement`; unmanaged abort timers.
**`semantic/self-improvement-promotion.ts`** (676 lines, outline only): busy-poll `setTimeout(resolve, 100)`; long classifier functions.
**`semantic/service.ts`** (532 lines, outline only): single-flight pattern coalesces unrelated `selfImprove` calls across spaceIds.

**`packages/sdk/package.json`:**
- `:9-40` — ~30 deps (`pyright`, `bash-language-server`, `tree-sitter-*`, `jsdom`, `pdfjs-dist`, `cloudflare`, `openai`, `@anthropic-ai/sdk`, ...) likely unused by `src/`.
- `:113-116` — `"./platform/*"` wildcard export exposes `_internal` shape.
- `:161` — `"lodash": "4.18.1"` is a non-existent version.
- `:17, 25, 27-31, 36, 38-39` — native binaries as unconditional deps in package advertising browser/RN/Workers entries.

### MINOR / NITPICK

~85 minor + 15 nitpicks: helper duplication (`readString`, `uniqueStrings`, `mergeSourceStatus` × 2-4 copies), magic numbers throughout, missing JSDoc on most exported functions, inconsistent `readonly`, high coupling (16 sibling imports in `home-graph/service.ts`).

---

## 2 — Supporting packages: contracts, errors, transport-* (Score: 6.8/10)

63 findings.

### CRITICAL

| # | File:Line | Finding |
|---|---|---|
| C1 | `packages/sdk/src/_internal/{contracts,errors,transport-*}/**` | **40+ mirror files** — every package fully duplicated inside the SDK's `_internal/`. Two sources of truth, drift guaranteed. Highest-leverage fix in the entire codebase. |
| C2 | `transport-realtime/src/runtime-events.ts:237-254` | `onOpen` async race — socket may be nulled between auth-await checkpoints; `socket.send` may throw. |
| C3 | `transport-realtime/src/runtime-events.ts:262-285` | Reconnect counter never resets if no `'event'` frame ever arrives (e.g., auth-rejected close); burns through `DEFAULT_WS_MAX_ATTEMPTS=10` rapidly. |
| C4 | `transport-realtime/src/runtime-events.ts:93-104, 246-252` | WebSocket bearer token sent in plaintext over `ws://` if URL is mis-configured; no scheme guard. |

### MAJOR (selected)

- `errors/src/index.ts:65-69` — `'tool'` category falls through to `'unknown'` by accident.
- `errors/src/index.ts:147-167` — `GoodVibesSdkError` constructor doesn't forward `cause` to `super()`; cause chain broken; `toJSON` missing.
- `errors/src/index.ts:281-307` — `body.status ?? status` overrides authoritative HTTP status.
- `transport-http/src/http-core.ts:404-406` — `Idempotency-Key` regenerated on every retry, defeating its purpose.
- `transport-realtime/src/runtime-events.ts:194-201` — Outbound queue drops emit `onError` per drop; observer flood under sustained backpressure.
- `transport-http/src/sse-stream.ts:230-253` — No `onClose`/`onTerminate` callback; consumers cannot distinguish "gave up" from "reconnecting".
- `transport-core/src/middleware.ts:88-118` — No max-recursion-depth guard for misbehaving middleware.
- `transport-core/src/otel.ts:90-108` — Sync `injectTraceparent` uses `globalThis.require`; silently no-ops in pure ESM Node.
- `transport-http/src/auth.ts:63-65` — `normalizeAuthToken` doesn't catch sync throws from caller-supplied resolver.
- `transport-http/src/paths.ts:45-74` — 25 hardcoded daemon URLs not derived from contracts manifest; silent contract drift.
- `transport-realtime/src/domain-events.ts:96-124` — Listener add/remove race during pending-connect window.
- `errors/src/index.ts:93-103` — `'config'` is in `SDKErrorKind` but `inferCategory` never returns it.
- `transport-direct` — entire package is an 11-line wrapper exporting one one-liner function.
- `transport-realtime/src/index.ts:6, 15` — `forSession` and `forSessionRuntime` are the same function exported twice.
- All packages: no `"engines"` field; no per-package `README.md`; `private: true` + `publishConfig.access: public` is contradictory.

### MINOR / NITPICK (selected)

- `errors/src/index.ts:91` ↔ `transport-http/src/retry.ts:31` — `RETRYABLE_STATUS_CODES` duplicated.
- `transport-http/src/http.ts:119-136` ↔ `http-core.ts:163-180` — `inferTransportHint` duplicated verbatim within one package.
- `transport-http/src/auth.ts:18-45` ↔ `http-core.ts:131-161` — two near-identical header-merge implementations in one package.
- `transport-realtime/src/domain-events.ts:50-59` ↔ `transport-http/src/sse-stream.ts:36-45` — duplicate disconnect-error detection.
- `transport-core/src/event-envelope.ts:22-24` uses `crypto.randomUUID()` directly without the fallback present in `http-core.ts:41-58`.
- `errors/src/index.ts:267-275` — `HttpStatusError` constructor mis-categorises status-less network errors as `'unknown'`.
- `transport-http/src/paths.ts:32-38` — `normalizeBaseUrl` strips one trailing `/` but not multiple.
- `transport-http/src/http-core.ts:244-247` — `addQueryValue` silently coerces `null` → `'null'` in query.
- `transport-http/src/sse-stream.ts:77-80` — missing `onError` becomes uncatchable `queueMicrotask` throw.
- `transport-realtime/src/runtime-events.ts:98` — scheme replace doesn't handle `http+something://`.
- `transport-realtime/src/runtime-events.ts:97` — `'/api/control-plane/ws'` literal not in `paths.ts`.
- `errors/src/index.ts:59-62` — `'service'` and `'internal'` collapsed to `'server'`, losing operational distinction.
- `contracts/src/types.ts:114-122` — WebSocket frame types are anonymous shape, no discriminated union.

---

## 3 — peer-sdk, operator-sdk, daemon-sdk (Score: 7.4/10)

70 findings. **No CRITICALs.**

### MAJOR (selected)

- `peer-sdk/src/client.ts:21-24` vs `operator-sdk/src/client.ts:26-91` — peer-sdk lacks the response-validation feature operator-sdk provides; asymmetric runtime safety on security-relevant peer endpoints.
- `peer-sdk/package.json:39-43` — no `zod` dep; consequence of the gap above.
- `operator-sdk/src/client.ts:7-11, 49-58` — `validateResponses` flag claims "lazy zod loading" but imports are top-level eager; the bundle-size benefit is fictional.
- `operator-sdk/src/client.ts:67-69` — `as OperatorSdk` cast is unsound; runtime `getMethod` accepts `string` despite the override typing.
- `peer-sdk/src/client.ts:14-19, 23` and `operator-sdk/src/client.ts:42-47, 90` — `Omit & override` typing pattern is unsafe; types lie about runtime narrowing.
- `peer-sdk` uses `getEndpoint`, `operator-sdk` uses `getMethod` — same concept, different vocabulary across siblings.
- `daemon-sdk/src/api-router.ts:21-28` — fixed dispatch order; both `dispatchRemoteRoutes` and `dispatchOperatorRoutes` claim `/api/remote`; reordering silently breaks behavior.
- `daemon-sdk/src/operator.ts:5-186` `Pick<DaemonApiRouteHandlers, …>` lists 90+ keys; new methods on `context.ts:3-225` (222 methods) silently absent from the dispatcher.
- `daemon-sdk/src/http-policy.ts:56-69` — `resolvePrivateHostFetchOptions` returns `{} | { ... } | Response`; the `{}` arm makes it impossible for TS to enforce that callers handle the Response branch.
- `daemon-sdk/src/operator.ts:198`, `runtime-session-routes.ts:225,242` — `Number(searchParams.get('limit') ?? 100)` with no NaN/negative/Infinity bounds.
- `daemon-sdk/src/remote-routes.ts:94, 112, 129, 274` — `x-forwarded-for` forwarded as `remoteAddress` with no trust-boundary documentation; spoofable.
- `daemon-sdk/src/remote-routes.ts:163-167` — `body.result` passed through with no shape/size validation; DoS surface.
- `daemon-sdk/src/error-response.ts:104, 109-118` — Locale-sensitive English-only regex inference; no 504 handling (only 408).
- `daemon-sdk/src/artifact-upload.ts:309-458` — `Content-Length` not checked against `getMaxBytes()` before spooling; cumulative-size check happens per-chunk during write.
- `daemon-sdk/src/artifact-upload.ts:320` — body reader acquired but never released; lock leaks on Node undici.
- `daemon-sdk/src/artifact-upload.ts:186-188, 450-452` — `cleanup` is best-effort; rm errors swallowed; spool dirs may leak.
- `daemon-sdk/src/context.ts` — `DaemonApiRouteHandlers` interface has 222 methods in 226 lines; severe ISP violation; mocking nightmare.
- `daemon-sdk/src/runtime-route-types.ts:63-237` — `DaemonRuntimeRouteContext` similarly bloated.
- `operator-sdk/src/client-core.ts:230-376` — ~150 lines of mechanical pathParam-extracting boilerplate; should be codegenned from contract metadata.
- `peer-sdk/src/client-core.ts:88-93` — no `'contract'` error wrapping (operator-sdk has it); inconsistent error UX.

### MINOR / NITPICK (highlights)

- All three `package.json`: no `"engines"`, no `devDependencies`, no test script, `private: true` + `publishConfig.access: public` contradiction.
- `operator-sdk/src/client.ts:24` — `import type { ZodType } from 'zod/v4'` assumes zod 4.x.
- `peer-sdk/src/client-core.ts:19-56` ≅ `operator-sdk/src/client-core.ts:26-68` — `splitArgs`/`MethodArgs`/`WithoutKeys`/`RequiredKeys` duplicated verbatim.
- Multiple empty-extension interfaces.
- `daemon-sdk/src/operator.ts:230-294` — regex order matters for nested matches; undocumented landmine.
- `daemon-sdk/src/tasks.ts:18-31` — mixed `/task` (singular) and `/api/tasks` (plural) URL grammars.
- `daemon-sdk/src/system-route-types.ts:3-18` ↔ `runtime-route-types.ts:210` — divergent surface-kind unions.
- `daemon-sdk/src/knowledge-route-types.ts:81-86` — `buildPacket` returns `Promise<unknown> | unknown` (sync-or-async).
- `daemon-sdk/src/knowledge-route-types.ts:79` — `search` is sync while `ask`/`ingestUrl` are async.
- `daemon-sdk/src/media-route-types.ts:7-13, 31-34` — `VoiceSynthesisStreamLike` and `WebSearchServiceLike` lack `AbortSignal` / cancellation API.
- `daemon-sdk/src/media-route-types.ts:18-20` ↔ `system-route-types.ts:27-31` — two structurally-different `ConfigManagerLike`.
- `daemon-sdk/src/knowledge-route-types.ts:10-15` ↔ `http-policy.ts:5-10` — two `AuthenticatedPrincipalLike`/`AuthenticatedPrincipal` types.
- 48 `as Record<string, unknown>` casts across daemon-sdk; sound but should be `asJsonRecord(value)` helper.
- Peer/operator SDKs offer no `dispose()` / `[Symbol.asyncDispose]`.

---

## 4 — Test Suite (Score: 7.4/10)

165 `.test.ts` files. **0 CRITICAL, 6 MAJOR, 9 MINOR, 7 NITPICK.** Verified: 0 `.skip`/`.only`/`.todo`, 0 empty-body tests, 0 real network calls.

### MAJOR

- **MAJOR-1** — Browser `*.test.ts` files run twice: under `bun:test` (`describe.skipIf(typeof window === 'undefined')` skips the suite, but module-level imports of `dist/browser.js` still execute) AND under vitest+Playwright. Browser-job failures (Playwright launch broken) become silent zero-test passes.
- **MAJOR-2** — Monolithic test files: `knowledge-semantic.test.ts` 3186L / 30 tests in one `describe`; `homegraph-service.test.ts` 1271L / 22 tests; `feature-flag-gates.test.ts` 968L; `operator-sdk-coverage.test.ts` 820L; `homegraph-repair-pages.test.ts` 792L; `auth-auto-refresh.test.ts` 724L.
- **MAJOR-3** — New file `home-graph/page-quality.ts` has no dedicated test. `ingest-compile.ts` and `repair-profile.ts` have **zero** test references by name.
- **MAJOR-4** — `.tmp/` 1.1 GB across 383 dirs leaked by smoke/verdaccio scripts; gitignored but no cleanup logic.
- **MAJOR-5** — `globalThis.fetch` mutation across 12+ files; bun runs files in parallel — capture-original-at-module-load can race and permanently corrupt global until process exit. Affected: `homeassistant-surface`, `voice-tts-stream`, `cloudflare-worker-batch`, `slack-surface-credentials`, `feature-flag-gates`, `auth-auto-refresh-transport-integration`, `traceparent-propagation`, `idempotency-keys`, `transport-middleware`.
- **MAJOR-6** — `live-roundtrip.test.ts:160-163` uses `setTimeout(resolve, 25)` to wait for SSE event; flaky on loaded CI.

### MINOR

- **MIN-1** — Real-vendor URL fixtures (LG NANO90 used 26+ times) — not fetched but visually misleading.
- **MIN-3** — `process.env` mutation patterns without try/finally guard (e.g., `voice-tts-stream.test.ts:72-73`).
- **MIN-4** — 53 files / 160 occurrences of `Date.now()` / `new Date()`; zero `vi.setSystemTime` / `useFakeTimers`. Token-expiry tests vulnerable.
- **MIN-6** — 10 test files import from `dist/` (e.g., `peer-sdk-coverage.test.ts`, `operator-sdk-coverage.test.ts`, `transport-http.test.ts`); default `bun run test` does NOT pre-build, mixing `src/` and `dist/` imports.
- **MIN-7** — `knowledge-browser-history.test.ts:23` mkdtemp without visible afterEach cleanup.
- **MIN-8** — `workers-wrangler/wrangler.test.ts:44` — `12000 + Math.floor(Math.random() * 8000)` port; collision-prone, no `EADDRINUSE` retry.
- Soft auto-pass risk: `sec-08-ssrf-filter.test.ts:67-70, 84-86, 118-120` use `if (!result.ok) { expect(...) }` — if `result.ok` is true the test passes with zero assertions; needs `expect.assertions(N)`.

### NITPICK

- `expect.assertions(N)` count = 0 across the entire suite.
- `toMatchSnapshot` count = 0.
- `test/integration/` only has 2 test files for an "integration" tier.
- Workers/Hermes/Workers-wrangler subtrees not in default test run.

---

## 5 — Build / Tooling / Config (Score: 5.5/10)

31 findings.

### CRITICAL

- **C1** — `packages/sdk/package.json:9-41` declares ~30 unrelated runtime dependencies (`@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`, `@ast-grep/napi`, `bash-language-server`, `cloudflare`, `fuse.js`, `google-auth-library`, `graphql`, `jsdom`, `jszip`, `node-edge-tts`, `openai`, `pdfjs-dist`, `pyright`, `simple-git`, `sql.js`, `sqlite-vec`, `tree-sitter-*` (5), `typescript-language-server`, `vscode-langservers-extracted`, `web-tree-sitter`, `zustand`...). Likely none imported by `packages/sdk/src/`. Verify with grep — if zero, all are dead and would ship hundreds of MB to consumers.
- **C2** — `.tmp/` 1.1 GB across 383 abandoned `goodvibes-sdk-npmrc-*` directories; smoke/verdaccio scripts create scratch dirs with no cleanup.
- **C3** — `sbom.cdx.json` 1.9 MB committed to git; regenerated by CI on every release; also listed in `packages/sdk/package.json:125` `"files"` — stale committed SBOM ships to npm.
- **C4** — `:memory:` file at root (451B) — `.gitignore` comment says "Test leak: code that passes literal ':memory:' as a filesystem path instead of SQLite's in-memory sentinel." Mtime May 2 14:18 means **the bug still exists in source**.
- **C5** — No `bun audit` / Snyk / `osv-scanner`; no `gitleaks` / `trufflehog`; no `.github/dependabot.yml`; no license-compliance check in CI.
- **C6** — `packages/sdk/package.json:113-116` `"./platform/*"` wildcard export exposes every file under `dist/platform/*` as public, importable subpath.

### MAJOR

- **M1** — tsconfig drift: only `packages/sdk/tsconfig.json:11-14` excludes tests; 9 other packages would compile `*.test.ts` if any landed in their `src/`.
- **M2** — Inconsistent engines: root `packageManager: bun@1.3.10` but no `engines`; `packages/sdk` has `engines.bun >=1.0.0`; other packages have nothing.
- **M3** — Root `package.json:71-79` self-references `@pellux/goodvibes-sdk: workspace:*`; phantom cycle for npm/pnpm consumers.
- **M4** — `overrides` blocks duplicated between root and `packages/sdk` with divergent values; child-package overrides are ignored by npm/bun (dead config). Also `lodash 4.18.1` is a non-existent version.
- **M5** — CI `bun install` not `--frozen-lockfile` in `.github/actions/setup/action.yml:21`; PRs can silently mutate the lockfile.
- **M6** — `.github/workflows/ci.yml:127-156` uses `rg` with no install step.
- **M7** — `temp/goodvibes-sdk.api.md` (580 KB) and `etc/goodvibes-sdk.api.md` are stale duplicates differing by 19 bytes.
- **M8** — `.test-tmp/` empty residue; same uncleaned-on-crash pattern.
- **M9** — `tsconfig.type-tests.json` has no `references`; re-typechecks all source from scratch every time. Orphan `tsconfig.type-tests.tsbuildinfo` at root.
- **M10** — `.github/` missing: `PULL_REQUEST_TEMPLATE.md`, `ISSUE_TEMPLATE/*`, `dependabot.yml`, `CODEOWNERS`, `FUNDING.yml`.
- **M11** — `scripts/validate.ts:8` untyped `cmd` param; uses `execSync` (shell semantics) unlike `build.ts`'s `execFileSync`.

### MINOR / NITPICK (selected)

- `examples/` not type-checked in CI; some examples not referenced by `scripts/docs-completeness-check.ts`.
- `vendor/uuid-cjs/package.json` claims `"version": "14.0.0"` (uuid v14 doesn't exist).
- `vendor/bash-language-server/` (1.9 MB) committed source + `out/` build artifacts.
- `bundle-budgets.json` rationale comment dated 2026-04-17 (2 weeks stale).
- `vitest.browser.config.ts` requires manual pre-build; no globalSetup.
- CHANGELOG.md is 237 KB / 3000+ lines, no version sectioning.
- `.codex` empty file at root.
- `release.yml` pins actions to `@v4` (drift risk); `ci.yml` pins by SHA. Mixed policy.

---

## 6 — Docs / Security / Examples (Score: 8.2/10)

22 findings. All cross-refs resolve, anchors valid, no TODO/FIXME, no placeholders.

### MAJOR

- **M-1** `SECURITY.md:7-8` — Supported Versions table claims `0.25.x` is supported; repo ships `0.28.22`. Should be `0.28.x`.
- **M-2** `examples/daemon-fetch-handler-quickstart.ts:8` — `version: '0.18.2'` literal; repo at `0.28.22`.

### MINOR

- **m-1** `README.md:140-171` "Current Documentation" section omits ~27 of 50 docs in `docs/`. Either link them all or collapse to a pointer.
- **m-2** `README.md:77-80` vs `docs/getting-started.md:27-28` — disagreement on import path for `createMemoryTokenStore` (root vs `/auth` subpath).
- **m-3** `README.md:84` Quick Start missing `createMemoryTokenStore()` empty-arg fallback.
- **m-4** `docs/security.md` — repo-internal source paths cited inconsistently.
- **m-5** `examples/peer-http-quickstart.mjs:5` uses `GOODVIBES_PEER_TOKEN`; every other example uses `GOODVIBES_TOKEN`.
- **m-6** `examples/daemon-fetch-handler-quickstart.ts:10-33` synchronous stub returns lack type annotations.
- **m-7** `examples/expo-quickstart.tsx:19`, `react-native-quickstart.ts:11` — use `sdk.realtime.runtime()` while `docs/getting-started.md:70,157` recommend `viaWebSocket()` for RN/Expo.

### NITPICK

- `LICENSE:3` Copyright 2026 (intentional given current date but unusual).
- `CONTRIBUTING.md:47` references `throw-guard` but no local script; CI-only.
- `README.md:116-120` Cloudflare Worker example calls `createGoodVibesCloudflareWorker()` with no args.
- `docs/README.md:54-55` doesn't link `docs/automation.md`.
- `SECURITY.md:69` reports vuln to a personal Gmail; enterprise expects `security@`.
- `examples/` lacks `README.md`, `package.json`, `tsconfig.json`.
- `examples/submit-turn-quickstart.mjs:9` says `node examples/...` while `CONTRIBUTING.md:3` is Bun-only.
- `CHANGELOG.md` six releases dated `2026-05-02` — confirm dates not auto-stamped.
- `docs/security.md` 446 lines, no top-level TOC.
- `docs/getting-started.md:103-113` Cloudflare Worker example too thin.

---

## Top-Priority Recommendations (informational only — no fixes were applied)

These are the highest-leverage fixes; each addresses multiple findings at once:

1. **Eliminate `packages/sdk/src/_internal/` mirrors of `contracts/errors/transport-*`** — replace with workspace dependencies. Single biggest debt item; resolves ~63 findings at once.
2. **Audit `packages/sdk/package.json` `dependencies`** — verify each is imported; remove dead entries before next publish.
3. **Find the `:memory:` SQLite source bug** — locate the call that passes `':memory:'` as a filesystem path; fix the source rather than gitignore the artifact.
4. **Ban empty `catch {}` and `void p.catch(() => {})`** via lint rule + `swallowError(error, context)` helper.
5. **Ban bare `setTimeout`** without `.unref()` via lint rule (or wrap in helper).
6. **Move LG-TV-specific blocklists out of code** into versioned config with regression fixtures.
7. **Add CI security gates**: `bun audit`, `gitleaks`, `dependabot.yml`, license check.
8. **Remove committed SBOM and add to `.gitignore`**; ensure CI regenerates before publish.
9. **Decompose `DaemonApiRouteHandlers`** into per-route-group interfaces.
10. **Generate operator/peer SDK client namespaces from contract metadata** — eliminate ~150 lines of mechanical boilerplate.
11. **Add `"engines"` and per-package test scripts** to all packages.
12. **Update `SECURITY.md` supported versions** (`0.25.x` → `0.28.x`); bump stale `0.18.2` literal.
13. **Reset `globalThis.fetch` race protection** — snapshot-per-`beforeEach`, not module-load capture.
14. **Add a clean-up step** for `.tmp/` (1.1 GB leak) and `.test-tmp/`.
15. **Fix idempotency-key regeneration on retry** in `transport-http/src/http-core.ts:404-406`.
16. **Fix WebSocket `onOpen` race + reconnect-counter logic + `wss://` enforcement** in `transport-realtime/src/runtime-events.ts`.

---

*Reports produced by 6 parallel `goodvibes:reviewer` agents on 2026-05-02. Files reviewed: ~250 across packages, tests, configs, and docs.*
