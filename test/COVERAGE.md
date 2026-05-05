# Test Coverage Map

This file maps focused observability, security, and performance coverage to
their implementation files.

This map tracks implemented coverage areas. Removed or merged checks are listed
by their current file names instead of retaining issue-number labels.

---

## Observability

| File | Notes |
|---|---|
| `test/http-access-log.test.ts` | HTTP access log events |
| `test/auth-events.test.ts` | Auth lifecycle events |
| `test/instrumented-fetch.test.ts` | Instrumented fetch wrapper |
| `test/llm-instrumentation.test.ts` | LLM call instrumentation |
| `test/tool-result-summary.test.ts` | Tool result summarization |
| `test/prompt-redaction.test.ts` | Prompt redaction |
| `test/otlp-logger.test.ts` | OTLP logger |
| `test/workspace-swap-failed.test.ts` | Workspace swap failure events |
| `test/config-audit.test.ts` | Config audit events |
| `test/silent-catches.test.ts` | Silent catch detection |
| `test/runtime-meter.test.ts` | Runtime meter instrumentation |
| `test/listener-errors.test.ts` | Event listener error handling |
| `test/async-event-bus.test.ts` | Async event bus |
| `test/correlation-ids.test.ts` | Correlation ID propagation |
| `test/error-cause-chain.test.ts` | Error cause chain |
| `test/retry-events.test.ts` | Retry events |
| `test/sse-lifecycle.test.ts` | SSE lifecycle events |
| `test/companion-pairing-redaction.test.ts` | Companion pairing events |
| `test/telemetry-label-allowlist.test.ts` | Label allowlist enforcement |
| `test/bearer-redaction.test.ts` | Bearer token redaction |

---

## Security

| File | Notes |
|---|---|
| `test/user-auth-file-perms.test.ts` | User auth permissions |
| `test/daemon-home-setting-perms.test.ts` | Daemon home setting permissions |
| `test/login-ratelimit.test.ts` | Login rate limiting |
| `test/input-sanitization.test.ts` | Input sanitization smoke |
| `test/http-body-size-cap.test.ts` | Body size cap |
| `test/http-rate-limiter-lru.test.ts` | Rate limiter LRU |
| `test/origin-defaults.test.ts` | Origin header defaults |
| `test/ssrf-filter.test.ts` | SSRF filter |
| `test/permission-normalization.test.ts` | Permission normalization smoke |
| `test/sandbox-boundary.test.ts` | Sandbox boundary smoke |

---

## Performance

| File | Notes |
|---|---|
| `test/companion-chat-rate-limiter-lru.test.ts` | Session chat limiter LRU eviction |
| `test/http-rate-limiter-lru.test.ts` | HTTP rate limiter LRU eviction |
| `test/scheduler-history.test.ts` | Scheduler history |
| `test/interval-unref.test.ts` | `.unref?.()` coverage for all setInterval sites |
| `test/runtime-event-bus-max-listeners.test.ts` | Max-listeners guard |
| `test/gateway-ring-buffer.test.ts` | Gateway ring buffer |

---

*Last updated: 2026-05-04. Update after adding or renaming coverage files.*
