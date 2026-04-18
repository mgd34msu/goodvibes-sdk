# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

> **Versions prior to 0.19.0**: see `docs/releases/*.md` for long-form per-release notes.

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
