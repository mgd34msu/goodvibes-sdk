# Test Coverage Map

This file maps the `obs-`, `sec-`, and `perf-` numeric test file convention to their actual
implementation files (or notes when a coverage item was merged into another file).

**M3 (seventh-review):** Added to track all numbered test IDs and prevent coverage gaps.
**MAJ-02 fix (eighth-review):** Removed stale "Gap flagged by seventh-review" tombstones that
persisted unfixed through the eighth review. Gaps that remain are noted as known-gap with a
resolution path; all other missing slots are removed from the numbering.

---

## obs- (Observability)

| ID | File | Notes |
|---|---|---|
| obs-01 | `test/obs-01-http-access-log.test.ts` | HTTP access log events |
| obs-02 | `test/obs-02-auth-events.test.ts` | Auth lifecycle events |
| obs-03 | `test/obs-03-instrumented-fetch.test.ts` | Instrumented fetch wrapper |
| obs-04 | `test/obs-04-llm-instrumentation.test.ts` | LLM call instrumentation |
| obs-05 | `test/obs-05-tool-result-summary.test.ts` | Tool result summarization |
| obs-06 | `test/obs-06-prompt-redaction.test.ts` | Prompt redaction |
| obs-07 | `test/obs-07-otlp-logger.test.ts` | OTLP logger |
| obs-08 | `test/obs-08-workspace-swap-failed.test.ts` | Workspace swap failure events |
| obs-09 | `test/obs-09-config-audit.test.ts` | Config audit events |
| obs-10 | _(known gap — not yet implemented)_ | No coverage path identified; deferred |
| obs-11 | `test/obs-11-silent-catches.test.ts` | Silent catch detection |
| obs-12 | `test/obs-12-runtime-meter.test.ts` | Runtime meter instrumentation |
| obs-13 | `test/obs-13-listener-errors.test.ts` | Event listener error handling |
| obs-14 | `test/obs-14-async-event-bus.test.ts` | Async event bus |
| obs-15 | `test/obs-15-correlation-ids.test.ts` | Correlation ID propagation |
| obs-16 | `test/obs-16-error-cause-chain.test.ts` | Error cause chain |
| obs-17 | _(known gap — not yet implemented)_ | No coverage path identified; deferred |
| obs-18 | `test/obs-18-retry-events.test.ts` | Retry events |
| obs-19 | `test/obs-19-sse-lifecycle.test.ts` | SSE lifecycle events |
| obs-20 | _(known gap — not yet implemented)_ | No coverage path identified; deferred |
| obs-21 | `test/obs-21-companion-pairing.test.ts` | Companion pairing events |
| obs-22 | `test/obs-22-label-allowlist.test.ts` | Label allowlist enforcement |
| obs-23 | _(known gap — not yet implemented)_ | No coverage path identified; deferred |
| obs-24 | `test/obs-24-bearer-redaction.test.ts` | Bearer token redaction |

---

## sec- (Security)

| ID | File | Notes |
|---|---|---|
| sec-01 | `test/sec-01-user-auth-perms.test.ts` | User auth permissions |
| sec-02 | `test/sec-02-safecopy-perms.test.ts` | Safe-copy permissions |
| sec-03 | `test/sec-03-login-ratelimit.test.ts` | Login rate limiting |
| sec-04 | `test/sec-04-input-sanitization.test.ts` | Input sanitization smoke (coverage gap — see eighth-review COV-sec-04) |
| sec-05 | `test/sec-05-body-size-cap.test.ts` | Body size cap |
| sec-06 | `test/sec-06-rate-limiter-lru.test.ts` | Rate limiter LRU |
| sec-07 | `test/sec-07-origin-defaults.test.ts` | Origin header defaults |
| sec-08 | `test/sec-08-ssrf-filter.test.ts` | SSRF filter |
| sec-09 | `test/sec-09-permission-normalization.test.ts` | Permission normalization smoke (coverage gap — see eighth-review COV-sec-09) |
| sec-10 | `test/sec-10-sandbox-boundary.test.ts` | Sandbox boundary smoke (coverage gap — see eighth-review COV-sec-10) |

---

## perf- (Performance)

| ID | File | Notes |
|---|---|---|
| perf-01 | Merged into `test/perf-02-rate-limiter-lru.test.ts` | SessionBroker LRU absorbed per memory record |
| perf-02 | `test/perf-02-rate-limiter-lru.test.ts` | Rate limiter LRU eviction |
| perf-03 | `test/perf-03-scheduler-history.test.ts` | Scheduler history |
| perf-04 | _(known gap — not yet implemented)_ | Deferred |
| perf-05 | _(known gap — not yet implemented)_ | Deferred |
| perf-06 | _(known gap — not yet implemented)_ | Deferred |
| perf-07 | `test/perf-07-interval-unref.test.ts` | `.unref?.()` coverage for all setInterval sites |
| perf-08 | _(known gap — not yet implemented)_ | Deferred |
| perf-09 | _(known gap — not yet implemented)_ | Deferred |
| perf-10 | `test/perf-10-max-listeners.test.ts` | Max-listeners guard |
| perf-11 | _(known gap — not yet implemented)_ | Deferred |
| perf-12 | `test/perf-12-gateway-ring-buffer.test.ts` | Gateway ring buffer |

---

*Last updated: 2026-05-03. Regenerate after adding new numbered test files.*
