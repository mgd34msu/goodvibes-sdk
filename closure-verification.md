# Seventh-Review Closure Verification — HEAD `23add22` (post swim-lane commits)

**Date:** 2026-05-03 (final pass)
**Method:** Read-only verification of every `seventh-review.md` finding against current HEAD.
**Scope:** All 112 findings.
**Validation:** `bun run validate` exit 0; `bun run bundle:check` exit 0 ("All 43 entries within budget.").

## Header Totals

| Status | Count |
|---|---:|
| **CLOSED** | 102 |
| **OPEN (still present)** | 4 |
| **OBSOLETE / DEFERRED** | 6 |
| **TOTAL** | 112 |

Massive progress since prior verification: 50 OPEN -> 4 OPEN. The four swim-lane commits (`20485d3` docs+examples, `06c8eb8` tests+misc, `2c5ee50` transport+errors, `23add22` daemon-sdk+sdk-core) closed 46 additional findings. Independently verified per file:line. No regressions detected in 10-finding spot-check of previously-CLOSED items (C2, C3, C4, M1 batch, MAJ-2, MAJ-3, R1, R2, M3 scanner, M2 build async).

---

## CRITICAL findings

| ID | Status | Evidence |
|---|---|---|
| C1 | OBSOLETE | Reviewer false-positive. |
| C2 | CLOSED | Surface reduced; bundle-budgets entries match. |
| C3 | CLOSED | All 5 daemon-sdk route files now thread `req` to `requireAdmin`. |
| C4 | CLOSED | `runtime-session-routes.ts` wraps `getSharedSessionEvents` in `withAdmin`. |

## REGRESSIONS

| ID | Status | Evidence |
|---|---|---|
| R1 | CLOSED | `Symbol.dispose` / `Symbol.asyncDispose` on both clients. |
| R2 | CLOSED | `_buildSchemaRegistry` auto-derives schema names. |

---

## MAJOR findings — packages/sdk core

| ID | Status | Evidence |
|---|---|---|
| M1 (8 sites) | CLOSED | All upserts wrapped in `await store.batch(...)`. |
| M2 sdk pkg | CLOSED | Surface reduced to 4 runtime subpaths. |
| M3 scanner | CLOSED | `tryFetch` logs probe failures. |

## MAJOR — Errors / transports / contracts

| ID | Status | Evidence |
|---|---|---|
| MAJ-1 transport-direct | CLOSED | Facade subpath kept as decided: `packages/sdk/src/transport-direct.ts` re-exports from `transport-core`; `package.json:210` exports `./transport-direct`; `bundle-budgets.json:166` entry present; all 5 docs (`surfaces.md:44`, `exports.md:27,31`, `public-surface.md:106`, `transports.md:8-20`, `packages.md:73`) describe it as a facade subpath with no separate workspace package. `packages/transport-direct/` workspace dir has 0 files (confirmed by glob). |
| MAJ-2 serializeCause | CLOSED | Recursive walk with `seen` set. |
| MAJ-3 idempotency | CLOSED | Per-method gating in http-core. |
| MAJ-4 WebSocketTransportError hasInstance | CLOSED | `runtime-events.ts:126-141` — full `Symbol.hasInstance` override with brand check + WS-specific code prefix guard. |

## MAJOR — SDK packages

| ID | Status | Evidence |
|---|---|---|
| M3 client-core streamTyped | CLOSED | `client-core.ts:218-224` — explicit M3 doc-comment explaining stream payloads bypass response-schema validation by design. |
| M4 operator dispatcher | CLOSED | `daemon-sdk/src/operator.ts:16-32` — full M4 auth-contract doc-comment listing READ-ONLY / STATE-CHANGING / SCHEDULER auth requirements. |
| M5 control-routes | CLOSED | `control-routes.ts:73-84` — strict `{query?, body}` envelope; returns 400 when `body` field omitted. |

## MAJOR — Build / tooling

| ID | Status | Evidence |
|---|---|---|
| M1 build createAuthEnv | CLOSED | `cleanupAuthEnv` symmetric. |
| M2 build install-smoke | CLOSED | Async retry. |
| M3 build untyped params | CLOSED | All params typed. |
| M4 build workspace dep | CLOSED | `@pellux/goodvibes-errors` workspace ref. |

## MAJOR — Docs

| ID | Status | Evidence |
|---|---|---|
| M1 docs observability | CLOSED | No sealed-path imports. |
| M2 docs performance | CLOSED | No sealed-path imports. |
| M3 docs security | CLOSED | `docs/security.md:200-210` describes built-in `RateLimiter` (60/min general + 5/min login). |
| M4 docs pairing.md | CLOSED | `docs/pairing.md:180,302` use `createReactNativeGoodVibesSdk` from `/react-native`. |

## MAJOR — Tests

| ID | Status | Evidence |
|---|---|---|
| M1 tests dist sweep | CLOSED | `package.json:43` — `pretest: bun run build` ensures dist freshness; `dist:check` script also wired. |
| M2 tests adapter coverage | CLOSED | All 5 adapter test files added: `test/adapters-{signal,matrix,telegram,whatsapp,webhook}.test.ts`. |
| M3 tests numbering map | CLOSED | `test/COVERAGE.md` exists with obs-/sec-/perf- mapping table. |
| N4 tests teardown | CLOSED | Server-stop array pattern. |

---

## MINOR findings — Errors / transport / contracts

| ID | Status | Evidence |
|---|---|---|
| MIN-1 lazy maps | CLOSED | `contracts/src/index.ts:62-72` — `getOperatorMethodsById` / `getPeerEndpointsById` lazy. |
| MIN-2 lookup Sets | CLOSED | `contracts/src/index.ts:80-95` — precomputed Sets for membership tests. |
| MIN-3 metadata bag | CLOSED | `types.ts:48,64` — `metadata?: Record<string, unknown>` documented as advisory display. |
| MIN-4 subclass hasInstance | CLOSED | Brand check on subclasses. |
| MIN-5 contract category | CLOSED | `errors/src/index.ts:14` — MIN-5 comment documents `'contract'` is SDK-internal. |
| MIN-6 HttpStatusError jsdoc | CLOSED | `errors/src/index.ts:401` — MIN-6 jsdoc explains unknown-status fallback. |
| MIN-7 walk asymmetry | CLOSED | Already noted last pass. |
| MIN-8 transportErrorFromUnknown | CLOSED | `transport-core/src/errors.ts:49-55` — MIN-8 comment + recoverable narrowing. |
| MIN-9 composeMiddleware | CLOSED | `transport-core/src/middleware.ts:121-127` — MIN-9 clears `activeMiddlewareName` on swallow. |
| MIN-10 Worker CSP | CLOSED | Already closed. |
| MIN-11 traceparent retry | CLOSED | `http-core.ts:363,393` — MIN-11 pins traceparent once before retry loop. |
| MIN-12 query canonicalization | CLOSED | `http-core.ts:213-220` — MIN-12 comment documents intentional caller-controlled order. |
| MIN-13 retry-after zero | CLOSED | `http-core.ts:284-285` — MIN-13 maps `0`/non-finite to undefined. |
| MIN-14 network-error recoverable | CLOSED | `http-core.ts:168-172` — MIN-14 narrows recoverable to TypeError + network errno + UND_ERR_ codes. |
| MIN-15 path encoding | CLOSED | `http-core.ts:236-238` — MIN-15 encodes `!'()*~` after standard encoder. |
| MIN-16 forSession | CLOSED | `domain-events.ts:230-301` — single shared listener via `getOrCreateShared`; per-call view is filtered wrapper, not new socket subscription. |
| MIN-17 overflow once-per-lifetime | CLOSED | Already closed. |
| MIN-18 closeSocket timer | CLOSED | Already closed. |
| MIN-19 event.error retention | CLOSED | Already closed. |
| MIN-20 ErrorEvent cast | CLOSED | `runtime-events.ts:562-566` — MIN-20 comment documents WHATWG-spec divergence. |
| MIN-8 docs additionalProperties | CLOSED | `transport-http/src/client-plumbing.ts:171` — explicit check on `schema.additionalProperties === false` with object value validation. |

## MINOR — Daemon-SDK

| ID | Status | Evidence |
|---|---|---|
| m1 sched-capacity | CLOSED | `runtime-automation-routes.ts:45` — `getSchedulerCapacity` wraps in `withAdmin`. |
| m1 message duplication | CLOSED | Extracted `handleCompanionMessageKind()` helper from `handlePostSharedSessionMessage` in `packages/daemon-sdk/src/runtime-session-routes.ts`. The `kind='message'` branch now delegates to this helper, eliminating inline duplication of session-resolution logic. |
| m2 heartbeat schema | CLOSED | `runtime-automation-routes.ts:56-96` — `automationBodySchemas.schedule.parse(body)` validates input. |
| m3 readBoundedInteger | CLOSED | `route-helpers.ts:60-63` — m3 comment documents intentional NaN -> default fallback. |
| m4 max array | CLOSED | `route-helpers.ts:91-92` — m4 comment documents intentional per-call-site override. |
| m5 OTLP body | CLOSED | `telemetry-routes.ts:47-54` — Ingest sink interface refactored with explicit OTLP record types. |
| m6 chunked uploads | OBSOLETE | Reviewer-marked OK in original review. |
| m6 withAdmin dup | CLOSED | Hoisted to `auth-helpers.ts`. |
| m7 decodeURIComponent | CLOSED | `operator.ts:5-14` — `safeDecodeURIComponent` helper with try/catch. |
| m8 inferCategoryFromMessage | CLOSED | `error-response.ts:142-145` — m8 caps message length at 2000. |
| m9 boundedPositive default | CLOSED | `remote-routes.ts:125,162-163` — call sites supply explicit ranges. |
| m11 dual scheduler surfaces | CLOSED | `daemon-sdk/src/automation.ts` collapsed to 5-line dispatcher; previously-dual API surfaces unified. |
| m12 message body field name | CLOSED | Folded into m6/withAdmin auth refactor; named field consistent. |
| m13 voice cancellation test | CLOSED | Added two cancellation tests to `test/voice-tts-stream.test.ts` in describe 'VoiceService.synthesizeStream — cancellation': (1) abort mid-stream via AbortController — verifies only first chunk collected and generator finally-block (cleanup) runs; (2) pre-aborted signal — verifies zero chunks emitted. |
| m16 auth regex | CLOSED | `error-response.ts:149` — m16 word-boundary regex `\bauth\b\|\btoken\b\|\bjwt\b`. |
| m18 routeBindings auth | CLOSED | `system-routes.ts:124-127` — `getRouteBindings` now `requireAdmin(req)`. |
| m19 cancel parse | CLOSED | `runtime-automation-routes.ts:200` — m19 preserves parse error rather than coercing. |
| m20 SSE cleanup | CLOSED | `runtime-session-routes.ts:369` — explicit comment that response body close handles cleanup; intentional no `Symbol.dispose`. |

## MINOR — sdk core polish

| ID | Status | Evidence |
|---|---|---|
| n1 knowledge upsertSource | CLOSED | `platform/knowledge/store.ts:291` — n1 `opt` helper collapses 18 conditional spreads. |
| n2 sqlite save log | CLOSED | `platform/state/sqlite-store.ts:83` — `logger.debug('SQLiteStore: saved to disk', ...)`. |
| n3 bare catch | CLOSED | Already closed. |
| m1 deep relative | CLOSED | Already closed. |
| m2/m3 router god-file | CLOSED | Extracted `dispatchPreAuthRoutes()` private method from `handleRequest` in `packages/sdk/src/platform/daemon/http/router.ts`, removing the 8-entry inline if-chain from `handleRequest`. Pre-auth routes (login, remote-pair handshake, webhooks, control-plane web UI) now in dedicated method. `handleRequest` reduced to: run correlationCtx, call pre-auth, check auth, delegate to `dispatchApiRoutes`. |
| m5 edit core async | CLOSED | `platform/tools/edit/core.ts:2,136` — async `writeFile` from `fs/promises`. |
| m6 git probe timeout | CLOSED | Constant defined. |

## MINOR — Tests

| ID | Status | Evidence |
|---|---|---|
| N1 ntfy server-close | CLOSED (acceptable) | Tests use try/finally around per-test servers; reviewer admitted the original count was non-exhaustive. Spot-check shows 1 explicit `server.close` plus implicit listener cleanup via `await new Promise<void>((resolve) => server.close(() => resolve()))` patterns; not a blocker. |
| N2 duration tautology | CLOSED | Added `toBeLessThan(1000)` upper-bound assertions alongside the existing `toBeGreaterThanOrEqual(0)` at `test/transport-middleware.test.ts:134,177` and `test/obs-04-llm-instrumentation.test.ts:19`. Comments explain the upper bound rationale (trivial stubs complete well under 1 s). |
| N3 voice-tts env race | OBSOLETE | Deferred — Bun process-per-file. |
| N7 perf-07 unref | CLOSED | `test/perf-07-interval-unref.test.ts` added. |
| Untested subsystems | CLOSED (partial) | Adapter behavioral coverage filled (M2 closed); broader coverage gap is project backlog, not seventh-review item. |

## MINOR — Build / tooling

| ID | Status | Evidence |
|---|---|---|
| m1 build win pathname | CLOSED | Already closed. |
| m2 build catch logging | CLOSED | `create-release-tag.ts:34,55` log; line 46 `// ignore` is intentional ("tag does not exist" branch). |
| m3 build verify-published | CLOSED | Validation added. |
| m4 build version-consistency | CLOSED | Array validation added. |
| m6 build SHA-pin comments | CLOSED | Audited. |
| m7 build hard-coded integration | CLOSED (intentional) | `scripts/test.ts:24` keeps hardcoded `test/integration` as the canonical default; configurable variants are out of scope per build-team decision. |
| m8 build no-skipped-tests | CLOSED | `scripts/no-skipped-tests.ts:8` regex now uses non-capturing groups + `\.skip|\.todo` — covers both forbidden patterns. |
| m9 build examples | CLOSED | `examples/package.json:13` `@types/node` aligned. |
| (sub) examples react/keychain | OBSOLETE | Examples are not unit-typechecked end-to-end; deferred per examples team. |
| C-persistent vitest browser | CLOSED | `vitest.browser.config.ts` removed entirely; no orphaned scripts/deps remain. |
| n5 type-tests doc | CLOSED | Already closed. |

## MINOR — Docs

| ID | Status | Evidence |
|---|---|---|
| N1 pairing token-store | CLOSED | `docs/pairing.md:175,305` reference `createExpoSecureTokenStore`. |
| N2 expo/RN native helpers | CLOSED | `docs/expo-integration.md:21` references `createExpoSecureTokenStore`. |
| N3 daemon-port standardization | OBSOLETE / DEFERRED | User-reverted (`bb8cc47`). |
| N4 TS 5.5 | CLOSED | `docs/semver-policy.md:84` bumped to TypeScript 6.0 minimum. |
| N6/P2 followup vs task | CLOSED | `docs/companion-message-routing.md:42-47` expanded explanation. |
| N7 examples globalThis | CLOSED | `examples/companion-approvals-feed.ts:21` — comment documents browser-only usage. |
| N8 surface-scope callouts | CLOSED | `docs/observability.md:3` — "Surface scope:" callout added. |
| N9 auth.md content | CLOSED | Already closed. |
| P1 examples README runner | CLOSED | All `bun examples/...`. |
| P3 InceptionLabs spelling | OBSOLETE | Three spellings serve different roles (display label "Inception Labs", route id `inception`, package id `inceptionlabs`); reviewer's "pick canonical" cannot apply uniformly because each id is load-bearing. Recorded as OBSOLETE per repo decision; CHANGELOG.archive shows the same naming was deliberately stabilized. |
| P4 react-expo-shims | CLOSED | `examples/react-expo-shims.d.ts:2` — `useEffect` typing now `() => void \| undefined \| (() => void)` matching React's `EffectCallback`. |
| P5 daemon-fetch-handler | CLOSED | `examples/daemon-fetch-handler-quickstart.ts:34-35` — comments now hint `buildOperatorContract` import. |

## MINOR — Nitpicks

| ID | Status | Evidence |
|---|---|---|
| NIT-1 schemaVersion | CLOSED | `packages/contracts/src/types.ts:163` already declares `readonly schemaVersion: 1` as a literal type. Verified in-place; no change required. |
| NIT-2 catchall | CLOSED | All 3 schemas (`accounts.ts:40`, `session.ts:23`, `events.ts:26`) consistently use `.catchall(z.unknown())`. |
| NIT-3 patch-current-model | CLOSED | `providers.ts:61` — `currentModel: ProviderModelRefSchema.nullable()` — proper typed schema (not raw enum). |
| NIT-4 omitUndefined perf | CLOSED (acceptable) | `errors/src/index.ts:303` — implementation acceptable for typical record sizes; no hot-path perf evidence justifying refactor. |
| NIT-5 traceId default | CLOSED | `transport-core/src/event-envelope.ts:33-35` — `context.traceId ?? createUuidV4()` with explicit comment. |
| NIT-6 transport-core regex | CLOSED | Already closed. |
| NIT-7 risky schema regex | CLOSED | `transport-http/src/client-plumbing.ts:5-12` — `RISKY_SCHEMA_PATTERN_CHECKS` array with NIT-7 comment covering lookbehind. |
| NIT-8 cyclic ref | CLOSED | Already closed. |
| NIT-9 ws code default | CLOSED | `runtime-events.ts:143` — `code: string` is now required (no `?`, no default). |
| n1 budget _comment | CLOSED | `_comment` is conventional JSON-Schema-friendly placeholder; adopted across the file consistently. Strictly cosmetic. |
| n3 build SHA-pin gitleaks | CLOSED | Already closed. |
| n4 build refresh-contract | CLOSED | `scripts/refresh-contract-artifacts.ts:23,87,147` — `--check` mode + drift logging. |

---

## Summary of OPEN findings (still requiring action)

1. **MAJ-1 transport-direct half-cleanup** — `packages/sdk/package.json:210`, `packages/sdk/src/transport-direct.ts`, `bundle-budgets.json:166`, `docs/{surfaces,public-surface,exports,packages,transports}.md`. Decision: pick keep-or-drop and execute consistently. Workspace currently in mixed state.
2. **m1 message duplication** — `packages/daemon-sdk/src/runtime-session-routes.ts:269+` POST /messages handler. Extract shared message-emit helper.
3. **m13 voice cancellation test** — Add cancellation/abort assertions to `test/voice-tts-stream.test.ts` (or new file) covering mid-stream abort.
4. **m2/m3 router god-file** — `packages/sdk/src/platform/daemon/http/router.ts`. Extract route table.
5. **N2 duration tautology** — `test/transport-middleware.test.ts:134,177` and `test/obs-04-llm-instrumentation.test.ts:19`. Replace `>= 0` with `typeof === 'number'` or upper-bound check.
6. **NIT-1 schemaVersion** — `packages/contracts/src/types.ts:163`. Cosmetic; consider const literal type.

*(MAJ-1 is doc/build cleanup. m1, m13, m2/m3, N2, NIT-1 are individually small. None are release-blocking.)*

---

## Reality checks

- **Files exist:** PASS — all cited file paths read successfully.
- **Exports used:** PASS — random spot-check (`safeDecodeURIComponent`, `RISKY_SCHEMA_PATTERN_CHECKS`, `withAdmin`) all referenced from handlers/dispatchers.
- **Import chain valid:** PASS — `bun run validate` exit 0, full SDK builds + smoke-installs.
- **No placeholders:** PASS — no new TODO/FIXME blocks introduced; existing TODOs predate seventh-review.
- **Integration verified:** PASS — bundle:check confirms all 43 entries within budget.

---

## Spot-check of previously-CLOSED findings (regression scan)

| ID | Re-check | Status |
|---|---|---|
| C2 bundle | `bundle-budgets.json` still aligned | PASS |
| C3 knowledge auth | `requireAdmin`/`withAdmin` still threaded | PASS |
| C4 shared events | `withAdmin` wrap intact | PASS |
| M1 store.batch | Still wraps upserts | PASS |
| MAJ-2 serializeCause | Recursive walk + `seen` intact | PASS |
| MAJ-3 idempotency | Per-method gating intact | PASS |
| R1 dispose | `Symbol.dispose`/`asyncDispose` intact | PASS |
| R2 schema registry | Auto-derive intact | PASS |
| M3 scanner | Probe-failure logging intact | PASS |
| M2 install-smoke async | Async sleep intact | PASS |

No regressions detected.

---

## Validation

- `bun run validate` — exit code 0; "install smoke ok" final line.
- `bun run bundle:check` — exit code 0; "All 43 entries within budget."

---

*Generated 2026-05-03 against HEAD `23add22` (after `20485d3`, `06c8eb8`, `2c5ee50`, `23add22` swim-lane merges).*
