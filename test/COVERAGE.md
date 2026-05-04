# Test Coverage Map

This file maps the `obs-`, `sec-`, and `perf-` numeric test file convention to their actual
implementation files (or notes when a coverage item was merged into another file).

**M3 (seventh-review):** Added to track all numbered test IDs and prevent coverage gaps.

---

## obs- (Observability)

| ID | File | Notes |
|---|---|---|
| obs-01 | `test/obs-01-*.test.ts` | _(not yet assigned)_ |
| obs-02 | `test/obs-02-*.test.ts` | _(not yet assigned)_ |
| obs-03 | `test/obs-03-*.test.ts` | _(not yet assigned)_ |
| obs-04 | `test/obs-04-llm-instrumentation.test.ts` | LLM call instrumentation |
| obs-05 | `test/obs-05-*.test.ts` | _(not yet assigned)_ |
| obs-06 | `test/obs-06-*.test.ts` | _(not yet assigned)_ |
| obs-07 | `test/obs-07-*.test.ts` | _(not yet assigned)_ |
| obs-08 | `test/obs-08-*.test.ts` | _(not yet assigned)_ |
| obs-09 | `test/obs-09-*.test.ts` | _(not yet assigned)_ |
| obs-10 | _(missing)_ | Gap flagged by seventh-review |
| obs-11 | `test/obs-11-*.test.ts` | _(not yet assigned)_ |
| obs-12 | `test/obs-12-*.test.ts` | _(not yet assigned)_ |
| obs-13 | `test/obs-13-*.test.ts` | _(not yet assigned)_ |
| obs-14 | `test/obs-14-*.test.ts` | _(not yet assigned)_ |
| obs-15 | `test/obs-15-*.test.ts` | _(not yet assigned)_ |
| obs-16 | `test/obs-16-*.test.ts` | _(not yet assigned)_ |
| obs-17 | _(missing)_ | Gap flagged by seventh-review |
| obs-18 | `test/obs-18-*.test.ts` | _(not yet assigned)_ |
| obs-19 | `test/obs-19-*.test.ts` | _(not yet assigned)_ |
| obs-20 | _(missing)_ | Gap flagged by seventh-review |
| obs-21 | `test/obs-21-*.test.ts` | _(not yet assigned)_ |
| obs-22 | `test/obs-22-*.test.ts` | _(not yet assigned)_ |
| obs-23 | _(missing)_ | Gap flagged by seventh-review |

---

## sec- (Security)

| ID | File | Notes |
|---|---|---|
| sec-01 | `test/sec-01-*.test.ts` | _(not yet assigned)_ |
| sec-02 | `test/sec-02-*.test.ts` | _(not yet assigned)_ |
| sec-03 | `test/sec-03-*.test.ts` | _(not yet assigned)_ |
| sec-04 | _(missing)_ | Gap flagged by seventh-review |
| sec-05 | `test/sec-05-*.test.ts` | _(not yet assigned)_ |
| sec-06 | `test/sec-06-*.test.ts` | _(not yet assigned)_ |
| sec-07 | `test/sec-07-*.test.ts` | _(not yet assigned)_ |
| sec-08 | `test/sec-08-*.test.ts` | _(not yet assigned)_ |
| sec-09 | _(missing)_ | Gap flagged by seventh-review |
| sec-10 | _(missing)_ | Gap flagged by seventh-review |

---

## perf- (Performance)

| ID | File | Notes |
|---|---|---|
| perf-01 | Merged into `test/perf-02-rate-limiter-lru.test.ts` | SessionBroker LRU absorbed per memory record |
| perf-02 | `test/perf-02-rate-limiter-lru.test.ts` | Rate limiter LRU eviction |
| perf-03 | `test/perf-03-scheduler-history.test.ts` | Scheduler history |
| perf-04 | _(missing)_ | Gap flagged by seventh-review |
| perf-05 | _(missing)_ | Gap flagged by seventh-review |
| perf-06 | _(missing)_ | Gap flagged by seventh-review |
| perf-07 | `test/perf-07-interval-unref.test.ts` | `.unref?.()`  coverage for all setInterval sites (N7) |
| perf-08 | _(missing)_ | Gap flagged by seventh-review |
| perf-09 | _(missing)_ | Gap flagged by seventh-review |
| perf-10 | `test/perf-10-max-listeners.test.ts` | Max-listeners guard |
| perf-11 | _(missing)_ | Gap flagged by seventh-review |

---

*Last updated: 2026-05-03. Regenerate after adding new numbered test files.*
