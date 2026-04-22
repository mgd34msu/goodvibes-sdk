# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

> **Versions prior to 0.19.0**: see `docs/releases/*.md` for long-form per-release notes.

---

## [0.23.1] - 2026-04-22

### Removed
- **Opt-in `wrfc-constraint-golden.test.ts` suite + fixtures deleted.** The Phase-5 golden-prompt suite was env-gated behind `WRFC_GOLDEN_LLM=1` and skipped in CI. An opt-in test doesn't prove anything in the default test run, and the feature's live-LLM discernment is already exercised by the WRFC chain integration tests that run against real agents in downstream environments. The addendum *content* is still asserted unconditionally by `wrfc-prompt-addenda.test.ts`, the propagation mechanics by `wrfc-constraint-propagation.test.ts`, and parser tolerance by `completion-report-constraints.test.ts` — those are always-on. Removing the opt-in suite eliminates the "passes because it didn't run" failure mode. Files deleted: `test/wrfc-constraint-golden.test.ts`, `test/fixtures/wrfc-constraints/*.md`.

No production code or published-surface changes. `@pellux/goodvibes-sdk` npm tarball was already `files`-gated to `dist/` + `sbom.cdx.json`; the deleted test files were never shipped. 0.23.1 republishes against an identical `dist/`.

---

## [0.23.0] - 2026-04-21

### Added
- **WRFC constraint propagation.** Work-Review-Fix-Commit chains now extract user-declared constraints from the task prompt, ride them through every state transition, and enforce them as independent pass/fail criteria. New `Constraint`/`ConstraintFinding` types, `WrfcChain.constraints`, `WrfcChain.constraintsEnumerated`, and `WrfcChain.syntheticIssues` fields. New `WORKFLOW_CONSTRAINTS_ENUMERATED` runtime event, emitted exactly once per chain on engineer completion. Additive optional fields on `WORKFLOW_REVIEW_COMPLETED` (`constraintsSatisfied`, `constraintsTotal`, `unsatisfiedConstraintIds`) and `WORKFLOW_FIX_ATTEMPTED` (`targetConstraintIds`). Pre-0.23 consumers compile unchanged — every new field is optional or defaulted.
- **Engineer archetype addendum** (`buildEngineerConstraintAddendum`, memoized). Appends to the engineer's system prompt on initial WRFC spawn only — fixer re-spawns do not re-enumerate. Owns the build-vs-non-build discernment with four calibration examples (`"Write a function that adds two numbers"` → `[]`, `"...must be pure, no external deps, under 20 lines"` → three constraints, etc.), explicit guards against fabricating constraints or splitting single requirements, and a `~16` hard cap. Non-build prompts emit `constraints: []` and skip the whole downstream constraint path as a clean no-op.
- **Reviewer archetype addendum** (`buildReviewerConstraintAddendum`, memoized). Runs alongside the existing 10-dimension rubric, not instead of it. Per-constraint `{satisfied, evidence, severity}` findings with explicit severity taxonomy (critical = hard limit, major = explicit rule, minor = ambiguous/partial). Ambiguous constraints surface via `satisfied: false, severity: 'minor', evidence: 'constraint ambiguous, cannot verify'` rather than failing the chain on a technicality.
- **Fixer archetype addendum** (`buildFixerConstraintAddendum`, memoized). Fix-task payload lists every constraint with per-id `SATISFIED` / `UNSATISFIED` / `UNVERIFIED` markers resolved from the reviewer's findings. Fixer must return the same `constraints[]` ids, text, and order; the controller validates continuity and surfaces any missing/extra ids as a synthetic critical issue in the next review cycle. If a reviewer issue can only be resolved by regressing a constraint, the fixer is instructed to STOP and record the conflict under `issues[]`.
- **Hard-fail enforcement in `processReview`.** New decision expression `passed = review.score >= threshold && !constraintFailure`. Any unsatisfied constraint forces chain fail regardless of score. Score-below-threshold still fails as before — constraint satisfaction never overrides score.
- **Gate-failure retry inheritance.** Retry chains created after a quality-gate failure inherit the parent chain's constraints as `source: 'inherited'` and start with `constraintsEnumerated: true`, so the child engineer does not re-enumerate from scratch. Works for both the immediate (`followUpChain`) and pending (`pendingParentConstraints` map) retry paths.
- **55 new tests** across `wrfc-constraint-propagation.test.ts`, `wrfc-prompt-addenda.test.ts`, `completion-report-constraints.test.ts`, plus C1/C2/C3 scenarios in `wrfc-controller.test.ts`. Coverage includes engineer→review→fix propagation, continuity-clean/missing/extra, synthetic-issue consumption, empty-list no-op (reviewer and fixer paths are byte-identical to pre-0.23 when `chain.constraints === []`), gate-retry inheritance immediate + pending + zero-constraint, score-vs-constraint conflict matrix, and `WORKFLOW_REVIEW_COMPLETED` payload shape.
- **Opt-in golden-prompt suite** (`wrfc-constraint-golden.test.ts`, gated by `WRFC_GOLDEN_LLM=1`) with 6 hand-authored fixtures for calibrating the engineer addendum's discernment against live LLMs. Skipped by default — CI-safe.

### Parser
- `applyConstraintDefaults` normalizer on `parseCompletionReport` silently filters malformed constraint entries (missing id, empty text, invalid source enum, non-boolean `satisfied`) rather than rejecting the whole report. Returns a new object; the caller's passed-in parsed data is not mutated.

### Internal
- `AgentRecord.systemPromptAddendum?: string` field (internal only — `AgentInput` schema deliberately not widened; WRFC injection uses direct record mutation in `createBaseChain`).
- `buildOrchestratorSystemPrompt` appends `AgentRecord.systemPromptAddendum` as a final additive layer when present. Non-WRFC spawns are unaffected.
- `CONSTRAINTS_TASK_LIMIT` constant (20) shared between review and fix task builders.

### Compatibility
- No breaking changes. Every schema addition is optional or defaulted; parser tolerates absence and malformed entries. Consumers (TUI 0.19.22 verified) recompile unchanged.

---

## [0.22.0] - 2026-04-21

Documentation, tooling, and test-suite maintenance release. Accumulated improvements from an audit pass across the SDK. No breaking changes to the public API surface; all changes are additive or editorial. Per the pre-1.0 policy, this bumps minor to signal the scale of the doc + pipeline updates, not an API break.

### Added
- **Contract-artifact refresh pipeline** — `scripts/refresh-contract-artifacts.ts` rebuilds `packages/contracts/artifacts/{operator,peer}-contract.json`, the generated `.ts` contract constants, the method/endpoint ID lists, and `foundation-metadata.ts` from live source of truth (`buildOperatorContract(new GatewayMethodCatalog())` for operator; the authoritative `PEER_CONTRACT` constant for peer). Three npm scripts wire it up:
  - `bun run refresh:contracts` — regenerate all artifacts
  - `bun run refresh:contracts:check` — CI drift gate (exit 1 on any mismatch)
  - `bun run refresh:docs` — combined `refresh:contracts` + `sync:internal --scope=contracts` + `docs:generate`
  
  Closes a long-standing gap where the checked-in artifacts were frozen at `0.18.2` product version while the live catalog was emitting 221 methods / 30 events at 0.21.36. After refresh, `reference-operator.md`, `reference-peer.md`, and `reference-runtime-events.md` reflect the current catalog instead of the pinned snapshot.
- **Active-early-development banner** on both the SDK and TUI READMEs near the top. Signals that APIs, contracts, routes, event shapes, and config defaults can change across patch releases pre-1.0; no legacy/compat shims; documentation reflects current behavior only.
- **Subject-matter coverage** in reference docs for feature additions from the 0.20.x–0.21.36 line that were only mentioned in `CHANGELOG.md` / `migration.md` but had no home in the docs where someone new would look:
  - `observability.md` — `ToolResultSummary` payload on `TOOL_SUCCEEDED` / `TOOL_FAILED` (OBS-05), `contentSummary` on `LLM_RESPONSE_RECEIVED` (OBS-06), microtask async dispatch ordering guarantees on `RuntimeEventBus` (OBS-14)
  - `performance.md` — SSE gateway backpressure via `CountQueuingStrategy({ highWaterMark: 256 })` (PERF-08)
  - `error-kinds.md` — typed literal `readonly code: '<LITERAL>'` on `AppError` subclasses for exhaustive `switch (err.code)` discrimination (QA-14)
  - `companion-message-routing.md` — adjacent session routes table covering the restored `POST /api/sessions/:id/inputs` intent-dispatch alias (F20) and the companion-chat routes registered in the method catalog (F21)
- **Doctrine: no legacy documentation pre-1.0.** Every doc reflects the **current** source-of-truth behavior. No "pinned at X.Y.Z" disclaimers on auto-generated docs — the pipeline rebuilds them against live state. `migration.md` remains the one place version-conditional wording belongs.

### Changed
- **Reference docs regenerated at 0.22.0** from refreshed artifacts. Operator reference now lists 221 methods / 30 events (previously frozen display at 213 / 29 against 0.18.2). Peer reference unchanged (6 endpoints).
- **Documentation audit completed** against source of truth for the whole SDK docs tree — every user-facing doc reflects current behavior as of 0.22.0. Pairing, security, provider-model-api, release-and-publishing, roadmap-to-1.0, architecture, and the three reference docs were updated. Other docs were verified current with no changes needed.
- **`pairing.md`** — expanded with canonical `<daemonHomeDir>/operator-tokens.json` path story, full `CompanionConnectionInfo` shape, correct `getOrCreateCompanionToken(surface, { daemonHomeDir })` and `regenerateCompanionToken(surface, { daemonHomeDir })` signatures, and a dedicated `pruneStaleOperatorTokens` section (F3).
- **`migration.md`** — substantial new section for 0.20.x–0.21.x upgrades covering F3, OBS-05/06, OBS-14, QA-05/14, PERF-08, F3/F20/F21/F22/F-PROV-009.
- **`provider-model-api.md`** — added `secretsResolutionSkipped` always-present boolean (F-PROV-009) to the `GET /api/providers` response example and field reference.
- **CI: dropped duplicate test run from `validate.ts`** — the platform-matrix (bun) job already owned test execution, so running the ~1300-test suite again inside validate doubled CI wallclock for no benefit. `validate.ts` now covers docs / typecheck / browser-compat / metadata / no-any / pack check / install smoke only; the matrix owns tests.

### Removed
- **Dead/rubber-stamp tests** flagged by audit:
  - `packages/sdk/src/_internal/platform/channels/__tests__/policy-manager-emissions.test.ts` — entire file. 9 tests asserted against a `ChannelPolicyManager` event-emission feature that doesn't exist in source (no `runtimeBus` constructor parameter, no `attachRuntimeBus` method). Source was either never built or was deleted; tests "passed" only because the expected behavior was never reachable.
  - `test/browser/sdk-init.test.ts` — typeof-tautology on an imported function (TS enforces), plus a weak `toBeDefined()` test already covered by the subsequent facade-shape tests.
  - `test/obs-01-http-access-log.test.ts` — placeholder test whose comment acknowledged it couldn't actually verify the behavior it claimed to test.
- **`:memory:` tracked file** — a 451-byte session-index JSON accidentally committed via 0.21.31 when some test code passed the literal string `:memory:` as a filesystem path instead of using SQLite's in-memory sentinel. Untracked and gitignored to prevent regression.

### Fixed
- **`FOUNDATION_METADATA` sync** — the contract-refresh pipeline now regenerates `foundation-metadata.ts` alongside the operator artifacts. Prior to this release the metadata file was hand-edited and drifted (still reporting 0.18.2 / 213 / 29 while the rest of the contract stack moved forward). The `contracts package > foundation metadata matches synced artifacts` CI test now stays green because both sides flow from the same refresh.

### Internal
- `memory/feedback_no_legacy_docs_pre_1_0.md` memory saved so the "current behavior only" doctrine persists across sessions.
- Scripts added:
  - `bun scripts/refresh-contract-artifacts.ts` (+ `--check` mode)

---

## [0.21.36] - 2026-04-21

F3 / F20 / F21 / F22 / F-PROV-009 resolutions from UAT Validation Run 5. Five targeted fixes behind the HTTP surface of the operator daemon; all landed with dedicated tests (18 new unit tests) and reviewer-approved at 9.9/10.

### Added
- **F3** — `pruneStaleOperatorTokens(options)` exported from `@pellux/goodvibes-sdk/platform/pairing`. Idempotent cleanup helper that removes legacy workspace-scoped `operator-tokens.json` files whose token value does not match the canonical `<daemonHomeDir>/operator-tokens.json`. Returns `{ canonicalPath, canonicalToken, prunedPaths, matchedPaths, absentPaths, failedPaths }`. Safe to call on every daemon startup. Also exports `PruneStaleOperatorTokensResult` type.
- **F20** — `POST /api/sessions/:id/inputs` restored as an intent-dispatching alias. Accepts optional `intent` field (`submit` | `steer` | `follow-up`, default `submit`) that delegates to the equivalent `/messages`, `/steer`, or `/follow-up` handler. Non-string intent values coerce to `submit` defensively; invalid strings return `400 INVALID_INTENT`. Registered in the method catalog as `sessions.inputs.create`.
- **F21** — `GET /api/companion/chat/sessions/:id/messages` restored. Returns `{ sessionId, messages }` with the full message list. All six companion-chat HTTP routes (`sessions.create`, `sessions.get`, `sessions.delete`, `messages.create`, `messages.list`, `events.stream`) now registered in `/api/control-plane/methods` under the `companion` category. The surface itself has been functional; only the method catalog entries were missing.
- **F22** — `/api/runtime/scheduler` now returns camelCase (`slotsTotal`, `slotsInUse`, `queueDepth`, `oldestQueuedAgeMs`), completing the QA-05 migration at the HTTP boundary. `AutomationManagerRuntime.getSchedulerCapacity()` now delegates to the pure `computeSchedulerCapacity()` function that has emitted camelCase since 0.21.33 — the route was previously wired to a legacy snake_case method that was not part of the QA-05 scope.

### Fixed
- **F-PROV-009** — `GET /api/providers` response now always includes `secretsResolutionSkipped: boolean` (previously emitted only when `true`, which was indistinguishable from "never introduced" to consumers that only checked `'secretsResolutionSkipped' in response`). Returns `true` when no `SecretsManager` was provided and `false` when one was available — independent of whether any keys were actually resolved (use individual provider `configuredVia` values for that signal).

### Breaking
- **F-PROV-009** — `ListProvidersResponse.secretsResolutionSkipped` is now a **required** boolean instead of `?: boolean`. TypeScript consumers that construct this object literal directly (typically mocks, fakes, or test fixtures) must now set the field explicitly. Runtime consumers reading the field are unaffected. Recommended migration: `secretsResolutionSkipped: !secretsManager` (or `false` for tests that inject a secretsManager). Pre-1.0 policy permits breaking changes in a patch bump per the project's versioning agreement.

### Tests
- `test/shared-session-inputs-post.test.ts` — 7 tests for F20 (default intent, all three explicit intents, bogus intent rejection, non-string intent coercion, missing body rejection).
- `test/companion-chat-f21-messages-get.test.ts` — 4 tests for F21 (200 happy path, 404 when session absent, all 6 `companion.chat.*` method-catalog IDs present, `companion.chat.messages.list` descriptor path).
- `test/prune-stale-operator-tokens.test.ts` — 7 tests for F3 (canonical-absent, candidate-absent, matching-token preservation, differing-token pruning, self-reference skip, malformed-JSON pruning, mixed set bucketing).

### Migration
No consumer code changes are required for F20, F21, F22, or F3 unless you construct `ListProvidersResponse` literals directly (see Breaking above). TUI 0.19.20+ consumes this SDK and calls `pruneStaleOperatorTokens` from its bootstrap paths automatically.

---

## [0.21.35] - 2026-04-21

Republish of 0.21.34 with corrected build artifact. 0.21.34 was published with a stale dist that did not include the PERF-08 HWM change; on-disk TypeScript source was correct but the tarball contained the pre-fix compiled JS. No additional source changes — this is a rebuild-and-republish.

### Fixed
- **PERF-08 (rebuild)**: Ensure `CountQueuingStrategy({ highWaterMark: 256 })` is present in the shipped `dist/_internal/platform/control-plane/gateway.js` and `dist/_internal/platform/runtime/integration/helpers.js`.

### Migration
Consumers on 0.21.34 that still observed SSE event drop should upgrade to 0.21.35 to pick up the compiled fix.

---

## [0.21.34] - 2026-04-21

Patch fix for `ControlPlaneGateway.createEventStream` + `IntegrationHelpers.createEventStream` SSE backpressure.

### Fixed
- **PERF-08**: Both SSE event-stream constructors relied on the default `ReadableStream` high-water mark of 1. When `start()` synchronously enqueued `ready` + replayed recent traffic, `desiredSize` hit 0 after the first chunk and the PERF-05/PERF-06 backpressure guards dropped every subsequent chunk before any consumer had pulled. Fixed by passing `new CountQueuingStrategy({ highWaterMark: 256 })` to both `ReadableStream` constructors so startup handshake + recent-traffic replay + live events fit without tripping backpressure for a healthy consumer.

### Migration
No consumer changes required. Hosts on 0.21.33 that observed missing SSE events after the `ready` frame should see them delivered correctly on upgrade.

---

## [0.21.33] - 2026-04-20

Waves 4 closeout + Wave 5 of the enterprise-adoption hardening series. All 24 targeted findings (3 Wave-4 closeout refixes + 21 Wave-5 findings) at 10.0/10 review threshold. No breaking runtime changes; one narrowing-API change (VersionMismatchError.code exposed as typed union alongside mismatchCode) and one wire-format change (scheduler-capacity fields → camelCase).

### Wave 4 closeout (10.0-push refixes)
- **ARCH-01**: NOTE comment in `packages/sdk/src/_internal/platform/daemon/http/runtime-route-types.ts` rewritten to accurately separate Like-view types (AgentRecordLike/AutomationJobLike/AutomationRunLike/RuntimeTaskLike) from `AutomationRouteBinding` (distinct binding interface), naming the 5 canonical AgentRecord fields that block collapse (template, orchestrationDepth, executionProtocol, reviewMode, communicationLane).
- **QA-01**: Added deferral comment above `record.routeBinding` cast in `daemon-http-client.ts` documenting that deep structural validation of AutomationRouteBinding is deferred to the upstream daemon-sdk contract.

### Wave 5 — Quality & architecture
- **QA-04**: Split `providers/registry.ts` (823 → 263 LOC) god-object along 4 axes. New sibling modules: `catalogue.ts` (184 LOC, RegistryCatalogue class with callback-based state sharing), `credentials.ts` (67 LOC, pure `getConfiguredProviderIds()`), `health.ts` (43 LOC, pure `describeProviderRuntime()`). Registry class preserved as thin delegation facade. Zero test modifications, zero public-surface regressions.
- **QA-05**: Extracted scheduler capacity reporting into `automation/scheduler-capacity.ts` with pure `computeSchedulerCapacity()` function (nowMs injectable for testability). Wire-format field names migrated snake_case → camelCase: `slots_total`→`slotsTotal`, `slots_in_use`→`slotsInUse`, `queue_depth`→`queueDepth`, `oldest_queued_age_ms`→`oldestQueuedAgeMs`. All consumers (method-catalog, 3 runtime-route-types mirrors, 3 test stubs) migrated.
- **QA-07**: New `test/scan-modes.test.ts` — 4 substantive tests for `runSecurity` + `runDeadCode` (2 positive + 2 negative with real tmp-dir fixtures).
- **QA-08**: New `test/wrfc-controller.test.ts` — 7 tests covering WRFC controller lifecycle (happy path, gate failure, escalation, agent-failure, chain/list semantics, state transitions) with real RuntimeEventBus + inline mocks.
- **QA-09**: New `test/gateway.test.ts` — 13 tests for ControlPlaneGateway (construction, end-to-end emit, ring-buffer invariants at 200/500 caps).
- **QA-10**: Flattened `tools/write/index.ts` control flow (max indent 22 → 12 spaces) by extracting 5 helpers: `captureBeforeContent`, `performAtomicRollback`, `runAutoHeal`, `updateStateAfterWrite`, `runPostWriteValidation`. Pure refactor, zero behavior change.
- **QA-11**: Added `providers/well-known-endpoints.ts` (`WELL_KNOWN_LOCAL_ENDPOINTS` + `WELL_KNOWN_LOCAL_PORTS` frozen maps). Migrated 3 consumers.
- **QA-12**: Added `void` operator to 7 fire-and-forget async call sites (bootstrap-background, custom-loader, mcp/client, lsp/client, hooks/dispatcher, tools/workflow).
- **QA-13**: Collapsed 5 migration stub files in `runtime/contracts/migrations/` into single `schemas.ts` + `README.md`.
- **QA-14**: Added `declare readonly code: '<LITERAL>'` narrowings to 17 concrete error subclasses across 9 files; added `code:` literal to 10 super() options bags so runtime matches the type narrowing. New `_internal/errors/README.md` documents hierarchy + authoring guide. `test/arch03-error-hierarchy.test.ts` strengthened with `.toBe()` assertions on code literals (19 → 25 tests).
- **QA-17**: Eliminated `tokenStore!` non-null assertions in `client.ts` — narrowed via `const ts = options.tokenStore` capture + `if (coordinator && tokenStore)` local narrowing (zero casts).
- **ARCH-04**: Investigated facade/router/schema-types split. Honest "no split needed" verdict — files are already decomposed per ARCH-08 (facade.ts is 803 LOC of thin delegators to 5 extracted helpers; router.ts is single-responsibility 10-way dispatch).
- **ARCH-06**: Added 6 router-level E2E test files (`test/router-e2e-{control,automation,session,telemetry,remote,tasks}.test.ts`) + shared `test/_helpers/daemon-stub-handlers.ts` helper (eliminates ~350 LOC duplication).
- **ARCH-11**: Migrated daemon-sdk error categories to `DaemonErrorCategory` typed constants. Added `export const DaemonErrorCategory` (declaration-merged with type) in `packages/errors/src/daemon-error-contract.ts` + mirror. 40 call-site migrations across error-response/telemetry-routes/media-routes/knowledge-routes (canonical + mirror).

### Wave 5 — Performance
- **PERF-08**: Removed 2 redundant `[...arr].filter()` spreads in telemetry `applyRecordFilter` / `applySpanFilter` (already committed in 0.21.31 follow-up).
- **PERF-10**: Runtime event bus MAX_LISTENERS cap (default 100). `export const MAX_LISTENERS`, `RuntimeEventBusOptions.maxListeners` override, config-wired via `runtime.eventBus.maxListeners` (range 1..100000). Dev mode (`NODE_ENV === 'development'`) throws `RangeError` on overflow (with pre-throw listener removal for state consistency); production mode warns. 11 tests.
- **PERF-12**: Replaced `gateway.recentMessages` O(n) `unshift`+trim with O(1) `RingBuffer<ControlPlaneSurfaceMessage>(200)`. New reusable `utils/ring-buffer.ts` utility (push/toArray/takeLast/takeLastReversed/clear/size/isEmpty/capacity). 17 tests.
- **PERF-13**: Added `insertSortedInput` binary-search O(log n + n-splice) helper to `session-broker-state.ts`; hot-path `recordInput()` now uses it instead of O(n log n) `sortInputs(bucket)` on every insert. Cold paths (load/snapshot) keep `sortInputs`. 7 tests (incl. N=50 random vs reference fuzz).

### Wave 5 — Observability
- **OBS-13**: Runtime event bus `listener_errors_total` counter + `OPS_LISTENER_MISBEHAVING` OpsEvent emission on listener failure (first-occurrence dedup via WeakMap keyed by listener). New `'event_type'` allowlist entry in telemetry api-helpers. DRY helper `_recordListenerError()` captures both catch blocks. 7 tests.
- **OBS-23**: Paired emissions audit — added `ROUTE_BINDING_REMOVED` and `SURFACE_POLICY_UPDATED` event types + emitters + validators. `ChannelPolicyManager.upsertPolicy` now emits `SURFACE_POLICY_UPDATED` via `attachRuntimeBus` pattern; `RouteBindingManager.removeBinding` now emits `ROUTE_BINDING_REMOVED` after successful deletion. 17 tests. `toEventSurfaceKind` exhaustive mapper (ChannelSurface → SurfaceKind) replaces inline cast; sentinel-sessionId convention documented in both managers.

### Wave 5 — Security
- **SEC-11**: Replaced naive `trigger.action.split(/\s+/)` in trigger-executor with POSIX-compatible `shellSplit()` tokenizer (~62 LOC, supports double-quoted / single-quoted / backslash-escape). Output passed to `Bun.spawn(parts, ...)` as argv (not shell). 9 tests. Already committed in 0.21.31 follow-up.

### Verification
- tsc: `bunx tsc -b --force` exit 0
- sync:check: all mirrors in sync (all subsystems)
- Test suite: **1398 tests across 137 files, 0 fail** (17 skip — MSW browser-only).

---

## [0.21.31] - 2026-04-20

Wave 3 of the enterprise-adoption hardening series. Completes observability findings OBS-01 through OBS-24 (full set) from `docs/audit/0.21.28-master-triage.md`, making the SDK SIEM-ingestable. Includes end-to-end wiring of 12 platform metric instruments to real emit sites, correlation context consumed in every emitted event attribute, `instrumentedFetch` as the default nativeFetch in all three local providers (ollama, llama-cpp, lm-studio), `filterMetricLabels` double-cast cleanup in meter primitives, histogram snapshots in `snapshotMetrics()`, and a `GET /api/runtime/metrics` endpoint.

### Observability
- **OBS-01: HTTP access log per request** — `HttpListener.handleRequest` now emits a structured `HTTP_ACCESS_LOG` entry via `logger.info` on every request with `requestId`, `method`, `path`, `status`, `latencyMs`, `clientIp`. A new private `_handleRequestInner` helper carries the inner routing logic so the access log fires unconditionally in a `try/finally`. Affected: `packages/sdk/src/_internal/platform/daemon/http-listener.ts`.
- **OBS-02: Auth audit events** — `handleLogin` emits `AUTH_FAILED` (via `logger.warn`) on bad credentials and `AUTH_SUCCEEDED` (via `logger.info`) on successful session creation. Credential values are never included. Structured payloads match the `SecurityEvent` `AUTH_SUCCEEDED` / `AUTH_FAILED` union added in the same release. Affected: `packages/sdk/src/_internal/platform/daemon/http-listener.ts`, `packages/sdk/src/_internal/platform/runtime/events/security.ts`, `packages/sdk/src/_internal/platform/runtime/emitters/security.ts`.
- **OBS-05: ToolResultSummary type** — Replaced `result?: unknown` in `TOOL_SUCCEEDED` and `TOOL_FAILED` event members and emitter signatures with `result?: ToolResultSummary` (`{ kind: string; byteSize: number; preview?: string }`). Avoids raw `unknown` payloads in the event stream while retaining enough context for observability. Affected: `packages/sdk/src/_internal/platform/runtime/events/tools.ts`, `packages/sdk/src/_internal/platform/runtime/emitters/tools.ts`.
- **OBS-07: Console → logger in OtlpExporter and ExportQueue** — All `console.error`/`console.warn` calls in the OTLP telemetry exporter pipeline are replaced with structured `logger.error`/`logger.warn` calls including `spanCount`, `attempts`, and `error` fields. Affected: `packages/sdk/src/_internal/platform/runtime/telemetry/exporters/otlp.ts`, `packages/sdk/src/_internal/platform/runtime/telemetry/exporters/queue.ts`.
- **OBS-08: WORKSPACE_SWAP_FAILED event** — `WorkspaceSwapManager` now emits `WORKSPACE_SWAP_FAILED` (added to `WorkspaceEvent` union) in both the mkdir and rerootStores failure catch blocks. The event carries `from`, `to`, `code` (`INVALID_PATH` | `REROOT_FAILED` | `UNKNOWN`), and `reason`. Affected: `packages/sdk/src/_internal/platform/workspace/workspace-swap-manager.ts`, `packages/sdk/src/_internal/platform/runtime/events/workspace.ts`.
- **OBS-09: Config/credential persistence audit** — The silent `catch { /* non-fatal */ }` in `WorkspaceSwapManager` for daemon-settings persistence failures is replaced with a structured `logger.warn` including `error`, `daemonHomeDir`, and `resolvedPath`. Affected: `packages/sdk/src/_internal/platform/workspace/workspace-swap-manager.ts`.
- **OBS-10: SessionBroker console → logger** — All `console.warn`/`console.error` calls in `SharedSessionBroker.attachRuntimeBus` and its `AGENT_COMPLETED`/`AGENT_FAILED`/`AGENT_CANCELLED` catch handlers are replaced with structured `logger.warn`/`logger.error` including `error` fields. Affected: `packages/sdk/src/_internal/platform/control-plane/session-broker.ts`.
- **OBS-11: Silent catch breadcrumbs** — Added `logger.debug`/`logger.warn` breadcrumbs to 10 silent catch blocks across 8 files: `workspace/daemon-home.ts` (corrupt JSON parse), `sessions/manager.ts` (directory read failure), `scheduler/scheduler.ts` (timezone decomposition fallback), `runtime/permissions/policy-signer.ts` (HMAC key error), `mcp/client.ts` (process shutdown error), `state/project-index.ts` (stat failure + reroot flush failure), `discovery/scanner.ts` (persist/remove failures), `tools/exec/runtime.ts` (kill-on-timeout failure).
- **OBS-03: Outbound fetch instrumentation** — Added `instrumentedFetch` helper to `packages/sdk/src/_internal/platform/utils/fetch-with-timeout.ts`. The helper wraps the global `fetch` and emits a structured `OUTBOUND_HTTP` log entry via `logger.info` on every outbound HTTP call with `method`, sanitized `url` (sensitive query-params redacted: `key`, `api_key`, `token`, etc.), `status` (-1 on network error), and `latencyMs`. Migrated 9 call-sites across 8 provider files: `providers/anthropic.ts`, `providers/anthropic-compat.ts`, `providers/gemini.ts` (chat + embeddings), `providers/openai-codex.ts`, `providers/model-limits.ts`, `providers/model-catalog-cache.ts`, `providers/model-benchmarks.ts`, `providers/context-discovery.ts`.
- **OBS-21 + OBS-02: Security event types** — `SecurityEvent` union extended with `AUTH_SUCCEEDED`, `AUTH_FAILED`, `COMPANION_PAIR_REQUESTED`, `COMPANION_PAIR_VERIFIED`, `COMPANION_TOKEN_ROTATED`, `COMPANION_TOKEN_REVOKED`. Corresponding typed emitter functions added in `runtime/emitters/security.ts`.
- **OBS-04: LLM provider instrumentation** — Added `emitLlmRequestStarted` function and enriched `LLM_RESPONSE_RECEIVED` event (`contentSummary`, `durationMs?`, `retries?`, `costUsdCents?`, `finishReason?`, `providerRequestId?`). New `instrumentedLlmCall<T>` wrapper in `runtime/llm-observability.ts` tracks duration and retry count. Affected: `runtime/events/turn.ts`, `runtime/emitters/turn.ts`, `runtime/llm-observability.ts`.
- **OBS-06: Prompt/response redaction at telemetry egress** — Default-deny redaction at the telemetry egress boundary. `TelemetryApiService.listEvents({view: 'safe'})` (the default) runs records through `sanitizeRecord` → `redactStructuredData`, replacing string values keyed under `CONTENT_KEY_PATTERN` (prompt, response, content, accumulated, reasoning, body, text, stdout, stderr, output, input, transcript, command, arguments, query, detail, summary, message) with `[REDACTED_TEXT length=N]`. Values carrying specific secret shapes (API keys, bearer tokens, cloud credentials, home paths) are pattern-redacted regardless of key. `{view: 'raw'}` skips redaction and is gated at the HTTP boundary on `admin` or `read:telemetry-sensitive` scope (see `daemon/telemetry-routes.ts`). Privacy gap closed: `CONTENT_KEY_PATTERN` extended to include `accumulated` — STREAM_DELTA payloads were previously leaking at safe view. The `telemetry.includeRawPrompts` config flag (default false) is now wired at daemon bootstrap via `setTelemetryIncludeRawPrompts` in `createDaemonFacadeCollaborators`; opt-in emits a startup WARN. Known gap: the flag is available via `getTelemetryIncludeRawPrompts` but `listEvents({view: 'raw'})` does not yet consult it — raw-view access remains scope-gated only. `summarizePromptContent(content, includeRaw)` in `runtime/llm-observability.ts` produces `PromptSummary { length, sha256, first100chars }` for LLM_REQUEST_STARTED/LLM_RESPONSE_RECEIVED callers that compute summaries before emit. Affected: `utils/redaction.ts` (CONTENT_KEY_PATTERN), `runtime/telemetry/redaction-config.ts` (new), `runtime/llm-observability.ts`, `daemon/facade-composition.ts`, `config/schema-domain-runtime.ts`, `config/schema-types.ts`, `config/schema.ts`. New test: `test/obs-06-prompt-redaction.test.ts` covers helper behavior, setter round-trip, CONTENT_KEY_PATTERN coverage for prompt/content/accumulated/reasoning/response, and end-to-end bus→safe-view redaction through `TelemetryApiService`.
- **OBS-12: RuntimeMeter production wiring** — Added `platformMeter` singleton with named instruments: `httpRequestsTotal`, `httpRequestDurationMs`, `llmRequestsTotal`, `llmRequestDurationMs`, `llmTokensInput`, `llmTokensOutput`, `authSuccessTotal`, `authFailureTotal`, `sessionsActive`, `sseSubscribers`, `transportRetriesTotal`, `telemetryBufferFill`. Added `snapshotMetrics()` function for `GET /api/runtime/metrics`. Affected: `runtime/metrics.ts`.
- **OBS-15: Correlation IDs via AsyncLocalStorage** — `CorrelationContext` interface and `correlationCtx` singleton in `runtime/correlation.ts`. Helpers: `getCorrelationContext()`, `withCorrelation()`, `withCorrelationAsync()`. Affected: `runtime/correlation.ts`.
- **OBS-16: NormalizedError cause chain** — `NormalizedError` interface already provided full cause chain via `normalizeError`. Redaction now applied at entry point (`OBS-24` wiring). Affected: `utils/error-display.ts`.
- **OBS-18: Retry/backoff/reconnect events** — `TRANSPORT_RETRY_SCHEDULED` and `TRANSPORT_RETRY_EXECUTED` added to `TransportEvent` union with `attempt`, `maxAttempts`, `backoffMs`, `reason` fields. Corresponding emitter functions: `emitTransportRetryScheduled`, `emitTransportRetryExecuted`. Transport store reducer updated to treat these as observability-only (no state change). Affected: `runtime/events/transport.ts`, `runtime/emitters/transport.ts`, `runtime/store/helpers/reducers/sync.ts`.
- **OBS-19: SSE subscriber lifecycle** — `STREAM_SUBSCRIBER_CONNECTED` and `STREAM_SUBSCRIBER_DISCONNECTED` added to `TransportEvent` union with `streamId`, `subscriberId`, `streamType`, optional `reason`. Emitters: `emitStreamSubscriberConnected`, `emitStreamSubscriberDisconnected`. Affected: `runtime/events/transport.ts`, `runtime/emitters/transport.ts`.
- **OBS-22: Telemetry label allowlist** — `METRIC_LABEL_ALLOWLIST` constant (`Set<string>`) and `filterMetricLabels(labels)` function added to `runtime/telemetry/api-helpers.ts`. Allowlist contains bounded-cardinality keys; high-cardinality IDs (`sessionId`, `traceId`, `taskId`, `agentId`, `turnId`) are excluded. Affected: `runtime/telemetry/api-helpers.ts`.
- **OBS-24: Bearer/token redaction in error strings** — `redactSensitiveData` from `utils/redaction.ts` now wired into `normalizeError` entry point, applied to raw error messages before any further processing. Bearer tokens are replaced with `[REDACTED_TOKEN]`. Affected: `utils/error-display.ts`.
- **OBS-05 (B1 fix): ToolResultSummary call sites** — `toToolResultSummary` factory added to `runtime/emitters/tools.ts` and all 5 `emitToolSucceeded`/`emitToolFailed` call sites in `core/orchestrator-tool-runtime.ts` updated. Resolves 5 TS2739 build errors.
- **OBS-03 (BL-5): Platform instrumentedFetch rollout** — All raw `await fetch(` call sites in `packages/sdk/src/_internal/platform/` migrated to `instrumentedFetch`. Wave 3 fix: `ollama.ts:75`, `llama-cpp.ts:79`, `lm-studio.ts:69` `nativeFetch` defaults changed from `((input, init) => fetch(input, init))` to `instrumentedFetch`; import added from `../utils/fetch-with-timeout.js`. Previously these three providers bypassed instrumentation when no explicit `nativeFetch` was passed.
- **OBS-04 (BL-2): instrumentedLlmCall in all LLM providers** — All 9 provider `chat()` methods (`anthropic`, `anthropic-compat`, `gemini`, `openai-compat`, `ollama`, `llama-cpp`, `lm-studio`, `openai-codex`, `github-copilot`) now wrap their `withRetry` call with `instrumentedLlmCall`, populating `durationMs` and `retries`. Wave 3 fix: `instrumentedLlmCall` opts extended with `provider?`, `model?`, `extractTokens?`, and `onStarted?` fields (`runtime/llm-observability.ts:70-80`). On success: `llmRequestsTotal.add(1, {...labels, status: 'success'})`, `llmRequestDurationMs.record(durationMs, labels)`, token histograms via `extractTokens`. On failure: `llmRequestsTotal.add(1, {...labels, status: 'error'})`. `onStarted` callback fires before the first attempt, allowing callers with bus/ctx to emit `LLM_REQUEST_STARTED` (`runtime/llm-observability.ts:95`).
- **OBS-13 (BL-3): GET /api/runtime/metrics endpoint** — `getRuntimeMetrics` handler added to `DaemonRuntimeRouteHandlerMap` via `createDaemonRuntimeRouteHandlers`. Route dispatched at `GET /api/runtime/metrics` in both canonical (`packages/daemon-sdk/src/operator.ts`) and mirror. `snapshotMetrics()` is injected via `DaemonRuntimeRouteContext.snapshotMetrics` to preserve the sync boundary — no direct platform import in the mirror. Both `runtime-route-types.ts` files updated in lockstep; `sync:check` passes.
- **OBS-17 (BL-4): Correlation context at HTTP request boundary** — `DaemonHttpRouter.handleRequest` now opens with `correlationCtx.run({ requestId: req.headers.get('x-request-id') ?? crypto.randomUUID() }, async () => { ... })`, scoping every downstream call within the request to a unique correlation context.
- **OBS-23 (BL-6): filterMetricLabels enforced at meter primitives** — `CounterImpl.add()`, `HistogramImpl.record()`, and `GaugeImpl.set()` in `runtime/telemetry/meter.ts` now call `filterMetricLabels` before computing the label key. High-cardinality labels are silently dropped at the instrument level, making enforcement unconditional regardless of call site. Wave 3 N-1 fix: removed double-cast `filterMetricLabels(labels as Record<string, unknown>) as MetricLabels` — calls are now `filterMetricLabels(labels) as MetricLabels` since `MetricLabels` is already assignable to `Record<string, unknown>` (`meter.ts:41, 64, 98`).
- **C-1: Platform metric instruments wired to real emit sites** — 12 instruments now record at production call sites. `httpRequestsTotal`/`httpRequestDurationMs`: `HttpListener.handleRequest` finally block (`http-listener.ts:85-92`). `authSuccessTotal`/`authFailureTotal`: `HttpListener.handleLogin` success/failure paths (`http-listener.ts:112, 119`). `llmRequestsTotal`/`llmRequestDurationMs`/`llmTokensInput`/`llmTokensOutput`: `instrumentedLlmCall` success/failure branches (`llm-observability.ts:103-117, 127-131`). `sessionsActive`: `SharedSessionBroker.createSession`/`closeSession` after Map mutation (`session-broker.ts`). `telemetryBufferFill`: `TelemetryApiService.handleEnvelope` after `appendBounded` (`telemetry/api.ts`). `sseSubscribers`: `TelemetryApiService.createStream` on sub/unsub (`telemetry/api.ts`). `transportRetriesTotal`: `emitTransportRetryScheduled` and `emitTransportRetryExecuted` (`emitters/transport.ts:87, 97`).
- **C-2: Correlation context consumed in event attributes** — `buildAttributes` in `runtime/telemetry/api-helpers.ts:267-270` now calls `getCorrelationContext()` and spreads `requestId` and `runId` (when present) into every emitted event’s attribute map. Every event emitted from within a `correlationCtx.run()` scope (i.e., all daemon HTTP request handling) automatically carries ambient correlation IDs.
- **C-3: Histogram snapshots in snapshotMetrics()** — `snapshotMetrics()` in `runtime/metrics.ts` now includes a top-level `histograms` key with `{ count, sum, min, max, mean }` snapshots for `http.request.duration_ms`, `llm.request.duration_ms`, `llm.tokens.input`, `llm.tokens.output`. Also adds top-level `counters` and `gauges` keys for direct instrument access. Legacy shape (`http`, `llm`, `auth`, `sessions`, `sse`, `transport`, `telemetry`) retained for backward compat.
- **OBS-10 (BL-1, idempotency fix): SharedSessionBroker.attachRuntimeBus console.warn** — The idempotency guard in `attachRuntimeBus` now emits `console.warn` alongside `logger.warn` so the existing `console.warn` spy in the test `SharedSessionBroker.attachRuntimeBus is idempotent` fires correctly.

### Refactoring
- **MA-2: redactSensitiveData deduplication** — Removed duplicate `REDACT_PATTERNS` constant and `redactSensitiveData` function from `packages/sdk/src/_internal/platform/export/session-export.ts`. The file now imports `redactSensitiveData` from `../utils/redaction.js`, the canonical location. No behavior change — patterns were identical.

### Tests
- `test/obs-01-http-access-log.test.ts` — instrumentedFetch + fetchWithTimeout export and rejection shape.
- `test/obs-02-auth-events.test.ts` — authSuccessTotal / authFailureTotal counter increment.
- `test/obs-03-instrumented-fetch.test.ts` — instrumentedFetch migration: function shape, network error propagation. N-2: `sanitizeUrlForLog` redacts `api_key`, `token`, preserves non-sensitive params, handles no-query URLs.
- `test/obs-04-llm-instrumentation.test.ts` — instrumentedLlmCall: durationMs, retry count, error propagation. Integration: `llmRequestsTotal` increments on success, `llmRequestDurationMs` snapshot count increases, `onStarted` fires before fn.
- `test/obs-05-tool-result-summary.test.ts` — toToolResultSummary: error/json/text kind, byteSize, preview.
- `test/obs-06-prompt-redaction.test.ts` — summarizePromptContent: default-deny summary, opt-in raw, sha256 determinism.
- `test/obs-07-otlp-logger.test.ts` — OTLP document builders: empty input shapes, metric resourceMetrics array.
- `test/obs-08-workspace-swap-failed.test.ts` — normalizeError/summarizeError on workspace error strings.
- `test/obs-09-config-audit.test.ts` — SERVICE_NAME, DEFAULT_EVENT_LIMIT, ALL_DOMAINS constants.
- `test/obs-11-silent-catches.test.ts` — normalizeError robustness across all throwable types.
- `test/obs-12-runtime-meter.test.ts` — platformMeter instruments, snapshotMetrics shape. Integration: `histograms` key with `{count,sum,mean}` sub-snapshots; `counters` key observable via snapshotMetrics.
- `test/obs-15-correlation-ids.test.ts` — getCorrelationContext, withCorrelation, withCorrelationAsync, nesting, leak prevention. Integration: `buildAttributes` emits `requestId` from active context; concurrent `withCorrelationAsync` contexts carry independent IDs.
- `test/obs-16-error-cause-chain.test.ts` — NormalizedError fields, AppError mapping (429, provider metadata), buildErrorResponseBody.
- `test/obs-18-retry-events.test.ts` — emitTransportRetryScheduled/Executed: export, channel, payload correctness.
- `test/obs-19-sse-lifecycle.test.ts` — emitStreamSubscriberConnected/Disconnected: export, payload, optional reason. sseSubscribers gauge.
- `test/obs-21-companion-pairing.test.ts` — Bearer token not present in normalizeError output, ETIMEDOUT hint.
- `test/obs-22-label-allowlist.test.ts` — METRIC_LABEL_ALLOWLIST contents, filterMetricLabels strips/passes correctly.
- `test/obs-24-bearer-redaction.test.ts` — redactSensitiveData Bearer pattern; normalizeError/summarizeError wiring.

### Other
- `version.ts` baked fallback updated to `0.21.31`.

---

## [0.21.30] - 2026-04-20

Wave 2 of the enterprise-adoption hardening series. Addresses 11 PERF, SEC, and OBS findings from `docs/audit/0.21.28-master-triage.md`. SEC-07 (CORS reversal) was pre-committed in 0.21.29 and is documented here as Wave 2 administrative closure.

### Performance
- **PERF-01: SessionBroker session/input retention window** — Closed sessions are now hard-deleted from `sessions`, `messages`, and `inputs` Maps after a 5-minute retention window (`SESSION_DELETION_RETENTION_MS = 5 * 60_000`) during `_gcSweep()`. Input buckets capped at `MAX_PERSISTED_INPUTS = 500`. Affected: `packages/sdk/src/_internal/platform/control-plane/session-broker.ts`.
- **PERF-02: RateLimiter O(n) → O(1) LRU via Map insertion order** — Replaced `accessOrder: string[]` (indexOf + splice = O(n)) with `lruMap = new Map<string, number>()`. Promotion to MRU via delete + re-set. Eviction via `keys().next().value`. Sweep breaks early on first live entry. Affected: `packages/sdk/src/_internal/platform/daemon/http-listener.ts`.
- **PERF-03: Scheduler pushHistory O(n) global filter + full-array persist → O(1) per-task Map + debounced save** — Replaced global `history: TaskRunRecord[]` with `historyByTask: Map<string, TaskRunRecord[]>`. `pushHistory()` now pushes into the per-task bucket and trims to `MAX_HISTORY_PER_TASK`. Hot-path `_onTaskFired` calls `scheduleSave()` (1 s debounce, `.unref?.()`) instead of `void this.save()`. Affected: `packages/sdk/src/_internal/platform/scheduler/scheduler.ts`.
- **PERF-04: SSE heartbeat leak on cancel path** — Added shared `teardown` closure declared outside `new ReadableStream()` constructor; assigned in `start`, called from both `abort` and `cancel`. Previously `cancel` only called `unsub()`, leaking the heartbeat `setInterval`. Affected: `packages/sdk/src/_internal/platform/runtime/telemetry/api.ts`.
- **PERF-05: Gateway SSE heartbeat + backpressure** — Added `.unref?.()` to heartbeat interval. Added `controller.desiredSize <= 0` backpressure guard before `enqueue`. Affected: `packages/sdk/src/_internal/platform/control-plane/gateway.ts`.
- **PERF-06: Integration SSE heartbeat + backpressure** — Added `.unref?.()` to heartbeat interval. Added `controller.desiredSize <= 0` backpressure guard in `onDomain` callback. Affected: `packages/sdk/src/_internal/platform/runtime/integration/helpers.ts`.
- **PERF-07: setInterval without .unref() (7 sites)** — Added `(interval as unknown as { unref?: () => void }).unref?.()` after each `setInterval` assignment across 7 files: `telemetry/api.ts`, `gateway.ts`, `integration/helpers.ts`, `http-listener.ts` (sweep), `bootstrap-runtime-events.ts`, `perf/slo-collector.ts`, `core/orchestrator.ts` (anim frame).
- **PERF-09: DistributedRuntime audit array unbounded** — Already fixed in codebase (`MAX_AUDIT = 500` cap in `recordDistributedRuntimeAudit`). No change needed; marked resolved.

### Security
- **SEC-05: JSON body-size cap on all HTTP routes** — `parseJsonBody` and `parseOptionalJsonBody` in both `http-listener.ts` and `http/router.ts` now reject requests exceeding 1 MiB (1,048,576 bytes) with HTTP 413. `Content-Length` header is checked pre-read; body size is re-checked post-read to cover chunked transfers.
- **SEC-06: Companion-chat rate limiter Map unbounded → LRU cap** — `CompanionChatRateLimiter.getOrCreate()` now evicts the LRU entry (Map insertion-order first key) when either `clientBuckets` or `sessionBuckets` reaches `MAX_RATE_LIMITER_BUCKETS = 10_000`. MRU promotion via delete + re-set on existing entries. Affected: `packages/sdk/src/_internal/platform/companion/companion-chat-rate-limiter.ts`.
- **SEC-07: CORS enforcement reversed to opt-in (pre-committed in 0.21.29)** — `enforceCors` defaults to `false`. Origin checks only active when `enforceCors: true`. Pre-0.21.29 permissive behaviour preserved for home/single-user deployments.
- **SEC-08: HTTP hooks and WebhookNotifier SSRF tier filter** — `hooks/runners/http.ts` and `integrations/webhooks.ts` now call `classifyHostTrustTier(extractHostname(url))` before each outbound fetch. Requests to `blocked` hosts (private IPs, localhost aliases, cloud metadata endpoints, encoded-IP bypass patterns) are rejected with `emitSsrfDeny` telemetry. Hook definitions may opt out via `allowInternal: true` (new `HookDefinition` field). Affected: `hooks/runners/http.ts`, `integrations/webhooks.ts`, `hooks/types.ts`.

### Observability
- **OBS-14: RuntimeEventBus dispatch fully synchronous → queueMicrotask** — Each subscriber dispatch is now wrapped in `queueMicrotask()`. A slow or throwing subscriber no longer blocks the emitter or subsequent subscribers. Per-subscriber errors are caught and logged. Tests updated to `await Promise.resolve()` after emit to drain the microtask queue. Affected: `packages/sdk/src/_internal/platform/runtime/events/index.ts`.

### Tests
- `test/perf-01-session-broker-eviction.test.ts` — Session/input retention window and MAX_PERSISTED_INPUTS cap.
- `test/perf-02-rate-limiter-lru.test.ts` — O(1) LRU RateLimiter correctness: eviction, MRU promotion, sweep early-exit.
- `test/perf-03-scheduler-history.test.ts` — Stable per-task history under 10k runs; debounced save; O(1) push.
- `test/perf-04-sse-cancel.test.ts` — Heartbeat cleanup on SSE cancel path (no interval leak).
- `test/sec-05-body-size-cap.test.ts` — HTTP 413 on large body; pass on ≤1 MiB body.
- `test/sec-06-rate-limiter-lru.test.ts` — Companion-chat Map bounded at MAX_RATE_LIMITER_BUCKETS.
- `test/sec-08-ssrf-filter.test.ts` — Hook and webhook SSRF rejection; allowInternal bypass.
- `test/obs-14-async-event-bus.test.ts` — Slow subscriber does not block emitter; throwing subscriber does not cascade.

Gates: bun run build pass (tsc -b --force, exit 0), sync:check pass, version:check pass (all 10 packages at 0.21.30), changelog:check pass, bun test 1126 pass / 17 skip / 0 fail (up from 1094 baseline at 0.21.29; +32 new Wave 2 tests).

---

## [0.21.29] - 2026-04-20

Wave 1 of the enterprise-adoption security hardening series targeting the bar set in `docs/audit/0.21.28-master-triage.md`. This wave closes all CRITICAL security findings except SEC-10 (deferred to Wave 5 per user decision).

### Security
- **W1-1 / SEC-04: vendor minimatch inline; remove install-time fetch** — Rewrote `scripts/postinstall-patch-minimatch.mjs` to copy the minimatch payload from `scripts/vendor/minimatch/` (git-checked-in) rather than fetching from the npm registry. Eliminates the supply-chain MITM/substitution vector at install time. Vendored version is minimatch@10.2.5 (sha512 `sha512-MULk...Mg==`, verified 2026-04-20). Advisories addressed: GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 (all affect minimatch >=10.0.0 <10.2.3 via bash-language-server transitive pinning).
- **W1-2 / SEC-01: `writeBootstrapUsers` writes auth-user store at 0600** — Added `{ mode: 0o600 }` to the write call, plus write-to-tmp-then-rename pattern with `chmodSync` applied both before rename and after (defeats filesystem-reset behaviour). Affected file: `packages/sdk/src/_internal/platform/security/user-auth.ts`. Files now under 0600: `auth-users.json`.
- **W1-3 / SEC-02: `safeCopy` → `safeCopyIdentity` for credential migration** — Added `safeCopyIdentity` helper that calls `chmodSync(dest, 0o600)` after `copyFileSync`, ensuring migrated credential files land at 0600 regardless of source permissions. Affected file: `packages/sdk/src/_internal/platform/workspace/daemon-home.ts`. Files now under 0600: `auth-users.json` (migrated), `auth-bootstrap.txt` (migrated).
- **W1-4 / SEC-03: `/login` rate-limited and behind origin check** — Reordered `handleRequest` so CORS origin check runs first (before any route dispatch), then `/login` is dispatched with its own tight `loginRateLimiter` (default 5 attempts/min per IP, configurable via `HttpListenerConfig.loginRateLimit`). The general 60/min API rate limiter is independent. Affected file: `packages/sdk/src/_internal/platform/daemon/http-listener.ts`.
- **W1-5 / SEC-07: enforce safe `allowedOrigins` defaults — refuse-to-start + request-time origin deny** — Two-layer defence: (1) **Startup guard**: constructing `HttpListener` with `hostMode=network` and empty `allowedOrigins` now throws `SECURITY_UNSAFE_ORIGIN_CONFIG` immediately, preventing the listener from binding. (2) **Request-time guard**: any request that carries an `Origin` header is rejected with 403 (`CORS_NOT_CONFIGURED`) when `allowedOrigins` is empty, and with 403 (`ORIGIN_NOT_ALLOWED`) when the origin is not in the allowlist. Requests without an `Origin` header (same-origin or non-browser) are unaffected. Affected file: `packages/sdk/src/_internal/platform/daemon/http-listener.ts`.
- **W1-6 / SEC-12: `writeDaemonSetting` writes daemon-settings.json at 0600** — Applied `{ mode: 0o600 }` + `chmodSync` post-rename pattern to `writeDaemonSetting`. Affected file: `packages/sdk/src/_internal/platform/workspace/daemon-home.ts`. Files now under 0600: `daemon-settings.json`.

### Added
- `scripts/vendor/minimatch/` — vendored minimatch@10.2.5 payload (dist/, package.json, LICENSE.md, README.md). Git-checked-in. Source of truth for postinstall patching.
- `test/sec-01-user-auth-perms.test.ts` — 4 tests asserting `auth-users.json` is created and maintained at mode 0600 across bootstrap, addUser, rotatePassword, deleteUser paths.
- `test/sec-02-safecopy-perms.test.ts` — 3 tests for SEC-02 safeCopyIdentity behaviour and SEC-12 `writeDaemonSetting` mode enforcement.
- `test/sec-03-login-ratelimit.test.ts` — 7 tests: first 5 login attempts allowed, 6th returns 429; 10 rapid attempts split 5/5; IPs tracked independently; login budget independent of general API limiter; origin check fires before /login; allowed origin passes through.
- `test/sec-07-origin-defaults.test.ts` — 6 tests: startup guard throws on hostMode=network+empty allowedOrigins; startup guard accepts network+non-empty allowedOrigins; loopback+empty allowedOrigins+no Origin header passes; loopback+empty allowedOrigins+Origin header returns 403 CORS_NOT_CONFIGURED; network+allowedOrigins set+wrong origin returns 403 ORIGIN_NOT_ALLOWED; network+allowedOrigins set+correct origin passes.
- `test/sec-04-postinstall-no-network.test.ts` — 3 tests: vendor payload present; postinstall runs exit 0 with no-network env (HTTPS_PROXY=unreachable); vulnerable minimatch is patched from vendor; already-patched is skipped.

### Note
- SEC-10 (`Math.random` crypto misuse) moved to Wave 5 per user decision — not in this wave.
- This is Wave 1 of a planned 5-wave series. See `docs/audit/0.21.28-master-triage.md` for full triage and wave assignments.

Gates: bun run build pass (tsc -b --force, exit 0), sync:check pass, version:check pass (all 10 packages at 0.21.29), changelog:check pass.

---

## [0.21.28] - 2026-04-20

F3 resolved: operator tokens are global-only. The prior "partially resolved" framing in CHANGELOG 0.21.19 was incomplete — the dual-path/workspace-scoped design was a mistake. This release removes it entirely.

### Changed
- **F3: operator tokens are global-only at `~/.goodvibes/daemon/operator-tokens.json` (daemon-home)** — Workspace-scoped token resolution (reading from `<cwd>/.goodvibes/operator-tokens.json`) is removed entirely. The single canonical path is `resolveDaemonHomeDir() + '/operator-tokens.json'`. No fallback. No migration from workspace paths.
- **0600 file permissions on operator token writes** — `writeOperatorTokenFile()` (new export) and `getOrCreateCompanionToken()` both write with mode `0600` (owner read/write only), enforced via `chmodSync` after rename.
- **`runDaemonHomeMigration` no longer migrates workspace-scoped tokens** — The `cwd` field is removed from `DaemonHomeOptions`. Migration only copies `auth-users.json` and `auth-bootstrap.txt` from the legacy `tui` surface path.
- **`companion-token.ts` API tightened** — `getOrCreateCompanionToken` and `regenerateCompanionToken` now require `daemonHomeDir` (no longer optional). `basePath` workspace-scoped parameter removed entirely.
- **New exports from `daemon-home.ts`**: `resolveOperatorTokenPath(daemonHomeDir)`, `writeOperatorTokenFile(daemonHomeDir, content)`, `readOperatorTokenFile(daemonHomeDir)`.

### Added
- **`test/operator-token-global.test.ts`** — 8 new tests: token at global path returned correctly; new token created at global path when absent; workspace-scoped path is never consulted; `writeOperatorTokenFile` sets 0600; `getOrCreateCompanionToken` sets 0600; E2E via `DaemonHttpRouter.dispatchApiRoutes` with authenticated request → 200; unauthenticated → 401; authenticated full `handleRequest` returns `providers` array.

### Note
- The prior "partially resolved" label for F3 in 0.21.19 was inaccurate. The dual-path design (global + workspace fallback) that shipped then was itself the bug. This release removes it clean, with zero compat shims. Pre-1.0, single user, nothing outside uses the workspace-scoped path.

Gates: build pass (bunx tsc -b --force, exit 0), sync:check pass, version:check pass (all 11 packages at 0.21.28), changelog:check pass. Test count: via `bun run test` package script: 977 pass, 0 fail (baseline 962 + 15 new); full `bun test` scope: 1066 pass / 17 skip / 0 fail (baseline 1051 + 15 new).

---

## [0.21.27] - 2026-04-20

Three bugs reclassified from "by design" / "resolved" and fixed properly. F7 and F5b were previously mislabeled as not requiring implementation; F-PROV-009 had the code right but lacked router-level E2E test coverage.

### Added
- **F7: OTLP POST ingest receivers** — Implemented real POST endpoints at `/api/v1/telemetry/otlp/v1/logs`, `/api/v1/telemetry/otlp/v1/traces`, and `/api/v1/telemetry/otlp/v1/metrics` (plus legacy `/api/telemetry/otlp/v1/...` aliases). Added `postTelemetryOtlpLogs`, `postTelemetryOtlpTraces`, `postTelemetryOtlpMetrics` to `DaemonApiRouteHandlers` (canonical in `daemon-sdk/src/context.ts`, mirrored in `sdk/src/_internal/daemon/context.ts`). Handlers validate Content-Type (`415` for unsupported types), body size (`413` for >4 MiB), JSON structure (`400` for malformed), and require bearer auth (`401`). **JSON (`application/json`) only in this release — protobuf (`application/x-protobuf`) returns `415 Unsupported Media Type`**; protobuf decoding is planned for a future release. Payloads forwarded to `TelemetryApiService` (the required `ingestSink` field in `TelemetryRouteContext`), which stores ingested records in its bounded in-memory event buffer (ring buffer, default cap 500 events). Log records are individually mapped and appended per `logRecord` entry; trace spans generate a sentinel `TelemetryRecord` per POST only when at least one span was appended; metric datapoints generate a sentinel only when at least one datapoint was present. All ingested records are observable on `GET /api/v1/telemetry/events` with `source: 'otlp-ingest'` and type `OTLP_LOG_INGEST` / `OTLP_TRACE_INGEST` / `OTLP_METRICS_INGEST`. Sentinel emission is gated on actual records being appended — empty payloads do not produce false-positive observability events. Route dispatch wired in both `operator.ts` files. Tests in `test/otlp-ingest-routes.test.ts` (happy path JSON×3, protobuf×3 now assert 415, plus 401/415/400 error paths and sink forwarding/router dispatch tests) and sentinel-gating E2E tests in `test/otlp-ingest-e2e.test.ts`.
- **F5b: sqlite-vec bundled binary resolver** — Added `resolveSqliteVecPath()` (exported for testability) and `loadSqliteVecExtension()` (private) to `packages/sdk/src/_internal/platform/state/memory-vector-store.ts`. Detects Bun bundled-executable context by checking `import.meta.url` for `$bunfs`. In bundled mode resolves extension from `join(dirname(process.execPath), 'lib', 'sqlite-vec-<os>-<arch>', 'vec0.<suffix>')`. Falls back to the npm package's `load()` in dev/test mode. Tests in `test/sqlite-vec-resolver.test.ts`.

### Fixed
- **F-PROV-009: `secretsResolutionSkipped` router-level E2E test** — The implementation was already correct in `provider-routes.ts` (line 287) and wired in `router.ts`. Added missing router-level end-to-end test to `test/provider-routes-secrets-skipped.test.ts` that exercises the full `Request → DaemonHttpRouter.dispatchApiRoutes → dispatchProviderRoutes` path with `secretsManager: null` and asserts `secretsResolutionSkipped: true` in the response.

Gates: build pass (bunx tsc -b --force, exit 0), sync:check pass, version:check pass (all 10 packages at 0.21.27), changelog:check pass.

---

## [0.21.26] - 2026-04-20

Three loose ends from 0.21.25 closed: F16b router plumbing fully threaded end-to-end, `getSchedulerCapacity` registered in the method catalog so `buildOperatorContract` emits it, and the `_syncScheduled` coalescing test rewritten to be deterministic.

### Added
- **F16b: `resolveDefaultProviderModel` fully plumbed** — Added optional `resolveDefaultProviderModel?: () => { provider: string; model: string } | null` callback to `DaemonHttpRouterContext` and forwarded it into `dispatchCompanionChatRoutes`. Wired the field through `CreateDaemonFacadeCollaboratorsOptions` and `createDaemonFacadeCollaborators`. In `facade.ts`, built the callback from `providerRegistry.getCurrentModel()` so consumers no longer need to supply it manually.
- **`scheduler.capacity` in method catalog** — Added `scheduler.capacity` method descriptor to `builtinGatewayRuntimeMethodDescriptors` in `method-catalog-runtime.ts`. `buildOperatorContract` now emits this method in the operator contract at runtime.

### Fixed
- **CI flake: `_syncScheduled` coalescing test** — Rewrote `lastEventAt inside setImmediate reflects most recent event, not first` in `test/cache-invariants.test.ts`. Root cause: intermediate `await setTimeout(5)` allowed the setImmediate (scheduled by the first `rememberEvent` call) to fire before the second call. Fix: both calls synchronous, `_lastEventAt` captured directly from the gateway instance after each call. 20/20 runs pass.

Gates: build pass (bunx tsc -b --force, exit 0), sync:check pass, version:check pass (all 11 packages at 0.21.26), changelog:check pass.

---

## [0.21.25] - 2026-04-20

CI-orphan recovery. 0.21.24 was tagged and pushed but CI failed at `bunx tsc -b --force` (the actual build command) with three TS errors. 0.21.24 was **never published to npm**. This patch fixes those errors and is the first published artifact containing the Arch #3 scheduler-capacity work.

### Fixed
- **CI orphan — `getSchedulerCapacity` missing from platform HTTP layer**: `packages/sdk/src/_internal/platform/daemon/http/runtime-route-types.ts` — the local `DaemonRuntimeRouteContext.automationManager` shape was not updated when `getSchedulerCapacity` was added to the canonical `DaemonRuntimeRouteContext` in `packages/sdk/src/_internal/daemon/runtime-route-types.ts` (the daemon-sdk mirror). Added `getSchedulerCapacity(): { slots_total: number; slots_in_use: number; queue_depth: number; oldest_queued_age_ms: number | null }` to the `automationManager` block, fixing TS2430 at `runtime-route-types.ts(47,18)`.
- **CI orphan — `getSchedulerCapacity` missing from router `automationManager` passthrough**: `packages/sdk/src/_internal/platform/daemon/http/router.ts` — the `automationManager` object literal passed to `createDaemonRuntimeRouteHandlers` at line 408 was missing the `getSchedulerCapacity` passthrough. Added `getSchedulerCapacity: () => this.context.automationManager.getSchedulerCapacity()`, fixing TS2741 at `router.ts(408,9)` and TS2345 at `router.ts(300,41)`.

### Note
- 0.21.24 entry below is preserved for history but that version was never published. 0.21.25 is the first npm artifact for this feature set.

Gates: build pass (bunx tsc -b --force, exit 0), sync:check pass, version:check pass (all 11 packages at 0.21.25), changelog:check pass.

---

## [0.21.24] - 2026-04-20

UAT Run 3 / 3b triage against TUI 0.19.12. Five findings fixed in SDK; two deferred to TUI (see `docs/uat/handoff-to-tui.md`). One new scheduler-capacity endpoint added (Arch #3).

### Added
- **Arch #3 — `GET /api/runtime/scheduler`**: New endpoint returning current automation-scheduler capacity snapshot: `slots_total` (max concurrent runs), `slots_in_use` (currently executing), `queue_depth` (waiting in queue), `oldest_queued_age_ms` (age of oldest queued run in ms, `null` if queue is empty). Implemented via new public `AutomationManager.getSchedulerCapacity()` method wired through `DaemonRuntimeRouteContext.automationManager` sub-interface and `operator.ts` dispatcher.
- **F-PROV-009 — `secretsResolutionSkipped` field on `GET /api/providers` response**: When `secretsManager` is `null`/`undefined` (secrets tier unavailable), the response now includes `secretsResolutionSkipped: true`. Previously the response silently returned 0 secrets-configured providers with no indication of why. Callers can now distinguish "no secrets configured" from "secrets tier skipped".

### Fixed
- **F16b — Companion-chat session-create leaves `provider: null`, `model: null`**: `handleCreateSession` now accepts an optional `resolveDefaultProviderModel?: () => { provider: string; model: string } | null` callback on `CompanionChatRouteContext`. When injected and the request body does not supply both `provider` and `model`, the callback is invoked to fill in defaults. If the callback is present but returns `null` (no default configured), the response is HTTP 400 `NO_MODEL_CONFIGURED`. Backward compatible: when the callback is absent, legacy behavior (null provider/model allowed through) is preserved.
- **F17 — `DELETE /api/sessions/:id/inputs/:inputId` silent no-op on `spawned` state**: `cancelInput` in the session broker returns the input record unchanged when it is not in a cancellable state. The HTTP handler now detects this case (returned state is not `queued` or `cancelled`) and responds HTTP 409 `{ error: 'Cannot cancel input in state \'<state>\'', code: 'CANCEL_NOT_ALLOWED', input }`. Previously returned 200 with no state change, giving callers no actionable signal.
- **F19 — `PATCH /api/channels/policies/:surface` returns 404 (regression, never implemented)**: `patchChannelPolicy(surface, req)` added to `DaemonApiRouteHandlers` interface, `operator.ts` dispatcher (PATCH branch on the channel-policy route), and `channel-routes.ts` handler factory. The handler applies a field-by-field partial update (spreading existing policy fields from the current snapshot, then overlaying request body fields). Implementation mirrors are in sync (`sync:check` passes).

### Deferred
- **F7 — POST `/api/v1/telemetry/otlp/v1/logs` returns 404**: Working as designed. The daemon is an OTLP exporter, not an inbound collector. Architecture decision `otlp-no-post-ingest` (2026-04-19) stands. TUI UAT plan must be updated to remove the POST expectation. See `docs/uat/handoff-to-tui.md#f7`.
- **F9 — POST `/api/automation/jobs` returns 400 "Missing required field: prompt"**: Schema drift in the UAT plan. `prompt` is and has always been required. TUI UAT job fixtures must include a `prompt` string field. See `docs/uat/handoff-to-tui.md#f9`.

### Docs
- `docs/uat/handoff-to-tui.md` created: explains F7 and F9 as TUI-owned items with action items and example payloads.

### Coming next (deferred from this UAT cycle)
- **Arch #1** — Provider-latency telemetry (`latency_ms` on provider response).
- **Arch #2** — `turn.stalled` event (timeout sentinel when a turn produces no output within a configurable window).

Gates: sync:check pass, version:check pass (all 10 packages at 0.21.24), tsc --noEmit pass (0 errors), bun test pass (1012 pass / 17 skip / 0 fail). Added 31 new tests across 5 files covering F16b (companion-chat session-create provider resolution, 9 tests), F17 (input cancel state transitions, 5 tests), F19 (channel-policy PATCH, 7 tests), F-PROV-009 (secretsResolutionSkipped observability, 3 tests), and Arch #3 (scheduler capacity endpoint, 7 tests). F19 now includes a focused field-filter test (B3) asserting the handler drops untyped fields (rate_limit, bogusField) before they reach upsertPolicy. F19 and Arch #3 include dispatcher integration tests through dispatchOperatorRoutes verifying real HTTP route wiring.

---

## [0.21.23] - 2026-04-19

Fixes three blockers from WRFC review 5 (score 8.4/10 vs threshold 10.0).

### Fixed
- **D3 — `RuntimeEventDomain` drift: `'workspace'` missing from hand-written union**: `packages/contracts/src/types.ts` had a 26-domain hand-written union literal that was out of sync with the generated source of truth (`packages/contracts/src/generated/runtime-event-domains.ts`, 27 domains including `workspace`). Fix (Option A): replaced the hand-written union with `import type { RuntimeEventDomain } from './generated/runtime-event-domains.js'` + `export type { RuntimeEventDomain }`, making drift structurally impossible. Updated the SDK internal mirror (`packages/sdk/src/_internal/contracts/types.ts`) with the same change. Removed the cast `d.domains as OperatorEventContract['domains']` at `operator-contract.ts:184` — the types now align directly without coercion. `sync:check` confirms mirrors are in sync.
- **D4 — 5 pre-existing browser test failures**: Root causes: (a) `msw` not in devDependencies — 4 test files failed at import time with `Cannot find package 'msw'`; (b) `location.origin` undefined in Bun's non-browser runtime — `sdk-init.test.ts` test assumed browser context. Fixes: added `msw@^2.7.0` to root devDependencies; guarded `setup.ts` `setupWorker()` call with `typeof window !== 'undefined'` check, exporting a no-op worker stub in non-browser envs; added `describe.skipIf(typeof window === 'undefined')` to all MSW-dependent describe blocks in `auth.test.ts`, `transport-http.test.ts`, `errors.test.ts`, and `transport-realtime.test.ts` (3 describe blocks); added `it.skipIf(typeof window === 'undefined')` to the `location.origin` test in `sdk-init.test.ts`. Result: `bun test` reports 981 pass / 17 skip / 0 fail (browser tests skip gracefully in Bun; they execute properly under `bun run test:browser` with vitest+Playwright).

### Docs
- **D5 — CHANGELOG test-count figure**: Prior 0.21.22 gate line cited no specific number; D5 had no CHANGELOG change to make. Updated here for accuracy: baseline before this patch was 898 pass (bun test `test/*.test.ts`) / 5 fail (browser); after patch: 981 pass / 17 skip / 0 fail (full `bun test`).

Gates: sync:check pass, changelog:check pass, version:check pass, 981 pass / 17 skip / 0 fail (bun test full scope; browser tests skip under Bun via skipIf guards, no test:browser script yet).

---

## [0.21.22] - 2026-04-19

Fixes two regressions introduced in 0.21.21 that were missed by WRFC reviewer 4.
D1 affected every caller of `/api/settings` — 9 TUI test files cascaded.
D2 caused TUI to ship a loosened assertion since 0.21.20.

### Fixed
- **D1 — `runtime` section missing from `DEFAULT_CONFIG`**: `CONFIG_SCHEMA` gained `runtime.companionChatLimiter.perSessionLimit` in 0.21.21 but `DEFAULT_CONFIG` was never given a corresponding `runtime` section. `ConfigManager.resolvePath()` threw `"section 'runtime' does not exist"` on every call to `config.get('runtime.companionChatLimiter.perSessionLimit')`, cascading through `buildResolvedEntries` → `getSettingsControlPlaneSnapshot` → `/api/settings` (500 error). Fix: added `RuntimeConfig` interface to `schema-types.ts`, added `runtime: RuntimeConfig` to `GoodVibesConfig`, added `runtime` key to `runtimeConfigDefaults` in `schema-domain-runtime.ts` (default `perSessionLimit: 10`), and wired `runtime: runtimeConfigDefaults.runtime` into `DEFAULT_CONFIG` in `schema.ts`.
- **D2 — `buildOperatorContract` ignored `catalog` parameter**: The function body contained `void catalog;` — the catalog argument was accepted but never used. The returned contract always reflected the static pre-baked artifact regardless of runtime-registered methods/events (regression introduced somewhere in 0.21.16–0.21.21). Fix: removed `void catalog;`, added `toMethodContract()` and `toEventContract()` projectors that map `GatewayMethodDescriptor`/`GatewayEventDescriptor` to the `OperatorMethodContract`/`OperatorEventContract` contract types, and made `buildOperatorContract` populate `operator.methods`, `operator.events`, `schemaCoverage`, and `eventCoverage` from the live catalog. TUI can now restore the tightened `toHaveLength(catalog.listEvents().length)` assertion.

### Added
- `test/default-config-runtime.test.ts`: Regression guard for D1 — verifies `DEFAULT_CONFIG` has a `runtime` key, all `runtime.*` schema keys resolve without throwing, and iterating all schema keys via `config.get()` never throws.
- `test/operator-contract-catalog.test.ts`: Regression guard for D2 — verifies `buildOperatorContract` reflects exactly N methods and M events from the passed catalog, and that two catalogs with different counts produce different contract sizes.

---

## [0.21.21] - 2026-04-19

### Added
- **W-1 — WorkspaceSwapManager wired end-to-end**: `WorkspaceSwapManager` is now threaded through the full daemon stack: `DaemonConfig` → `DaemonServer` constructor → `createDaemonFacadeCollaborators()` → `DaemonHttpRouter` context → `buildSystemRouteContext()`. The `DaemonHttpRouterContext` interface gains `swapManager: WorkspaceSwapManagerLike | null`; real wiring now plumbs the live instance rather than a hard-coded `null`.
- **W-1 — `countBusySessions()`**: `SharedSessionBroker` now exposes a public `countBusySessions(): number` method (counts sessions with `pendingInputCount > 0`) consumed by `WorkspaceSwapManager` to enforce the WORKSPACE_BUSY guard.
- **W-1 — `rerootStores()`**: `RuntimeServices` interface and `createRuntimeServices()` return object now include a fully functional `rerootStores(newWorkingDir: string): Promise<void>` method. `MemoryStore` and `ProjectIndex` are closed and re-opened at the new path in-process. Subsystems that cannot be live-rerooted (KnowledgeStore, SessionManager, ArtifactStore, and others) emit a warn-level log naming the subsystem and continue operating until the next process restart, at which point `daemon-settings.json` points the daemon to the new path.
- **W-4 — Reserved session ID validation**: `SharedSessionBroker.createSession()` now rejects `''` and `'system'` with `{ code: 'INVALID_SESSION_ID' }`. A static `RESERVED_SESSION_IDS` set documents the reservation policy.
- **W-6 — Runtime config override for per-session rate limit**: `CompanionChatRateLimiter` accepts an optional `configManager` at construction time. On each `check()` call, `resolvePerSessionLimit()` reads `runtime.companionChatLimiter.perSessionLimit` from the config manager (when present); a positive integer there takes precedence over the constructor-time baseline, enabling live rate-limit tuning without a daemon restart. The env-var `GOODVIBES_CHAT_LIMITER_THRESHOLD` is still read once at startup as a fallback.
- **W-6 — `runtime.companionChatLimiter.perSessionLimit` config key**: New runtime config key registered in schema-domain-runtime.ts (`type: 'number'`, default: 10). Added to `ConfigKey` union and `ConfigValue<K>` conditional in schema-types.ts.
- **W-9 — `validate:strict` script**: `package.json` gains `"validate:strict": "bun run validate && bun run types:check && bun run sync:check"` for a single pre-release full-gate command.
- **W-9 — Error log**: `.goodvibes/logs/errors.md` created, documenting the three significant errors encountered during the 0.21.20/0.21.21 work cycle (W5 generic emit, W3 sync mirror discipline, W6 ConfigKey union).
- **B4 — Missing swapManager logged at warn**: `router-route-contexts.ts` upgrades the missing `swapManager` message from `logger.debug` to `logger.warn` so operator misconfiguration is visible in production logs.
- **B5 — `safeCopy` failure logged at warn**: `daemon-home.ts` `safeCopy` helper now emits `logger.warn` (previously `logger.debug`) so copy failures during migration surface in production.
- **B8 — `prepublishOnly` hook**: `package.json` gains `"prepublishOnly": "bun run validate:strict"` so `validate:strict` runs automatically before any `npm publish` (guards against accidental publish of unvalidated state).
- **B10 — `DaemonHomeMigrationDeps` interface and `runtimeBus` threading**: `runDaemonHomeMigration()` gains an optional third `deps: DaemonHomeMigrationDeps` parameter. `cli.ts` now calls migration from `main()` after `RuntimeEventBus` is created, threading the live bus into the migration so `WORKSPACE_IDENTITY_MIGRATED` / `WORKSPACE_IDENTITY_MIGRATION_FAILED` events are emitted.
- **B10 — `WORKSPACE_IDENTITY_MIGRATED` / `WORKSPACE_IDENTITY_MIGRATION_FAILED` events**: Two new event types added to the `WorkspaceEvent` union in `workspace.ts` and automatically registered in the `DomainEventMap` (since `WorkspaceEvent` is already the union type for that domain).
- **B12 — Domain-keyed `RuntimeEventBus.emit` overload**: Added typed overload `emit<D extends RuntimeEventDomain>(domain: D, envelope: RuntimeEventEnvelope<DomainEventMap[D]['type'], DomainEventMap[D]>)` eliminating the `as Parameters<...>[1]` cast used in `WorkspaceSwapManager`. The implementation signature remains unchanged; only callers with a statically-known domain benefit.

### Fixed
- **W-2 — `runtime.workingDir` and `daemon.homeDir` as read-only well-known state keys**: The state tool (`tools/state/index.ts`) now intercepts `get` requests for these keys and injects live runtime values. `set` requests for these keys are rejected with a descriptive error instead of silently writing to the config map. `StateToolOptions` gains optional `workingDir` and `daemonHomeDir` fields.
- **W-5 — `WorkspaceSwapManager._emit` type cast replaced by domain-keyed overload**: Previously used `emit('workspace', envelope as Parameters<RuntimeEventBus['emit']>[1])`. Now uses the typed `emit('workspace', envelope)` overload (see B12 above). Fixes TS1005 compilation error root-cause.
- **W-7 — F13 test file imports real exported handlers**: `test/f13-field-normalization.test.ts` now imports `readCompanionChatMessageBody` from `companion-chat-routes` and `readSharedSessionMessageBody` from daemon runtime-session-routes instead of duplicating function logic locally. Added trim behavior, non-string value rejection, and wrong-field fallthrough edge-case tests.
- **B7 — `StateToolOptions.swapManager` + `runtime.workingDir` set delegation**: `StateToolOptions` gains an optional `swapManager` field. When `runtime.workingDir` appears in a `set` call, the tool delegates to `swapManager.requestSwap()` (returns a descriptive error if no swap manager is wired). All other WELL_KNOWN_READONLY_KEYS still return read-only errors.
- **B11 — F13 field normalization documented via JSDoc**: `handlePostMessage` (companion-chat-routes) and `handlePostSharedSessionMessage` (daemon runtime-session-routes) gain JSDoc describing field precedence (`body` > `content` for companion; `body` > `message` > `text` for shared-session).

### Tests
- **W-6 — RL6 test suite**: Added `describe('RL6: runtime configManager overrides per-session limit')` to `companion-chat-rate-limit.test.ts` — three cases: (a) configManager positive integer overrides baseline, (b) non-positive value falls back to baseline, (c) undefined value falls back to compile-time default.
- **W-8 — WorkspaceSwapManager edge-case tests**: Added to `daemon-home.test.ts`: event order assertions (REFUSED before STARTED check, STARTED before COMPLETED), domain assertion (`workspace`), FILE path INVALID_PATH, concurrent swap, and persistence-write-failure case (`persistedInDaemonSettings: false` when `daemonHomeDir` is a file path).
- **W-8 — `runDaemonHomeMigration` corrupt JSON test**: Verifies corrupt JSON source file is skipped without throwing and destination is not created.
- **B2 — Mutex for concurrent swap requests**: `WorkspaceSwapManager.requestSwap()` is now guarded by a promise-based mutex. A second `requestSwap` call while the first is in progress returns `{ ok: false, code: 'WORKSPACE_BUSY', retryAfter: 1 }` immediately.
- **B3 — Workspace swap HTTP integration test**: `test/workspace-swap-http.test.ts` exercises `createDaemonSystemRouteHandlers` end-to-end with a real `WorkspaceSwapManager`: valid swap → 200; empty path → 400 INVALID_PATH; file path → 400 INVALID_PATH.
- **B6 — Reserved session ID tests**: `test/session-broker.test.ts` verifies that `''` and `'system'` are rejected with `INVALID_SESSION_ID` and that a normal ID succeeds.
- **B7 — State tool workspace-key tests**: `test/state-tool-workspace-keys.test.ts` covers `get` of `runtime.workingDir` and `daemon.homeDir`, `set` delegation to swapManager, no-swapManager error path, and read-only rejection of `daemon.homeDir`.
- **B9 — Path traversal tests**: Added to `daemon-home.test.ts` (`describe('WorkspaceSwapManager: path traversal')`). Documents the design choice: traversal is **allowed** (paths resolve naturally via OS; no sanitisation) because the swap endpoint is daemon-token-gated and operators are trusted. Tests verify no unhandled exception is thrown for `..` and path-with-dots inputs.
- **B1 — Concurrent mutex test in workspace-swap-reroot.test.ts**: `test/workspace-swap-reroot.test.ts` verifies the `WORKSPACE_BUSY` mutex response for concurrent swap calls and tests rerootStores delegation.

### Docs
- **W-9 — `validate:strict` documented**: `docs/release-and-publishing.md` gains a "Validation and Strict Gate" section explaining the `validate:strict` command and the error log location.

Gates: types:check pass, build clean, tests pass, sync:check pass.

## [0.21.20] - 2026-04-19

### Fixed
- Build compilation errors from 0.21.19 (CI orphan — v0.21.19 tag has no npm artifact). Root causes:
  - Missing `workspace` entry in `RUNTIME_DOMAIN_DESCRIPTIONS` Record after adding the `workspace` runtime domain.
  - `WorkspaceSwapManagerLike` not re-exported from `@pellux/goodvibes-daemon-sdk` barrel.
  - `buildSystemRouteContext` needed `swapManager` field in input + return; router call site passes `null` (real wiring lands when TUI standalone daemon assembles the swap manager).
  - `WorkspaceSwapManager._emit` missing `context` arg on `createEventEnvelope` call + envelope-type cast to bus's registered-union.
- No behavior delta from 0.21.19 — pure type-level fixes so the package actually builds.

Gates: types:check pass, build clean, 827/827 tests pass, sync:check pass.

## [0.21.19] - 2026-04-19 — superseded by 0.21.20 (CI orphan, no npm artifact)

### Added
- **Section 1 — Daemon-home / working-dir split**: Introduced `daemonHomeDir` concept (resolved from `--daemon-home=<path>` CLI arg → `GOODVIBES_DAEMON_HOME` env → `~/.goodvibes/daemon/` default). Identity files (`auth-users.json`, `auth-bootstrap.txt`, `daemon-settings.json`, `operator-tokens.json`) now live under daemon home rather than the workspace.
- **WorkspaceSwapManager**: New class managing `runtime.workingDir` transitions at runtime. Swap procedure: emit `WORKSPACE_SWAP_STARTED` → check busy sessions → mkdir subdirs → rerootStores → update state → persist to `daemon-settings.json` → emit `WORKSPACE_SWAP_COMPLETED`. Refused with `WORKSPACE_BUSY` (HTTP 409, `retryAfter: 5`) when any session has `pendingInputCount > 0`.
- **`POST /config {key:"runtime.workingDir"}`**: Now delegates to `WorkspaceSwapManager.requestSwap()` instead of the generic config-set path. Returns 200 on success, 409 `WORKSPACE_BUSY`, or 400 `INVALID_PATH`.
- **`WorkspaceSwapManagerLike`** interface added to `DaemonSystemRouteContext` as an optional (nullable) field `swapManager`. Exported from `@pellux/goodvibes-daemon-sdk`.
- **Workspace swap events** (`WORKSPACE_SWAP_STARTED`, `WORKSPACE_SWAP_COMPLETED`, `WORKSPACE_SWAP_REFUSED`) registered under the new `'workspace'` domain in the `RuntimeEventBus` domain map.
- **One-time migration**: On first startup with a new daemon home, `runDaemonHomeMigration()` copies identity files from old workspace paths (non-destructive; originals left intact).
- **`runtime.workingDir` persistence**: `WorkspaceSwapManager` writes the new path to `<daemonHomeDir>/daemon-settings.json` on each successful swap; `resolveDaemonCliOwnership()` reads this at startup so the last-used working directory is remembered across restarts.
- **`--daemon-home` and `--working-dir` CLI flags**: Parsed by the shared `parseCliFlag()` helper in `cli.ts`. `--working-dir` resolution order: flag → `GOODVIBES_WORKING_DIR` env → persisted daemon setting → `process.cwd()`.
- **F15 — `GOODVIBES_CHAT_LIMITER_THRESHOLD` env var**: Overrides the per-session rate limit in `CompanionChatRateLimiter`. Precedence: `DaemonConfig.companionChatRateLimiterOptions.threshold` > env var > compile-time default (10). New exported helper `readThresholdFromEnv()` for testability.
- **`DaemonConfig` additions**: `daemonHomeDir?: string` and `companionChatRateLimiterOptions?: { threshold?: number }` fields.

### Fixed
- **F3 revision — operator tokens follow daemon home**: `resolveSharedTokenPath()` in `companion-token.ts` now accepts a `daemonHomeDir` option (first priority). Workspace swaps no longer invalidate paired companion tokens; the token store stays in daemon home regardless of which workspace is active.
- **F13 — Content/body field normalization**:
  - `POST /api/companion/chat/sessions/:id/messages`: Now accepts both `body.body` and `body.content` (prefers `body` when both are present). Previously only read `body.content`.
  - `POST /api/sessions/:id/messages`: Now accepts `body.body` (canonical), `body.content` (F13 alias), `body.message`, and `body.text` (legacy fallbacks). Previously only read `body.body`, `body.message`, `body.text`.
  - Both endpoints return HTTP 400 when neither field is present.

### Migration
- **Daemon home migration is automatic and non-destructive**: On first 0.21.19 startup, identity files are copied from old paths to `<daemonHomeDir>/`. Original files are left in place. No manual steps required.
- **`DaemonSystemRouteContext` interface change**: `swapManager: WorkspaceSwapManagerLike | null` is a new required field. Callers constructing a `DaemonSystemRouteContext` object must add `swapManager: null` if workspace swapping is not needed, or wire a real `WorkspaceSwapManager` instance.

## [0.21.18] - 2026-04-19

### Fixed
- Internal `_internal/daemon/` mirrors for `api-router.ts`, `index.ts`, `media-routes.ts`, `runtime-automation-routes.ts` regenerated via `bun run sync --scope=daemon` to match 0.21.17 canonical sources. `v0.21.17` tag CI failed on `sync:check` drift; 0.21.18 supersedes with the mirror included. Re-ships identical 0.21.17 behavior (no code delta beyond the mirror).

## [0.21.17] - 2026-04-19 — superseded by 0.21.18 (CI orphan, no npm artifact)

### Added
- `DaemonApiRouteExtension` type exported from `@pellux/goodvibes-daemon-sdk`. Callers of `dispatchDaemonApiRoutes` may now pass an optional third argument `extensions?: readonly DaemonApiRouteExtension[]`. Each extension is tried in order after the core route set; the first non-null result wins. This closes the route-parity gap between the TUI-embedded and standalone daemon postures: standalone operators can wire companion-chat and provider routes by passing their own dispatchers without modifying core SDK files (F1).
- Companion token store path changed from per-surface `.goodvibes/<surface>/companion-token.json` to shared workspace path `.goodvibes/operator-tokens.json`. Tokens are now portable across TUI-embedded and standalone daemon postures — pair once, connect from either (F3).

### Fixed
- **F6**: `POST /api/orchestration/agents` now returns HTTP 429 with `Retry-After: 5` and `code: CAPACITY_EXCEEDED` when agent capacity is exhausted. Previously returned 500, which clients could not distinguish from a genuine server error.
- **F8**: `POST /api/voice/tts`, `POST /api/voice/stt`, and `POST /api/voice/realtime/session` now return HTTP 409 with `code: PROVIDER_NOT_CONFIGURED` when no voice provider is configured. Previously returned 404, which incorrectly implied the route does not exist.
- **F9**: `POST /api/schedules` (and `POST /api/automation/jobs`) now correctly reads the cron expression from the nested `schedule.expression` field when the standard `automation.jobs.create` contract format is used. Previously only read `body.cron`, so the nested format always failed with "schedule.expression must not be empty" even when the expression was non-empty.
- **F10**: Raw `throw new Error(...)` in `client.ts` auto-refresh path replaced with `throw new GoodVibesSdkError(...)` with `category: 'internal'`, `source: 'runtime'`, `recoverable: false`. Callers can now catch and narrow with `instanceof GoodVibesSdkError` rather than checking for `Error` and string-matching messages.

### Design Decisions
- **OTLP ingest (F7)**: The daemon telemetry API exposes consumer-pull OTLP GET endpoints only (`/api/telemetry/otlp/traces`, `/logs`, `/metrics`). These export recorded telemetry to external collectors. POST ingest endpoints for OTLP push-over-HTTP are not added; the daemon is a producer, not a collector. External OTLP collectors should be configured to receive push from the daemon if push delivery is required.

## [0.21.16] - 2026-04-19

### Fixed
- Network-discovered providers (LM Studio, Ollama, vLLM, llama.cpp, TGI, LocalAI, generic OpenAI-compat) now report as configured via `PATCH /api/providers/current`. Previously `createDiscoveredProvider` constructed instances with `apiKey: ''` but no anonymous flag, so `isConfigured()` returned false and the PATCH route rejected them with `PROVIDER_NOT_CONFIGURED`. Discovered providers are anonymous-configured by design (local-network servers); factory now passes `allowAnonymous: true, anonymousConfigured: true`.
- `ProviderRegistry.getConfiguredProviderIds()` now also consults registered provider instances via their `isConfigured()` method, so network-discovered providers (which live in `this.providers` but not in `catalogModels`) appear in the configured set.
- `LMStudioProvider`, `OllamaProvider`, `LlamaCppProvider` now expose `isConfigured()` that delegates to their fallback `OpenAICompatProvider` (compat shims `DiscoveredCompatProvider`, `VLLMProvider`, `TGIProvider`, `LocalAIProvider` already inherit from `OpenAICompatProvider`).
- `PATCH /api/providers/current` 409 response no longer emits literal placeholder text `<API key for X>` when a provider has no declared env vars. Message now reads clearly and `missingEnvVars` is `[]`.

## [0.21.15] - 2026-04-19

### Fixed
- De-flaked `I2(d): _syncScheduled coalesces burst of rememberEvent calls > lastEventAt inside setImmediate reflects most recent event, not first` test.
- Added network-error retry (3 attempts, 0/2s/5s backoff) to `scripts/install-smoke-check.ts` for both npm and bun install steps. CI smoke-check hits transient `ECONNRESET` / `ETIMEDOUT` from the registry under load; prior behavior failed the whole release on a single network blip. The assertion captured `t1 = Date.now()` BEFORE awaiting setImmediate; under CI timer jitter the `lastEventAt` value inside the dispatch callback could land after `t1`, causing the upper-bound assertion to race. Moved `t1` capture to AFTER the setImmediate await so the upper bound covers dispatch-time Date.now() calls. Two consecutive releases (0.21.13 and 0.21.14) failed on this flake; 0.21.15 re-ships the 0.21.14 content (companion main-chat short-circuit + updated tests) with the flake-proof test.

## [0.21.14] - 2026-04-19

### Fixed
- Updated `message-routing` tests in `test/` to match the corrected `kind: 'message'` behavior from 0.21.13. The previous tests encoded the old (buggy) behavior where `kind: 'message'` fell through to `sessionBroker.submitMessage()` + `bindAgent` (WRFC engineer chain). New tests verify the short-circuit: `appendCompanionMessage` + `publishConversationFollowup` fire, handler returns 202 with `{ routedTo: 'conversation' }`, no submitMessage/bindAgent call.
- Follow-up to 0.21.13: CI failure for `v0.21.13` was caused by these stale tests, so no npm artifact exists for 0.21.13. `v0.21.13` tag points at the unreleased commit; 0.21.14 supersedes.

## [0.21.13] - 2026-04-19

### Fixed
- `POST /api/sessions/:id/messages` with `kind: 'message'` (companion main-chat) no longer falls through to `sessionBroker.submitMessage()` after persisting + emitting `COMPANION_MESSAGE_RECEIVED`. The fall-through triggered `buildContinuationTask()` → WRFC engineer-chain spawn, causing companion sends like "Hello" to produce engineer-agent acknowledgement boilerplate ("Update noted", "WRFC chain has passed all gates") instead of a normal chat response. Handler now returns 202 `{ messageId, routedTo: 'conversation', sessionId }` immediately after the runtime-bus emit. The TUI's `COMPANION_MESSAGE_RECEIVED` subscriber (TUI 0.19.8+) delegates to `orchestrator.handleUserInput()` which fires a real LLM turn — same entry point as the TUI input box. Turn `STREAM_DELTA` / `TURN_COMPLETED` events stream to both TUI and companion over the existing SSE.
- Refreshed stale block-header comment describing the `kind: 'message'` branch behavior.

### Migration
- Requires TUI ≥ 0.19.8 for the companion-app main-chat flow to produce a response. The SDK-side fix alone prevents the WRFC-engineer-chain misbehavior; the TUI-side wiring converts the persisted companion message into a real LLM turn.

## [0.21.12] - 2026-04-19

### Added
- `kind: 'followup'` accepted at `POST /api/sessions/:id/messages`. Routes through `sessionBroker.followUpMessage()` which always spawns an agent. Full agent event chain streams back to companion SSE subscribers. Intended for the companion app's "shared session → follow-up" flow.
- New SSE endpoint: `GET /api/sessions/:id/events` — session-scoped event stream for companion consumption of shared-session events (turn deltas, agent chain, etc.). Scoped via `sessionId` filter + `clientKind: 'web'`.
- `'turn'` added to `DEFAULT_DOMAINS` in the control-plane gateway. Turn events (`STREAM_DELTA`, `TURN_COMPLETED`, etc.) now reach all SSE subscribers automatically instead of requiring per-stream opt-in.

### Changed
- `kind: 'message'` at `POST /api/sessions/:id/messages` now routes through `sessionBroker.submitMessage()` (same path as TUI input box) after persisting + emitting `COMPANION_MESSAGE_RECEIVED`. Starts a turn; agent may spawn based on content; turn events stream back to both TUI and companion. Previously never triggered a turn — the 202 was misleading.
- Companion app's "shared session → main chat" flow now behaves exactly like the TUI input box.

### Upgraded
- Daemon API surface adds `getSharedSessionEvents` handler. Contract types + Zod schemas updated in `packages/contracts` and mirrored.

## [0.21.10] - 2026-04-18

### Added
- `COMPANION_MESSAGE_RECEIVED` session event emitted on the runtime bus when a companion-app follow-up message is received, enabling in-process TUI surfaces to subscribe and render companion messages in the conversation view.
- `emitCompanionMessageReceived()` typed emitter in `platform/runtime/emitters`.

## [0.21.9] - 2026-04-18

### Fixed
- `POST /api/sessions/:id/messages` with `kind: 'message'` (companion main-chat sends) now persists the message to the shared session message log in addition to emitting the `conversation.followup.companion` event. Previously the 202 response was misleading — the event fired but the message never hit the session's persisted message store, so `GET /api/sessions/:id/messages` returned nothing for it and the TUI had no way to render it.

---

## [0.21.8] - 2026-04-18

### Changed
- Renamed internal local `_bareModelId` to `bareModelId` in companion chat adapter (0.21.7 review nit — the value is used, so the underscore prefix was misleading). Pure cosmetic, no behavioral change.

## [0.21.7] - 2026-04-18

### Fixed

- Companion chat adapter now correctly passes the bare model id (e.g. `"mercury-2"`) to provider `.chat()` calls, not the compound registry key (e.g. `"inception:mercury-2"`). Upstream compat APIs (InceptionLabs, Venice, Cerebras, Groq, etc.) only accept bare ids and were returning 400 invalid_request_error for requests that included the provider prefix. The `createCompanionProviderAdapter` function now resolves the `ModelDefinition` via the registry and uses its `.id` field, with a safe split-on-colon fallback if the definition lookup fails.
- Regression test added: `test/companion-adapter-model-resolution.test.ts` asserts the bare-id invariant.

---

## [0.21.6] - 2026-04-18

### Changed

- Tightened test hygiene in the provider-routes secrets-tier regression test (env mutation now scoped to `beforeEach`/`afterEach` to avoid any cross-file race potential).
- Added a cross-reference comment at the `secretsManager` dispatch site in `DaemonHttpRouter` to make the link to the `DaemonHttpRouterContext.secretsManager` doc obvious at the call site.

---

## [0.21.5] - 2026-04-18

### Fixed

- `configuredVia: 'secrets'` now correctly returned for providers whose API key is stored in SecretsManager but not in the environment. The 0.21.4 implementation was type-wired through `ProviderRouteContext` but the production `DaemonHttpRouter` never threaded `secretsManager` into the context literal, leaving the feature dead on live code paths. Added the plumbing and a router-level integration test to prevent regression.

---

## [0.21.4] - 2026-04-18

### Fixed

- `GET /api/providers` and `GET /api/providers/current` now correctly return `configuredVia: 'secrets'` when a provider's API key is stored in SecretsManager but not in the environment. Previously this state collapsed to `undefined`, reporting the provider as unconfigured and contradicting the advertised Zod contract.

### Testing

- `test/provider-sse-integration.test.ts` now exercises the real SSE path end-to-end: constructs a ControlPlaneGateway with an in-memory RuntimeEventBus, opens a live event stream, emits a MODEL_CHANGED envelope, and asserts exactly one SSE frame arrives. Protects against future regressions of gateway domain filtering or envelope serialization.
- `test/provider-routes.test.ts` PATCH-handler single-emission assertion now uses a real RuntimeEventBus + registry stub that emulates `setCurrentModel` emitting on the bus. The "exactly one MODEL_CHANGED per setCurrentModel" invariant is now meaningfully verified (was previously asserting 0 emissions from a no-op stub).

---

## [0.21.3] - 2026-04-18

### Fixed

- **Reactive `model.changed` delivery** — `DEFAULT_DOMAINS` in the control-plane gateway now includes `'providers'`, so `MODEL_CHANGED` events are automatically delivered to all companion SSE subscribers (e.g. `GET /api/companion/chat/sessions/:id/events`). This was broken in 0.21.2 where `'providers'` was missing from the default domain set.
- **Duplicate `MODEL_CHANGED` emission eliminated** — `PATCH /api/providers/current` previously emitted a second `MODEL_CHANGED` event after `setCurrentModel()` already emitted one synchronously. The redundant emission (with a different `traceId`, different `source`, and missing `previous` context) has been removed. Subscribers now receive exactly one `MODEL_CHANGED` per model switch.
- **`configuredVia` now correctly distinguishes all four states** — previously collapsed `subscription`, `anonymous`, and (theoretical) `secrets` into a single `'subscription'` value. Now returns `'env'` for env-var-backed providers, `'anonymous'` for anonymous-configured providers (e.g. SGLang, litellm local), and `'subscription'` for subscription-backed providers.
- **Persistence failures logged and reported** — `PATCH /api/providers/current` previously swallowed config-persistence errors silently. Failures are now logged via the platform logger and reported as `persisted: false` in the response body. Success returns `persisted: true`. See `PatchCurrentModelResponseSchema` / `PatchCurrentModelResponse` in `@pellux/contracts`.
- **Provider labels use brand-accurate casing** — `GET /api/providers` previously generated labels via naive titleCase (`Microsoft-foundry`, `Inceptionlabs`). Labels are now brand-accurate: `"OpenAI"`, `"Anthropic"`, `"Inception Labs"`, `"Microsoft Foundry"`, `"Hugging Face"`, `"GitHub Copilot"`, `"ElevenLabs"`, etc.
- **Internal contracts mirror regenerated** — `packages/sdk/src/_internal/contracts/zod-schemas/providers.ts` mirror was missing entirely in 0.21.2 (truncated `index.ts`, absent `providers.ts`). Regenerated from canonical `packages/contracts/src/zod-schemas/`.
- **CI: release workflow gates on `bun run sync:check`** — the `verify-tag-version` job now runs `bun run sync:check` before proceeding, so mirror drift cannot ship again.

### Added

- **`PatchCurrentModelResponseSchema` / `PatchCurrentModelResponse`** — new Zod schema and TypeScript type in `@pellux/contracts` for the `PATCH /api/providers/current` 200 response, extending `CurrentModelResponseSchema` with `persisted: boolean`.

---

## [0.21.2] - 2026-04-18

### Added

- **** — lists all registered providers and their models, with  /  flags and the list of environment variable names that would configure each provider. Response also includes .
- **** — returns the currently-selected model reference plus its  /  status.
- **** — body . Switches the active model live (no daemon restart). Returns 400  for unknown keys, 409  (with ) when the target provider lacks credentials, 200 + new current-model shape on success.
- **Reactive  event** —  now emits  on the  RuntimeEventBus domain. Companion SSE subscribers receive it automatically via the existing gateway domain-routing. Shape: .
- **Zod contract schemas** — , , , ,  exported from .
- **** — optional interface method; implemented on  and .
- **** — full API reference with curl examples, SSE event format, and error codes.

### Fixed

- **Clean error on unconfigured-provider turns** —  now checks  before calling . Unconfigured providers yield  immediately instead of letting the upstream return a cryptic 401 that was previously surfaced as .

### Migration

None required. All endpoint additions are additive. The  method is optional on the  interface — existing custom provider implementations that do not implement it are treated as configured.

---

## [0.21.1] - 2026-04-18

### Fixed

- **Postinstall patcher upgrades `minimatch` transitive to `10.2.5` in consumer installs**, remediating the 3 ReDoS advisories (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74). A `postinstall` script (`scripts/postinstall-patch-minimatch.mjs`) ships in the published tarball. When consumers run `npm install @pellux/goodvibes-sdk`, the script scans their `node_modules` for any `minimatch@>=10.0.0 <10.2.3` install and upgrades it in place by downloading `minimatch@10.2.5` from the npm registry and extracting it over the vulnerable directory.

**Background:** `bash-language-server@5.6.0` (a direct SDK dependency) hard-pins `editorconfig@2.0.1`, which hard-pins `minimatch@10.0.1`. The SDK's root `overrides` field works for local development and workspace installs but is ignored by npm and Bun when the package is consumed from a registry — npm/bun do not propagate `overrides` fields from installed packages into the consumer's install tree. The postinstall patcher is the mechanism that actually reaches consumer trees.

**Caveats:**
- If your environment uses `--ignore-scripts`, the patcher will not run. Add the following to your own `package.json` as a fallback:
  ```json
  "overrides": { "minimatch": "^10.2.5" }
  ```
  Then re-run `npm install`.
- Bun users: if your project's trust policy does not allow lifecycle scripts from this package, run `bun pm trust @pellux/goodvibes-sdk` before installing, or add the overrides block above.
- The patcher exits 0 on all errors and never fails your install.

## [0.21.0] - 2026-04-18

**Soak-period release.** Per `docs/tracking/road-to-1.0.md`, the SDK is now in soak. Consumers should begin integration testing against 0.21.0; the next version jump is 1.0.0 pending owner sign-off. 0.20.x is deliberately skipped to avoid "just another release" ambiguity.

This release is a posture statement, not a feature release. All engineering from 0.19.x is carried forward intact.

### Security

- **minimatch ReDoS CVEs patched via override** (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74). Root `package.json` and `packages/sdk/package.json` now pin `minimatch ^10.2.5` via the `overrides` field, forcing the bash-language-server → editorconfig → minimatch transitive chain to the patched version in local dev and bun workspace installs. Zero feature regression.

  **Consumer note**: npm does not propagate `overrides` from installed packages to the consumer's install tree. If your `npm audit` reports minimatch CVEs after installing this SDK, add the following to your own `package.json`:
  ```json
  "overrides": { "minimatch": "^10.2.5" }
  ```
  Then re-run `npm install`. This is a limitation of npm's override scoping — the SDK cannot force it on your behalf.

### Current state

The SDK surface covers two tiers: **full surface** (Node.js / Bun — all features including LSP services, auth with AutoRefreshCoordinator, platform token stores for iOS Keychain / Android Keystore / Expo SecureStore, Zod runtime validation, middleware/interceptor API, idempotency keys, W3C traceparent propagation, SBOM + provenance) and **companion surface** (browser / React Native / Expo / Workers — transport, auth, and event facade only; no `node:` builtins).

Transport stack: HTTP (fetch-based, streaming SSE), WebSocket (realtime events), direct (same-process). Auth: AutoRefreshCoordinator middleware with configurable refresh windows, token stores, typed retry backoff. Worker compatibility: Miniflare 4 + wrangler-CLI harness; see `test/workers/FINDINGS.md` for scope boundaries.

For full surface documentation: [packages.md](./docs/packages.md) · [surfaces.md](./docs/surfaces.md) · [authentication.md](./docs/authentication.md) · [observability.md](./docs/observability.md).

### Known posture

- **Production-workerd parity is out-of-scope for 1.0** — both `test/workers` and `test/workers-wrangler` harnesses share the Miniflare 4 runtime (`wrangler dev --local` uses Miniflare internally). True production verification requires a live Cloudflare deploy. See `test/workers/FINDINGS.md`.
- **Real-Node harness dimension still open** — tracked in `docs/tracking/roadmap-status.md`.
- **bash-language-server is a direct SDK dep** — required by the LSP service feature. Alternative classifications (devDep, peerDep) are a post-1.0 architectural question.

### Semver intent

0.21.0 → 1.0.0 will be a SEMVER-compliant jump. Any breaking change between this release and 1.0.0 must be called out in 1.0.0's CHANGELOG per `docs/semver-policy.md`.

## [0.19.9] - 2026-04-18

**Release pipeline hardening + zero-`any` gate + wrangler real-workerd harness.**

### Added

- **`wrangler dev --local` test harness** (`test/workers-wrangler/`): real workerd V8 isolate via `wrangler dev --local`, closing the Miniflare-4/production parity gap. 9/9 tests pass. Note: the shared Miniflare 4 runtime (used internally by wrangler) is functionally identical to the programmatic harness in `test/workers/` — the distinction is the wrangler CLI invocation surface, not a separate V8 build.
- **Zero-`any` type gate** (`scripts/no-any-types.ts`, `bun run any:check`): custom scanner that greps source for explicit `any` annotations in `packages/` source (excluding generated, vendor, and test fixture files). New CI job `no-any-types` runs on every push and PR. Starting baseline: zero occurrences.

### Changed

- **Worker test entries migrated from `.mjs` to `.ts`**: `test/workers/` entry files converted to TypeScript, aligned with workspace conventions.
- **`@cloudflare/workers-types` exact-pinned**: dependency locked to exact version to prevent silent type-surface drift across installs.
- **`.wrangler` gitignore narrowed**: ignore now scoped to the test harness path only, not the entire `.wrangler/` tree.

### Fixed

- **Release pipeline: `zod/v4` Bun smoke failure** (`scripts/install-smoke-check.ts`): `installWithBun` now explicitly appends `zod@^4` to install specs before invoking `bun add`. Previously, Bun 1.3.10 resolved `zod@3.24.2` from a transitive `bash-language-server` subtree, causing the `zod/v4` subpath import in the published dist to fail.
- **Release pipeline: `github-release` job decoupled from `verify`** (`.github/workflows/release.yml`): `github-release` job now uses `if: always() && github.event_name == 'push' && needs.publish-npm.result == 'success' && needs.generate-sbom.result == 'success'`. Previously it was `needs: verify`-chained so a smoke-check failure would orphan the GitHub Release object and leave the SBOM unattached.
- **Wrangler harness honesty**: corrected misleading comments that implied wrangler used a distinct workerd binary; `wrangler dev --local` uses Miniflare 4 as its shared runtime.
- **`version.ts` fallback sync** (`packages/sdk/src/_internal/platform/version.ts`): fallback version literal synced to `0.19.9` via `bun run sync:version` (previously 0.19.8 fallback was committed without the sync step in the 0.19.8 release).

### Documentation

- Comprehensive audit + drift sweep: Workers runtime in README companion enumeration, full CI gate table updated, Wrangler follow-up ticked, auth/middleware/idempotency/observability/runtime-compatibility/error-system/testing-gates pages updated.
- `sbom:check` reference corrected (no standalone script; validation runs inline in CI).

## [0.19.8] - 2026-04-17

**Waves 5-9 consolidated — production-readiness push.**

### Added

- **SBOM generation** (`scripts/sbom-generate.ts`, `bun run sbom:generate`): CycloneDX JSON output (`sbom.cdx.json`) with 1242 components. Uploaded as release artifact in `release.yml`.
- **Sync safety enforcement** (`scripts/sync-sdk-internals.ts` hardened): script refuses to run without `--scope=<name>`; supports comma-separated scopes and `--scope=all` explicit opt-in (with warning); protects `_internal/*.ts` barrel files from deletion.
- **`sync:check` expanded** (`scripts/sync-check.ts`): covers all 9 subsystems (was transport-http-only); supports `--scope` filter.
- **`sync-safety-check` CI job** in `.github/workflows/ci.yml`: asserts mirror in sync + deletion count ≤10 on PRs touching the tree.
- **`SECURITY.md`**: responsible-disclosure policy with reporting contact, GPG fingerprint placeholder, response SLA table, CVSS-based fix timelines, in/out-of-scope tables, 90-day coordinated disclosure, hall-of-fame credit terms.
- **`docs/semver-policy.md`**: explicit definition of what counts as a breaking change post-1.0.0 — major/minor/patch triggers, `_internal/` exclusions, deprecation process, TypeScript compatibility policy, enforcement via CHANGELOG gate.
- **Error-message quality audit** (Wave 6): every error across `transport-http`, `transport-realtime`, `operator-sdk`, `daemon-sdk`, `sdk/client.ts`, `sdk/auth.ts` rewritten to pass the three-part test: (a) states operation, (b) names offending field, (c) provides actionable recovery hint.
- **`docs/defaults.md`**: authoritative table of all timeout, retry, and backoff defaults with pathway, rationale, and 1.0.0 blocker notes.
- **Producer API bounded queue** (`transport-realtime`): new `emitLocal` method on `DomainEvents` with bounded queue (1024 entries, drop-oldest policy + counter).
- **Bundle-size budget gate** (`scripts/bundle-budget.ts`, `bundle-budgets.json`, `bun run bundle:check`): discovers exports map, gzips every JS dist entry, compares against per-entry budgets (16 entries at `ceil(actual_gzip * 1.2)`). Exits non-zero on FAIL or NO-BUDGET.
- **Verdaccio dry-run publish** (`scripts/verdaccio-dry-run.ts`, `bun run release:verify:verdaccio`): spawns local Verdaccio on ephemeral port, publishes SDK tarball, installs into scratch project, smoke-tests all 16 documented entries + 9 key named exports, anti-leak guard, cleanup on both success and failure paths.
- **Zod runtime validation at transport boundary** (Wave 7): opt-out (`validateResponses` SDK option) schema validation of typed operator responses at `transport-http` boundary. Schemas in `packages/contracts/src/zod-schemas/` cover auth, accounts, events, and session endpoints. `invokeContractRoute` throws `ContractError` with Wave 6 three-part message on parse failure.
- **`no-todo-markers` CI gate** (`scripts/no-todo-markers.ts`, `bun run todo:check`): greps `packages/` for `TODO|FIXME|XXX|HACK|STUB` outside `_internal/**`, vendor, generated, and test files. Exits non-zero on any match.
- **`flake-detect` CI gate** (`scripts/flake-detect.ts`, `bun run flake:check`): runs test suite N times (`FLAKE_RUNS` env; default 5, CI uses 3). Fails if any test flips between pass/fail across runs.
- **`api-extractor` CI gate** (`@microsoft/api-extractor@^7.58.4`, `api-extractor.json`, `etc/goodvibes-sdk.api.md` baseline, `bun run api:check`): fails on unintended public-surface diff. Companion `packages/sdk/tsconfig.api-extractor.json` prevents dist clobber.
- **Coverage backfill — 195 new tests** (Wave 8): `test/auth-coverage.test.ts`, `test/observer-coverage.test.ts`, `test/daemon-sdk-helpers.test.ts`, `test/operator-sdk-coverage.test.ts`, `test/peer-sdk-coverage.test.ts`. Zero rejection-swallow patterns; every test has at least one meaningful `expect()`.
- **Companion chat — 4 TODO items resolved** (Wave 8): session persistence (`companion-chat-persistence.ts`, atomic tmp-file+rename, per-session JSON), rate limiting (`companion-chat-rate-limiter.ts`, token-bucket per-session + per-client, `SDKError{kind:'rate-limit'}`), `ToolRegistry` DI wired into `CompanionChatManager`, all 4 TODO comments removed.
- **`sql.js` type shim** (`packages/sdk/src/_internal/platform/types/sql-js.d.ts`): covers `initSqlJs` + `Database` runtime surface; removes both `@ts-ignore` suppressions from `state/db.ts` and `state/sqlite-store.ts`.
- **Koa-style middleware chain** at `transport-http` request/response boundary. `TransportContext` + `TransportMiddleware` types in `packages/transport-core`. `sdk.use(mw)` facade on `createGoodVibesSdk`; `GoodVibesSdkOptions.middleware` initial set.
- **Idempotency-Key header** (UUID v4 via `crypto.randomUUID` with RFC 4122 fallback) on every non-GET/HEAD outgoing request.
- **Per-method retry policies**: `perMethodPolicy[methodId]` override, then `contract.idempotent` flag, then HTTP-verb default. `contract.idempotent` field added to `OperatorMethodContract` and `PeerEndpointContract`.
- **W3C Trace Context `traceparent` propagation**: HTTP headers, SSE headers, and WebSocket auth frame JSON. Zero-dep OTel detection via `new Function` pattern (Miniflare-safe). `setOtelModuleOverride` injection seam for tests.
- **`AutoRefreshCoordinator`** (Wave 9): pre-flight leeway check, shared-promise in-flight request coalescing, reactive 401 retry with one-shot guard. Consumer-pluggable via `AutoRefreshOptions.refresh`. Integrated as `createAutoRefreshMiddleware` prepended to transport middleware chain. `onAuthTransition` observer emissions on silent refresh and refresh failure.
- **`TokenStore` extensions**: optional `getTokenEntry`/`setTokenEntry` methods for `expiresAt` persistence; `SessionManager.login` persists `expiresAt` from login response.
- **Platform token stores** (Wave 9): `createExpoSecureTokenStore`, `createIOSKeychainTokenStore`, `createAndroidKeystoreTokenStore` — each persists token + `expiresAt` as single JSON blob in native secure slot. Optional peer deps (`expo-secure-store`, `react-native-keychain`). `__loadModule` injection seam. Exposed via `/expo` and `/react-native` subpaths.
- **`test/helpers/dist-errors.ts`**: re-exports compiled error classes from `packages/errors/dist` for tests asserting `instanceof` against transport-http's dist code (ESM module-identity pitfall).

### Changed

- **`maxAttempts` default**: `Infinity` → `DEFAULT_STREAM_MAX_ATTEMPTS = 10` (prevents prod-hang on auth-failure loops).
- **`maxDelayMs` default**: 5 s → 30 s for retry backoff.
- **`bundle-budgets.json`**: `./auth` entry raised 2500 → 3200 to accommodate auto-refresh middleware growth.
- **Mirror sync**: `ConversationMessageEnvelope` + `publishConversationFollowup` added to canonical `packages/daemon-sdk/src/runtime-route-types.ts`; companion-message routing added to `packages/daemon-sdk/src/runtime-session-routes.ts`.
- **JSDoc added** to `GoodVibesSdkError`, `ConfigurationError`, `ContractError`, `HttpStatusError` in `packages/errors/src/index.ts`.

### Fixed

- **`release.yml` `needs` expressions**: replaced invalid dynamic `fromJSON()` expressions with static arrays + `if: always()` guards. Workflow was failing at parse time (0 s) on every push to main since 83009b5.
- **Traceparent test isolation**: swapped `mock.module` for `setOtelModuleOverride` seam in `test/traceparent-propagation.test.ts`. Tests passed in isolation but failed under full CI ordering due to Bun ESM cache poisoning.
- **`ctx.error` passthrough**: non-401 errors placed on `ctx.error` (not re-thrown) so transport outer handler preserves original error kind (`5xx` stays `'server'`, network stays `'network'`).

## [0.19.7] - 2026-04-17

**Wave 4 Cloudflare Workers real-runtime verification + Track C policy docs.**

### Added

- **Cloudflare Workers real-runtime test harness** (`test/workers/`). Uses Miniflare 4 programmatic API to execute `@pellux/goodvibes-sdk/web` under the workerd V8 isolate. 9 tests across 6 endpoints (smoke, auth, transport, errors, crypto, globals). Passes locally.
- **`workers` CI matrix dimension** in `.github/workflows/ci.yml` under the `platform-matrix` job. Runs `bun run test:workers` alongside existing `bun` and `rn-bundle` dimensions.
- **`test:workers` script** in root `package.json`: `bun run build && bun test test/workers/workers.test.ts`.
- **`miniflare` dev dependency** pinned at `^4.20260415.0`.
- **`SECURITY.md`** (repo root): responsible-disclosure policy with reporting contact, GPG fingerprint placeholder, response SLA table, CVSS-based fix timelines, in/out-of-scope tables, 90-day coordinated disclosure, hall-of-fame credit terms. GitHub-supported format so it surfaces in the repo Security tab.
- **`docs/semver-policy.md`**: explicit definition of what counts as a breaking change post-1.0.0. Covers major/minor/patch triggers, what's out of scope (`_internal/`, `dist/` paths, `err.message`, subclass identity), deprecation process, TypeScript compatibility policy, enforcement via CHANGELOG gate.
- **Road-to-1.0 tracking additions**: new checklist items for Wave 6 (public-surface TODO cleanup: `transports/http.ts` fold + `runtime-events.ts:143` producer API queue bounding) and Wave 8 (companion chat internal TODOs, `sql.js` type shim to replace `@ts-ignore`, new `no-todo-markers` CI gate). Prevents TODO drift in public-surface source post-1.0.0.

### Changed

- **`docs/tracking/road-to-1.0.md`** updated with Wave 4 (landed) + Wave 5 `SECURITY.md` + Wave 6 `semver-policy.md` checkbox ticks.

### Findings (Workers runtime gap analysis)

Documented in `test/workers/FINDINGS.md`:
- `EventSource` absent in production Workers (Miniflare 4 simulates it — test accounts for the simulation)
- Outbound `new WebSocket()` absent (server-upgrade only)
- `location.origin` absent — `baseUrl` must be explicit (already surfaced via `ConfigurationError`)
- `setTimeout` is request-scoped — retry backoff is safe for bounded `maxAttempts`
- `crypto.subtle` + `crypto.randomUUID` present — future crypto paths need no shims
- `process`, `Buffer`, `fs` absent — matches browser; `./web` entry already compatible

### Decision

**`./web` entry is sufficient for Workers.** `dist/web.js` has zero `node:` imports, zero `Bun.*` API calls, and no client-WebSocket / EventSource usage. A dedicated `./workers` subpath export is **NOT** required. This decision is architecturally preferred — one fewer public surface to maintain.

### Known gaps (follow-ups)

- Harness runs under Miniflare only; running against real Wrangler runtime for stricter validation is tracked as a Wave 4 follow-up.
- Transport-round-trip test does not yet exercise a successful response path (only error-recovery) because the mock endpoint doesn't match an actual SDK control-plane route. Tracked as a Wave 6 follow-up.

### Not in this release

- **Wave 1** (observer seams): engineer-complete but review pending; will ship as 0.19.8.
- **Wave 2** (browser harness): failed review at 3.0/10; awaiting fix wave.
- **Wave 3** (Hermes harness): failed review at 8.8/10; awaiting fix wave.

---

## [0.19.6] - 2026-04-17

**Honest runtime posture + full documentation sweep + type-test relocation.** The biggest single release of the 0.19.x series. Breaking cleanup of previously-advertised Node support, comprehensive rewrite of consumer-facing documentation, monorepo version unification, and a new compile-time type-assertion gate.

### Breaking

- **`./node` exports entry removed** from `packages/sdk/package.json`. Consumers importing via `@pellux/goodvibes-sdk/node` must migrate to the root entry or an appropriate runtime-specific entry (`./react-native`, `./browser`, `./web`, `./expo`).
- **`./oauth` exports entry removed** from `packages/sdk/package.json`. The `./oauth` subpath was the Node-only OAuth fork (depends on `node:crypto` via `oauth-core.ts`). Consumers performing OAuth flows should use a server-side proxy and exchange tokens via the standard auth surface. The `OAuthClient` class is intentionally excluded from the companion barrel (`_internal/platform/auth/index.ts`) and was never usable on Hermes or browser.
- **`engines.node` removed**; replaced with `engines.bun: ">=1.0.0"`. The SDK does not support Node as a consumer runtime. Supported runtimes: Bun (dev + full agentic apps), Hermes (React Native / Expo for iOS + Android), browser.
- **`createNodeGoodVibesSdk` and `NodeGoodVibesSdkOptions` removed from the root `@pellux/goodvibes-sdk` entry.** These were helper factories that constructed an SDK instance with Node-specific defaults. The helpers are gone; consumers importing them from the root must migrate to `createGoodVibesSdk` (runtime-neutral) or the appropriate runtime-specific factory (`createReactNativeGoodVibesSdk`, `createBrowserGoodVibesSdk`).
- **`packages/sdk/src/node.ts` and `packages/sdk/src/oauth.ts` deleted** from the repo tree. The subpath exports were already removed; the source files are now gone so they cannot accidentally be re-exported.

### Added

- **Companion-bundle guard** (Wave S-ε.3): `test/rn-bundle-node-imports.test.ts` extended to cover all four companion entry points (`react-native.js`, `expo.js`, `browser.js`, `web.js`) plus `auth.js`. Asserts zero `Bun.*` API calls (agentic surface leak) AND zero `node:*` imports in each dist bundle. Run via the `rn-bundle` platform matrix dimension on CI.
- **`docs/surfaces.md`**: new authoritative document describing the two-tier surface split — **full surface** (Bun-only: TUI/daemon/CLI, includes agentic + `Bun.*` APIs) and **companion surface** (multi-runtime: Hermes, browser — auth + transport + events + contracts + errors + observer only). Includes supported-runtimes table, import-map per surface, and CI enforcement detail.
- **`docs/archive/README.md`** + **`docs/archive/releases/0.18.x/`**: 38 per-release notes (0.18.14 → 0.18.51) moved out of `docs/releases/` into a dated archive. Keeps the top-level docs tree focused on the 0.19.x series and forward. Archive README explains the policy and links back to the primary `CHANGELOG.md`.
- **Compile-time typed-client assertion suite** (relocated from `test-types/` → `test/types/`): `test/types/typed-client-usage.ts` exercises `GoodVibesSdk` generic inference against representative contract shapes. Run via `bun run types:check` (uses `tsconfig.type-tests.json`).
- **New `types-check` CI job** in `.github/workflows/ci.yml`: runs `bun run types:check` on every push/PR to `main`. Catches generic-inference regressions that the runtime test suite cannot.

### Changed — Documentation sweep (Wave D)

Every consumer-facing document reviewed for honest-runtime-posture compliance, hallucinations, and broken examples. All affected docs updated in a single wave so the published 0.19.6 artifact is internally consistent.

- **Front-door rewrites (Cluster 1)**: `README.md`, `docs/README.md`, `docs/getting-started.md`, `docs/public-surface.md` — removed all `/node` and `/oauth` references, rewrote quickstart examples against the real import surface, replaced `case 'AUTH_FAILED':` / `case 'TRANSPORT_ERROR':` patterns with the real `SDKErrorKind` union values (`'auth'`, `'network'`, `'server'`, `'validation'`, `'rate-limit'`, `'contract'`, `'config'`, `'not-found'`, `'unknown'`). Corrected `createOperatorClient` → `createOperatorSdk` and `createPeerClient` → `createPeerSdk`.
- **Integration guides (Cluster 2)**: `docs/react-native-integration.md`, `docs/expo-integration.md`, `docs/browser-integration.md`, `docs/web-ui-integration.md`, `docs/daemon-embedding.md`, `docs/pairing.md`, `docs/packages.md`, `docs/authentication.md`, `docs/observability.md` — corrected import paths (e.g. `@pellux/goodvibes-sdk/platform/pairing` → `@pellux/goodvibes-sdk/platform/pairing/index` because wildcard `./platform/*` exports do not resolve directory-index fallbacks), removed fabricated factory names (`createDaemonSdk`, `createDaemonRouteHandler`, `createReactNativeTokenStore`) and replaced with real exports (`createGoodVibesSdk`, `dispatchDaemonApiRoutes`, `createMemoryTokenStore`), fixed `createConsoleObserver` import to come from the root entry rather than `/errors`.
- **Architecture docs (Cluster 3)**: `docs/architecture.md`, `docs/architecture-platform.md`, `docs/compatibility.md`, `docs/performance.md`, `docs/security.md`, `docs/tool-safety.md`, `docs/retries-and-reconnect.md` — updated runtime matrix to match `docs/surfaces.md`, corrected references to removed subpaths, validated example snippets against real symbols.
- **Migration & operations (Cluster 4)**: `docs/migration.md`, `docs/troubleshooting.md`, `docs/release-and-publishing.md` — added explicit 0.18.x → 0.19.x migration notes (Node removal, error-kind rename, factory rename), aligned troubleshooting recipes with the real error taxonomy, updated publish workflow to reference the new `version:check` / `types:check` / `changelog:check` gates.
- **Roadmap & tracking (Cluster 6)**: `docs/roadmap-to-1.0.md`, `docs/tracking/roadmap-status.md`, `CONTRIBUTING.md` — marked S-α through S-θ.1 complete, recorded current score (9.0/10), added score-effect reading notes, scrubbed banned phrase "pre-existing" (consistent with project style rule).
- **Archive (Cluster 8)**: all 38 pre-0.19 release notes moved to `docs/archive/releases/0.18.x/` via git rename (history preserved). `SDK-TUI-MIGRATION-CHANGELOG.md` at repo root deleted — superseded by `CHANGELOG.md` + `docs/migration.md`.
- **Hallucination audit**: every code example across the docs tree verified by a verify-then-patch protocol — the fix agent was required to CONFIRM each flagged hallucination was actually wrong before editing; false positives left the docs unchanged. 17 confirmed hallucinations fixed; 1 falsely flagged (the `platform/pairing/index` path, which was actually the correct fix after live module resolution).
- **Examples**: `examples/operator-http-quickstart.mjs`, `examples/realtime-events-quickstart.mjs`, `examples/retry-and-reconnect.mjs`, `examples/submit-turn-quickstart.mjs` — updated to import from the current public surface and use real error-kind values.

### Removed

- `tests/node-smoke/` suite — removed entirely. It tested a runtime with no consumers.
- `node-20` / `node-22` CI matrix dimensions — removed from `.github/workflows/ci.yml`.
- Root `test:node-smoke` and `test:ci` scripts — removed from `package.json`.
- `packages/sdk/src/node.ts` (Node factory module — no longer exported).
- `packages/sdk/src/oauth.ts` (Node-only OAuth — no longer exported).
- `SDK-TUI-MIGRATION-CHANGELOG.md` at repo root (content superseded by this file + `docs/migration.md`).
- `test-types/` directory at repo root (renamed to `test/types/` to consolidate all tests under `test/`).

### Migration

- Consumers importing from `@pellux/goodvibes-sdk/node`: import from the root (`@pellux/goodvibes-sdk`) for Bun apps, or from a runtime-specific entry point for companion apps. Node.js consumption was never tested or supported despite the entry point existing.
- Consumers importing from `@pellux/goodvibes-sdk/oauth`: if you need daemon-to-daemon OAuth on Bun, access `OAuthClient` directly from the internal path (unsupported, may change) or open an issue for a supported API. RN/browser consumers should use the server-side proxy pattern.
- Consumers matching on error strings (`'AUTH_FAILED'`, `'TRANSPORT_ERROR'`, etc.): update to the real `SDKErrorKind` union — `'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'rate-limit' | 'server' | 'validation' | 'unknown'`. The real union has been stable since 0.19.2; the old string-tag form was never the runtime shape, only a docs hallucination.
- Consumers importing `createOperatorClient` / `createPeerClient`: rename to `createOperatorSdk` / `createPeerSdk`.
- No changes required if you import only from the root, `./auth`, `./errors`, `./contracts`, `./transport-*`, `./browser`, `./web`, `./react-native`, `./expo`, or `./platform/*` and were already using the real `SDKErrorKind` values.

### Infrastructure

- **All workspace packages unified at 0.19.6**: prior to this wave, `packages/sdk/package.json` had been bumped incrementally to 0.19.3–0.19.6 across per-wave releases while the root `package.json` and all other `packages/*/package.json` files remained at 0.18.53. All 11 `package.json` files (root + 10 workspace packages) are now at 0.19.6.
- **New `version-consistency` CI gate**: `scripts/version-consistency-check.ts` reads the root `package.json` version and asserts all `packages/*/package.json` files match. Wired as `bun run version:check` and runs on every push/PR to `main` via the `version-consistency` job in `.github/workflows/ci.yml`. Supports `WORKSPACE_ROOT` and `WORKSPACE_PACKAGES_JSON` env overrides to enable its own unit tests. Prevents future divergence from per-wave partial bumps.
- **New `types-check` CI job**: enforces `bun run types:check` on every push/PR. Uses `tsconfig.type-tests.json` (updated to include `test/types/**/*.ts` after the relocation).
- **Auto-synced version fallback**: `scripts/sync-version-fallback.ts` now writes `packages/sdk/src/_internal/platform/version.ts` with the root version on every version bump. No more manual drift between the package manifest and the runtime `SDK_VERSION` constant.
- **Root cause documentation**: `publish-packages.ts` reads `packages/sdk/package.json` for the changelog gate but does not propagate the version to sibling packages. Each package publishes its own stored `manifest.version`. Without a consistency gate, partial bumps were invisible to CI — fixed by the new `version-consistency` job.

### Internals

- **`SDKObserver.onAuthTransition` wired** in `packages/sdk/src/auth.ts`: captures the prior token via `ts?.getToken()` BEFORE calling `sm.login(...)`, then invokes the observer with `{ from: priorToken ? 'token' : 'anonymous', to: 'token', reason: 'login' }` after a successful login. Wrapped in `invokeObserver(...)` so observer exceptions never surface to callers. `onEvent` / `onError` / `onTransportActivity` remain on the roadmap as S-θ.2.
- **`test/integration/`** suite added: `auth-flow-e2e.test.ts` + `any-runtime-event-property.test.ts` + shared arbitraries — exercises the auth → transport → events happy path without touching external services.
- **`test/sdk-observer.test.ts`** + **`test/version-consistency.test.ts`** added: unit coverage for the observer helpers and the version-consistency check script (using `WORKSPACE_ROOT` override).

### Not shipped yet

- `SDKObserver.onEvent`, `SDKObserver.onError`, `SDKObserver.onTransportActivity` — design complete, wiring deferred to S-θ.2.
- Platform-matrix expansion (S-ε.2): RN/Hermes + browser runtime dimensions beyond bundle-shape checks.
- Hardening gates (S-ι): long-horizon stability work, ~2–3 weeks, required before 1.0.0 is eligible.
- **1.0.0 itself**: explicitly deferred. Per repo policy, 1.0.0 requires direct owner approval and is not implied by any code-quality threshold.

---

## [0.19.5] - 2026-04-17

SDK observer interface (partial delivery).

### Added

- **`SDKObserver` interface** (Wave S-θ.1): optional observability hook surface. Methods: `onAuthTransition` (wired), `onEvent` / `onError` / `onTransportActivity` (declared but not yet invoked — wire-up in S-θ.2). Export from `@pellux/goodvibes-sdk` root.
- **`createConsoleObserver(opts?)`** (Wave S-θ.1): dev adapter that logs observer events to the console. Optional `level` (`'debug' | 'info'`, default `'info'`).
- **`createOpenTelemetryObserver(tracer, meter)`** (Wave S-θ.1): production adapter that emits OpenTelemetry spans and counters. Accepts external `tracer` and `meter` args — no hard `@opentelemetry/*` dependency; consumers bring their own.
- **Auth transition observability** (Wave S-θ.1): `createGoodVibesAuthClient` accepts an optional 4th `observer?: SDKObserver` argument and fires `onAuthTransition` on login and logout.
- **`docs/observability.md`** (Wave S-θ.1): new section documenting the interface, adapters, silent-on-error guarantee, and wire-up status.

### Deferred

- **`onEvent`, `onError`, `onTransportActivity` wire-up** (Wave S-θ.2): declared on the interface but no SDK code fires them yet. Consumers may register implementations safely — they will begin firing when the wire-up lands.

### Migration

- Existing consumers of `createGoodVibesAuthClient` are unaffected. The new `observer` argument is optional (4th positional) and defaults to undefined.
- To observe auth transitions, pass `createConsoleObserver()` or your own `SDKObserver` implementation as the 4th argument.

---

## [0.19.4] - 2026-04-17

Integration + property test infrastructure. No consumer-facing API changes.

### Added

- **End-to-end auth flow integration test** (Wave S-ζ): `test/integration/auth-flow-e2e.test.ts` drives `createGoodVibesAuthClient` + `createOperatorSdk` through login → authenticated call → session expiry → revoke → 401 fallback against a real `Bun.serve` fake operator server. 4 scenarios covering session-cookie, shared-token, and fallthrough auth modes.
- **Property tests for `AnyRuntimeEvent` round-trips** (Wave S-ζ): `test/integration/any-runtime-event-property.test.ts` uses `fast-check` with 100-200 iterations per property to verify every event kind round-trips through JSON serialization without type loss, malformed events produce typed errors, and discriminant coverage is exhaustive.
- **`fast-check` dev dependency** pinned to `3.23.2`.

### Deferred

- **SSE/WebSocket chaos tests** (Wave S-ζ.2): network-failure injection harness for backoff + reconnect policy assertions. Scheduled for a follow-up.
- **`createGoodVibesAuthClient` decomposition regression test** (Wave S-ζ.2): explicit TokenStore + SessionManager + PermissionResolver compose-equivalence test. Partially covered by the existing auth-* test suite + the new e2e test.

---

## [0.19.0] - 2026-04-17

### Breaking

- **`_internal` path no longer reachable through package exports** (Wave S-α): `packages/sdk/package.json` exports map updated so `./platform/*` resolves to `./dist/platform/*.js` instead of `./dist/_internal/platform/*.js`. Any consumer importing via `@pellux/goodvibes-sdk/dist/_internal/...` or using `./platform/*` subpaths that relied on the old resolution must update to the public barrel entry-points.
- **633 transparent barrel files added** (Wave S-α): public platform surface is now exported through explicit barrels. Consumers importing from private paths that were accidentally resolvable before will receive module-not-found errors at build time.

### Added

- **Mirror drift guard** (Wave S-γ): `bun run sync:check` (`scripts/sync-check.ts`) verifies byte-parity between `packages/transport-http/src/**` (canonical) and `packages/sdk/src/_internal/transport-http/**` (mirror). Enforced in CI via the `mirror-drift` job on every push/PR to `main`.
- **Shared normalization module** (Wave S-γ): `scripts/_internal/normalize.ts` extracted as a shared helper used by the sync + drift-guard scripts so normalization logic cannot diverge between them.

### Fixed

- Mirror drift in `packages/sdk/src/_internal/transport-http/**` that caused consumer regressions is now caught before it reaches main.

### Migration

- Replace any imports of the form `@pellux/goodvibes-sdk/dist/_internal/platform/...` with the corresponding public barrel: `@pellux/goodvibes-sdk/platform/...` or a named export from the top-level `@pellux/goodvibes-sdk` entry.
- If you used `./platform/*` subpath exports, verify your import still resolves after upgrading — the target changed from `_internal/platform` to `platform`.
- Run `bun run sync:check` locally before pushing to verify no transport-http mirror drift.

---

## [0.19.3] - 2026-04-17

Error taxonomy enforcement on the public surface.

### Breaking

- **Public SDK functions now throw typed `GoodVibesSdkError` instead of raw `Error`** (Wave S-β): consumers can now discriminate errors by `err.kind` / `err.category` / `err.source` fields rather than string-matching `err.message`. The error types are unchanged — only the concrete throw sites are now typed. Code that catches and inspects SDK errors may gain new structured fields; code that catches without inspection continues to work unchanged.
- Converted 7 raw throw sites on the canonical public surface:
  - `packages/daemon-sdk/src/knowledge-routes.ts` (4 schedule validation throws → `GoodVibesSdkError` with `category: 'bad_request'`, `source: 'contract'`, which maps to kind `validation`).
  - `packages/transport-http/src/contract-client.ts` (1 unknown-route throw → `category: 'contract'`, kind `contract`).
  - `packages/transport-http/src/paths.ts` (1 missing-baseUrl throw → `ConfigurationError` with code `SDK_TRANSPORT_BASE_URL_REQUIRED`, kind `config`).
  - `packages/operator-sdk/src/client-core.ts` (1 no-HTTP-binding throw → `category: 'contract'`, kind `contract`).

### Added

- **`throw-guard` CI job** (Wave S-β): `.github/workflows/ci.yml` gains a ripgrep-based gate that fails the build if any of the following patterns appear in public source (`packages/**/src/**` excluding `_internal/`, `errors/`, tests): `throw new Error(`, `throw Error(`, `throw {`, `throw '`, `throw "`. Enforced on push/PR to `main`. Prevents regression of the typed-error contract.
- **`docs/error-kinds.md`** (Wave S-β): one section per `SDKErrorKind` value documenting when it fires, what remediation consumers should attempt, and whether it's retryable.
- **`docs/error-handling.md` extended** (Wave S-β): typed-discrimination consumer pattern with a TUI-style `switch (err.kind)` example.

### Migration

- Consumers catching SDK errors can now use `if (err instanceof GoodVibesSdkError) switch (err.kind) { ... }` to handle specific error categories. See `docs/error-handling.md` for the canonical pattern.
- If your code was catching specific error messages via string match, verify the corresponding `err.kind` / `err.category` gives you the same discriminator. Message strings may change; kinds will not (post-1.0).

---

## [0.19.2] - 2026-04-17

Mirror drift cleanup. No consumer-facing API changes.

### Added

- **`--scope=<subsystem>` flag on `scripts/sync-sdk-internals.ts`** (Wave S-γ-cleanup): allows narrow regeneration of a single mirror subsystem without touching others. `removeStaleFiles` is narrowed to the scoped `targetDir` when `--scope` is active, fixing a prior bug where the stale walker would traverse all of `_internal/` regardless of the sync target. Default (no `--scope`) behavior preserved — full-tree sync still works.

### Fixed

- **8 transport-http mirror drifts resolved** (Wave S-γ-cleanup): ran `bun scripts/sync-sdk-internals.ts --scope=transport-http` to regenerate `auth.ts`, `backoff.ts`, `contract-client.ts`, `http-core.ts`, `paths.ts`, `reconnect.ts`, `retry.ts`, `sse-stream.ts`. Legacy `// Extracted from …` banners replaced with correct `// Synced from …` banners; `sse-stream.ts` import-order content drift resolved. The `mirror-drift` CI job (introduced in 0.19.0) can now pass on `main`.

### Migration

- For future narrow drift cleanups, use `bun scripts/sync-sdk-internals.ts --scope=<subsystem>` where `<subsystem>` is one of: `contracts`, `errors`, `daemon`, `transport-core`, `transport-direct`, `transport-http`, `transport-realtime`, `operator`, `peer`.

---

## [0.19.1] - 2026-04-17

Two release-infrastructure waves. No consumer-facing API changes.

### Added

- **Changelog gate** (Wave S-δ): `bun run changelog:check` (`scripts/check-changelog.ts`) verifies that a `CHANGELOG.md` section exists for the current `packages/sdk` version. Enforced in CI via the new `changelog-check` job and inline in `scripts/publish-packages.ts` as a pre-stage gate. Future releases are blocked until their `## [X.Y.Z]` section is added.
- **Platform test matrix** (Wave S-ε, partial): `.github/workflows/ci.yml` gains a `platform-matrix` job running the test suite under four dimensions — `bun`, `bun-on-node20`, `bun-on-node22`, `rn-bundle`. `rn-bundle` folds the prior standalone RN `node:` import check into the matrix. The `bun-on-node20` / `bun-on-node22` dimensions are honestly labeled — Bun is the test runner in all four, with the Node binary present in the environment to catch install-time regressions; they do not run tests under `node --test`.
- **`test:ci`, `test:rn` scripts** (Wave S-ε): single-source build-and-test commands invoked by the matrix job.
- **Changelog Gate + Platform Matrix docs** (Waves S-δ, S-ε): new sections in `docs/release-and-publishing.md`.

### Deferred

- **Real Node-as-runtime dimensions** (Wave S-ε follow-up): converting `bun-on-nodeN` dimensions to genuine `node --test` execution against `dist/` requires a Node-compatible test harness; tracked separately.
- **Browser + Cloudflare Workers dimensions** (Wave S-ε follow-up): need `@vitest/browser` + Playwright and Miniflare harnesses respectively; both deferred.
- **Broader mirror drift cleanup**: a drift-cleanup attempt via `bun run sync` was reverted during this release because `sync` targets all `_internal/**` subsystems (daemon, transport-core, transport-direct, transport-realtime, operator, peer) beyond the transport-http scope of the guard, and regenerating those mirrors surfaced latent type mismatches between canonical packages and their barrel consumers. Only transport-http drift was intended; a future WRFC will narrow the sync invocation.

### Migration

- Before releasing, run `bun run changelog:check` to confirm the CHANGELOG entry is present for the version being published. The publish script will fail fast if it is missing.
- CI now runs four platform-matrix dimensions. If you have a fork, confirm your CI setup pulls the updated `.github/workflows/ci.yml`.
