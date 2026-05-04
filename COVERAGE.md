# Test Coverage Map

This file maps test file numbers to test files for navigation and review.
Generated from the sorted list of `test/*.test.ts` root-level files.
Integration tests live under `test/integration/` and are listed separately.

## Root-level tests (`test/*.test.ts`)

| # | File |
|---|------|
| T01 | `test/android-keystore-token-store.test.ts` |
| T02 | `test/arch03-error-hierarchy.test.ts` |
| T03 | `test/artifact-upload-ingest.test.ts` |
| T04 | `test/auth-auto-refresh-transport-integration.test.ts` |
| T05 | `test/auth-auto-refresh.test.ts` |
| T06 | `test/auth-coverage.test.ts` |
| T07 | `test/auth-facade.test.ts` |
| T08 | `test/auth-normalize.test.ts` |
| T09 | `test/auth-oauth-client.test.ts` |
| T10 | `test/auth-permission-resolver.test.ts` |
| T11 | `test/auth-session-manager.test.ts` |
| T12 | `test/auth-token-store.test.ts` |
| T13 | `test/bootstrap-services.test.ts` |
| T14 | `test/cache-invariants.test.ts` |
| T15 | `test/channel-builtin-plugins.test.ts` |
| T16 | `test/channel-policy-patch.test.ts` |
| T17 | `test/channel-reply-pipeline.test.ts` |
| T18 | `test/cloudflare-control-plane.test.ts` |
| T19 | `test/cloudflare-worker-batch.test.ts` |
| T20 | `test/cloudflare-worker-settings.test.ts` |
| T21 | `test/companion-adapter-model-resolution.test.ts` |
| T22 | `test/companion-chat-daemon-wire.test.ts` |
| T23 | `test/companion-chat-f21-messages-get.test.ts` |
| T24 | `test/companion-chat-lifecycle.test.ts` |
| T25 | `test/companion-chat-persistence.test.ts` |
| T26 | `test/companion-chat-rate-limit.test.ts` |
| T27 | `test/companion-chat-routes.test.ts` |
| T28 | `test/companion-chat-session-create-provider-resolution.test.ts` |
| T29 | `test/companion-chat-session-isolation.test.ts` |
| T30 | `test/companion-chat-tool-registry.test.ts` |
| T31 | `test/companion-followup-persistence.test.ts` |
| T32 | `test/completion-report-constraints.test.ts` |
| T33 | `test/contracts-portability.test.ts` |
| T34 | `test/contracts-sync.test.ts` |
| T35 | `test/conversation-message-routing.test.ts` |
| T36 | `test/crypto-adapter.test.ts` |
| T37 | `test/daemon-batch-manager.test.ts` |
| T38 | `test/daemon-home.test.ts` |
| T39 | `test/daemon-sdk-auth-boundary.test.ts` |
| T40 | `test/daemon-sdk-helpers.test.ts` |
| T41 | `test/daemon-sdk.test.ts` |
| T42 | `test/daemon-state-reconciliation.test.ts` |
| T43 | `test/default-config-runtime.test.ts` |
| T44 | `test/dist-freshness.test.ts` |
| T45 | `test/ecosystem-catalog-paths.test.ts` |
| T46 | `test/error-kind.test.ts` |
| T47 | `test/exec-retry.test.ts` |
| T48 | `test/expo-secure-token-store.test.ts` |
| T49 | `test/f13-field-normalization.test.ts` |
| T50 | `test/f15-rate-limiter-env.test.ts` |
| T51 | `test/feature-flag-gates.test.ts` |
| T52 | `test/gateway.test.ts` |
| T53 | `test/goodvibes-runtime-tools.test.ts` |
| T54 | `test/homeassistant-surface.test.ts` |
| T55 | `test/homegraph-ask-reindex.test.ts` |
| T56 | `test/homegraph-ask-space-selection.test.ts` |
| T57 | `test/homegraph-extension.test.ts` |
| T58 | `test/homegraph-map-routes.test.ts` |
| T59 | `test/homegraph-object-search.test.ts` |
| T60 | `test/homegraph-page-quality.test.ts` |
| T61 | `test/homegraph-repair-pages.test.ts` |
| T62 | `test/homegraph-routes.test.ts` |
| T63 | `test/homegraph-sync-pages.test.ts` |
| T64 | `test/hostmode-restart.test.ts` |
| T65 | `test/idempotency-keys.test.ts` |
| T66 | `test/ios-keychain-token-store.test.ts` |
| T67 | `test/knowledge-browser-history.test.ts` |
| T68 | `test/knowledge-extraction-policy.test.ts` |
| T69 | `test/knowledge-ingest-compile.test.ts` |
| T70 | `test/knowledge-projections-map.test.ts` |
| T71 | `test/knowledge-repair-profile.test.ts` |
| T72 | `test/knowledge-review.test.ts` |
| T73 | `test/knowledge-semantic-answer.test.ts` |
| T74 | `test/knowledge-semantic-repair.test.ts` |
| T75 | `test/knowledge-semantic-runtime.test.ts` |
| T76 | `test/knowledge-semantic-self-improvement.test.ts` |
| T77 | `test/lazy-native-imports.test.ts` |
| T78 | `test/live-roundtrip.test.ts` |
| T79 | `test/lsp-bash-bundled.test.ts` |
| T80 | `test/ntfy-integration-stream.test.ts` |
| T81 | `test/obs-01-http-access-log.test.ts` |
| T82 | `test/obs-02-auth-events.test.ts` |
| T83 | `test/obs-03-instrumented-fetch.test.ts` |
| T84 | `test/obs-04-llm-instrumentation.test.ts` |
| T85 | `test/obs-05-tool-result-summary.test.ts` |
| T86 | `test/obs-06-prompt-redaction.test.ts` |
| T87 | `test/obs-07-otlp-logger.test.ts` |
| T88 | `test/obs-08-workspace-swap-failed.test.ts` |
| T89 | `test/obs-09-config-audit.test.ts` |
| T90 | `test/platform-adapter-contract.test.ts` — 31 tests |

_Note: This list covers the first 90 root-level test files (sorted). Run `bun scripts/test.ts` to discover the full set dynamically._

## Integration tests (`test/integration/*.test.ts`)

| # | File |
|---|------|
| I01 | `test/integration/any-runtime-event-property.test.ts` |
| I02 | `test/integration/auth-flow-e2e.test.ts` |

## Specialised suites

| # | File | Notes |
|---|------|-------|
| W01 | `test/workers/workers.test.ts` | Cloudflare Workers runtime |
| W02 | `test/workers-wrangler/wrangler.test.ts` | Wrangler integration |
| H01 | `test/hermes/` | React Native Hermes bundle |

## Coverage areas by module

| Module area | Test files |
|-------------|------------|
| Auth | T04–T12 |
| Bootstrap | T13 |
| Channel | T15–T17 |
| Cloudflare Workers | T18–T20, W01–W02 |
| Companion chat | T21–T31 |
| Contracts | T33–T34 |
| Daemon SDK | T39–T43 |
| Dist freshness | T44 |
| Error hierarchy | T02, T46 |
| Feature flags | T51 |
| HomeAssistant | T54 |
| Homegraph | T55–T63 |
| Idempotency | T65 |
| Knowledge | T67–T76 |
| Observability | T81–T89 |
| Platform adapter contract | T90 |
| ntfy integration | T80 |
| Token stores (mobile) | T01, T48, T66 |
