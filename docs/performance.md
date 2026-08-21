# Performance and tuning

> **Surface scope:** This document covers performance tuning for the **full surface (Bun runtime)**. Code examples use `createGoodVibesSdk` from the full-surface entry point. Companion-surface consumers (React Native, browser) use surface-specific constructors. See [Published surface matrix](./surfaces.md) for the full breakdown.

This guide covers the tuning knobs, runtime contracts, and internal subsystems that govern SDK performance across provider calls, context management, component rendering, and tool execution.

## Provider optimization

### Retry strategy

The SDK uses deterministic exponential backoff (no jitter) for all retryable HTTP failures. The top-level `retry` config is an `HttpRetryPolicy` resolved by the transport-http retry layer (`resolveHttpRetryPolicy`) and applied via `computeBackoffDelay` in the HTTP transport loop; it is not handled by the `platform/utils` `withRetry` helper, which has a different config shape and is not wired to this config.

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    maxAttempts: 4,       // 1 initial attempt + 3 retries
    baseDelayMs: 250,     // starting delay before first retry
    maxDelayMs: 2_500,    // ceiling regardless of attempt count
  },
});
```

Delay for a one-based attempt `n` is: `min(baseDelayMs * backoffFactor^(attempt-1), maxDelayMs)`. So attempt 1 waits `baseDelayMs`, attempt 2 applies one backoff factor, and so on. `backoffFactor` defaults to `2` and is configurable. There is no jitter. When a server sends a `Retry-After` header on a retryable response, it raises the computed delay to at least that value, but the result is still capped at 10 minutes so a hostile or misconfigured server cannot park a client indefinitely.

Retries are only triggered for retryable errors. In the transport-http retry loop an error is retryable when:
- Its HTTP status is in `RETRYABLE_STATUS_CODES` (408, 429, 500, 502, 503, 504) and the request method is eligible for retry, meaning a safe method (`GET`, `HEAD`, or `OPTIONS`), or a mutation the contract marks `idempotent` or that has a `perMethodPolicy` entry; or
- It is a network-level failure (status `0`) surfaced as a `GoodVibesSdkError` with `recoverable: true` (the transport flags fetch/connection errors recoverable).

Never retry unsafe mutations blindly. Only idempotent reads and operations with application-level idempotency guarantees are safe to retry.

### Adaptive execution planner

The `AdaptivePlanner` selects an execution strategy each turn based on risk, latency budget, and task shape. It supports five strategies. `single` makes one LLM call with no parallelism. `cohort` fans out to a coordinated agent group. `background` defers the work to an async task. `remote` delegates to a remote provider or agent endpoint. `auto` is not itself a candidate; it tells the planner to score the other four and pick the highest.

Selection is a 0-100 score per strategy, not a hard gate, apart from three disqualifying conditions. `cohort` scores 0 unless `isMultiStep` is true, `background` scores 0 unless `backgroundEligible` is true, and `remote` scores 0 unless `remoteAvailable` is true. Within those bounds, risk acts as a strong penalty rather than a cutoff. `cohort` and `remote` still receive a small nonzero score above risk 0.7, so they can theoretically still win if every other candidate is disqualified, and `background` is penalized above risk 0.6. `single` always has a baseline score of 50 and gains bonuses when risk exceeds 0.7, the latency budget is under 5 seconds, or the task has no multi-step signal, which is why those conditions are the practical case where `single` wins.

| Strategy | Score shape |
|---|---|
| `single` | Baseline 50, +30 if risk > 0.7, +20 if latency budget < 5 s, +10 if not multi-step |
| `cohort` | 0 unless multi-step; ~5 if risk > 0.7; otherwise 70 + (1 − risk) × 20 |
| `background` | 0 unless `backgroundEligible`; ~10 if risk > 0.6; otherwise 60, +20 more if the latency budget is unconstrained |
| `remote` | 0 unless `remoteAvailable`; ~5 if risk > 0.7; otherwise 65 + (1 − risk) × 15 |

`background`'s latency-budget bonus is exactly that, a bonus. An unconstrained latency budget is not required for `background` to win; it only pushes the score higher when present.

```ts
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';

const planner = new AdaptivePlanner();

const decision = planner.select({
  riskScore: 0.3,         // 0 = safe, 1 = highly destructive
  latencyBudgetMs: Infinity,
  isMultiStep: true,
  remoteAvailable: false,
  backgroundEligible: false,
  taskDescription: 'Refactor auth module',
});

console.log(decision.selected);    // 'cohort'
console.log(decision.reasonCode);  // 'COHORT_CAPABLE'
```

The planner keeps a rolling audit log of the last 100 decisions (`MAX_HISTORY`). Use `planner.explain()` to see a human-readable breakdown of the most recent decision, or `planner.getHistory(limit = 20)` to retrieve the most recent decisions. The default `limit` is `20`. Pass a higher value (up to the 100-entry cap) to read further back.

User overrides take absolute precedence over automatic scoring:

```ts
planner.override('single');   // force single-agent execution
planner.clearOverride();      // return to automatic selection
```

### Circuit breaker

`ConsecutiveErrorBreaker` guards against runaway error loops. It tracks consecutive all-failed turns and returns graduated signals:

```ts
import { ConsecutiveErrorBreaker } from '@pellux/goodvibes-sdk/platform/core';

const breaker = new ConsecutiveErrorBreaker();

const result = breaker.recordAllFailed();
// 'ok'    - under warning threshold (< 5 consecutive)
// 'warn'  - approaching break threshold (>= 5)
// 'break' - at break threshold (>= 10)

breaker.recordSuccess(); // resets counter to 0
```

Default thresholds: warn at 5 consecutive failures, break at 10.

---

## Connection management

### SSE vs WebSocket

Choose based on runtime environment:

| Scenario | Recommendation |
|---|---|
| Bun service | SSE (`realtime.viaSse()`) |
| Browser dashboard | SSE (`realtime.viaSse()`) |
| React Native / Expo | WebSocket (`realtime.viaWebSocket()`) |
| Android / iOS native | WebSocket |

SSE is simpler (standard HTTP, firewall-friendly, works in all browser environments). WebSocket provides bidirectional communication and lower overhead for high-frequency event streams on mobile.

### SSE and WebSocket reconnect

Reconnect is **off by default** for both transports and is opted into via
`realtime.sseReconnect` / `realtime.webSocketReconnect`. The underlying HTTP
retry policy is also off by default (`maxAttempts: 1`). When reconnect is
enabled, both stream/SSE and WebSocket reconnect default to a finite
`maxAttempts` of `10` (`DEFAULT_STREAM_MAX_ATTEMPTS` / `DEFAULT_WS_MAX_ATTEMPTS`),
using exponential backoff with the same `baseDelayMs * backoffFactor^(attempt-1)`
formula as HTTP retry. On SSE reconnect the SDK sends `Last-Event-ID` so the server can replay
missed events when supported.

For the configuration shapes, per-surface examples, and the full default table,
see [Retries and reconnect](./retries-and-reconnect.md).

### SSE backpressure

The control-plane gateway's SSE `ReadableStream` is constructed with a bounded `CountQueuingStrategy` to prevent slow subscribers from consuming unbounded memory:

```ts
new ReadableStream(..., new CountQueuingStrategy({ highWaterMark: 256 }));
```

When a subscriber falls behind, the stream stops pulling new chunks from the producer rather than buffering indefinitely. Producers (the event bus) are not blocked. The back-pressure is isolated to the per-subscriber stream. A subscriber that stays behind long enough to drop events will surface as a `TRANSPORT_STALE` or disconnect event; reconnect with `Last-Event-ID` replays missed events where the server retains them.

Startup events (initial snapshot, recent-event replay) are delivered before the `highWaterMark` gate engages in practice, but high-volume workloads should still prefer domain-filtered subscriptions to reduce the event rate per subscriber.

### WebSocket outbound-queue backpressure

The control-plane strategy above governs the **server → client** SSE stream. The
transport-realtime WebSocket connector applies separate **client → server**
outbound backpressure. Messages enqueued while the socket is connecting or
reconnecting are held in a bounded, drop-oldest queue:

| Cap | Value |
|---|---|
| `MAX_OUTBOUND_QUEUE` | 1,024 messages |
| `MAX_OUTBOUND_QUEUE_BYTES` | 16 MiB total |
| `MAX_OUTBOUND_MESSAGE_BYTES` | 1 MiB per message |

A single message larger than 1 MiB is rejected rather than queued. On overflow
the oldest entry is dropped and the connector's `onBackpressure(info)` hook fires
with `{ droppedCount, queueLength, queueBytes, reason }`. To avoid flooding
callers during sustained disconnects, `onBackpressure` fires on the first overflow
and every tenth overflow thereafter; `droppedCount` is always the cumulative total.

### Token rotation on long-lived connections

For long-lived clients where tokens expire, use `tokenStore` or `getAuthToken` instead of a static `authToken`. Reconnects automatically pick up the latest token:

```ts
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3421',
  tokenStore: createMemoryTokenStore(), // refreshed externally via tokenStore.setToken()
});
```

---

## Token management

### Context window limits

The SDK tracks token usage continuously against the active model's context window. Key constants:

| Constant | Value | Purpose |
|---|---|---|
| `COMPACTION_BUFFER_TOKENS` | 15,000 | Safety buffer kept free below the window ceiling |
| `SMALL_WINDOW_THRESHOLD` | 12,000 | Models with windows ≤ this use simplified compaction |

Automatic compaction is controlled by `behavior.autoCompactThreshold`, a
percentage of the active context window. The default is `80`, meaning
compaction becomes eligible at 80% context usage. A remaining-token safety
buffer backstops the percentage threshold. `shouldAutoCompact` returns true
when the configured percentage is crossed **or** when remaining tokens fall
to or below the effective buffer.

The effective buffer is not a flat `COMPACTION_BUFFER_TOKENS` (15,000) on
every window. It is `min(COMPACTION_BUFFER_TOKENS, contextWindow × 0.125)`,
so a fixed 15,000-token buffer never reserves an outsized share of a small
or medium context window. On a 128k window the full 15,000-token buffer
applies (128k × 0.125 = 16k, above the 15k cap). On a 20k window the buffer
scales down to 2,500 tokens; without that scaling a flat 15,000-token buffer
would trip at roughly 25% usage and fire on nearly every request, even an
almost-empty conversation. The buffer still fires independently of the
percentage threshold, which matters when that threshold is set high or
disabled, since the buffer is the only backstop standing between usage and
the window edge in that case.

Preflight checks run before provider calls, including follow-up calls inside
tool loops. They use the same percentage/buffer decision so a turn can compact
before the next model request rather than waiting for post-turn maintenance
after the conversation has already exceeded the practical provider budget.

### Compaction strategies

Compaction collapses conversation history into a structured return-context document that preserves essential context while reducing token count.

**Automatic compaction** fires when token usage crosses the configured
percentage threshold or the safety buffer:

```ts
import {
  checkAndCompact,
  getAutoCompactDecision,
} from '@pellux/goodvibes-sdk/platform/core';

const decision = getAutoCompactDecision({
  currentTokens,
  contextWindow,
  isCompacting: false,
  thresholdPercent: 80,
});

const result = await checkAndCompact(
  {
    currentTokens,
    contextWindow,
    isCompacting: false,
    thresholdPercent: 80,
  },
  compactionContext,
  providerRegistry,
);

if (result) {
  // result.messages: new compacted message list
  // result.tokensBeforeEstimate / result.tokensAfterEstimate
  // result.event: CompactionEvent for telemetry
}
```

**Manual compaction** bypasses the threshold check:

```ts
import { compactMessages } from '@pellux/goodvibes-sdk/platform/core';

const result = await compactMessages(ctx, providerRegistry);
```

**Small-window compaction** handles models with tight context windows (≤ 12,000 token effective budget). It uses a simpler keep-recent strategy (`compactSmallWindow`) that retains the last N messages without an LLM extraction pass.

### Compaction section budgets

The compacted output is assembled from named sections, each with its own token budget:

| Section | Default Budget |
|---|---|
| Recent conversation | 3,000 tokens |
| Tool results | 1,500 tokens |
| Agent activity table | 1,500 tokens |
| Older agent summary | 500 tokens |
| Resolved problems | 300 tokens |
| **Total ceiling** | **6,500 tokens** |

`CompactionConfig` is an exported type with that shape, but structured compaction (`compactMessages` / `checkAndCompact`) always runs against `DEFAULT_COMPACTION_CONFIG` internally. `CompactionContext` has no `config` field, so there is currently no supported way to override these budgets per call; the type exists for the internal section builders, not as a public override surface.

### Token estimation

`estimateConversationTokens` scans the current message list and uses a 4-chars-per-token heuristic. It is fast and non-blocking, designed to be called every turn.

```ts
import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core';

const estimate = estimateConversationTokens(messages); // number
```

---

## Tool execution

### Performance budgets

The SDK defines two categories of performance budgets, **bundle size budgets** and **runtime SLO gates**.

**Bundle size budgets** are defined per entry point via `bundle-budgets.json` at
the repo root. Each entry has a gzip ceiling of `max(ceil(actual × 1.2), actual + 50 B)` (the `+50 B` floor dominates for tiny entries below ~250 B).
The CI `bundle-budget-check` job runs the same command used locally:

```bash
bun run bundle:check  # prints actual vs. budget for every entry point
```

To update after a legitimate size increase, see [Testing and Validation](./testing-and-validation.md#bundle-budget-enforcement).

**Runtime SLO gates** use consecutive-violation counting. A budget fails only when the threshold is exceeded on `tolerance` consecutive samples, which prevents transient spikes from failing the gate.

| Metric | Threshold | Tolerance |
|---|---|---|
| Frame render latency (p95) | 16 ms | 3 |
| Event queue depth | 1,000 events | 5 |
| **Tool executor overhead (p95)** | **5 ms** | 3 |
| Memory growth rate | 50 MiB/hr | 2 |
| Compaction latency (p95) | 500 ms | 3 |
| SLO: turn start, cancel, reconnect recovery, permission decision | see the SLO gates table below | 3 each |
| Integration delivery success rate | 95% (over a 100-delivery window) | 3 |
| Integration dead-letter queue depth | 10 entries | 3 |

Tool executor overhead measures scheduling, dispatch, and teardown phases only, not the tool's own execution time. The four end-to-end SLO gates and the two integration-delivery gates share this same default-budget list and consecutive-violation tolerance mechanism; the SLO gates are broken out separately below because `SloCollector` computes their p95 values from the runtime event stream rather than from a single measured duration per sample.

### SLO gates

Four end-to-end SLO latency gates are enforced at runtime via `SloCollector`:

| SLO | Target (p95) |
|---|---|
| Turn start (TURN_SUBMITTED → first STREAM_DELTA) | 2,000 ms |
| Cancel latency (TURN_CANCEL → confirmed stop) | 500 ms |
| Reconnect recovery (TRANSPORT_RECONNECTING → TRANSPORT_CONNECTED) | 10,000 ms |
| Permission decision (PERMISSION_REQUESTED → DECISION_EMITTED) | 100 ms |

SLO metrics are computed over a rolling window of 200 samples. Expired pending measurements are swept every 30 seconds to prevent stale correlation entries from distorting p95 values.

---

## State management

### Store domain selectors

The runtime store partitions state into typed domains. Use the provided selector functions to read domain state. Selectors avoid unnecessary recomputation and enforce the read model boundary.

```ts
import {
  selectSession,
  selectTelemetry,
  selectSystemHealth,
  selectRunningTasks,
  selectProviderHealth,
} from '@pellux/goodvibes-sdk/platform/runtime/state';

// Read a single domain
const session = selectSession(state);
const telemetry = selectTelemetry(state);

// Composite health across all health domains
const health = selectSystemHealth(state);
// health.status: 'healthy' | 'degraded' | 'failed'
// health.hasCritical: boolean
// health.hasDegraded: boolean
// health.domains: Record<HealthDomain, CompositeHealthStatus>
```

Health domains tracked by `selectSystemHealth`: `providerHealth`, `mcp`, `daemon`, `acp`, `integrations`.

### Read model pattern

Use read models for derived UI state rather than subscribing to raw domain state. Read models are pre-computed projections that compose multiple selectors and expose stable surface contracts:

```ts
import { createObservabilityReadModels } from '@pellux/goodvibes-sdk/platform/runtime/ui';

const models = createObservabilityReadModels(runtimeServices);
// Each property is a UiReadModel<TSnapshot>: { getSnapshot(), subscribe(listener) }.
// The object is flat, not grouped under system/security/remote/maintenance keys:
// models.health, models.intelligence, models.marketplace, models.cockpit: system-level status
// models.security, models.mcp, models.localAuth: security and permission state
// models.remote: transport and connection health
// models.settings, models.continuity, models.worktrees: compaction, sessions, maintenance state
```

---

## Resource monitoring

### ComponentHealthMonitor

The `ComponentHealthMonitor` enforces per-component resource contracts at render time. It is surface-agnostic, so a TUI panel, a web widget, or any other renderable unit can register.

**Registration and render gating:**

```ts
import { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/observability';

const monitor = new ComponentHealthMonitor();

// Register with a category, inherits category defaults
monitor.register('agent-logs', 'agent');

// Before rendering
if (!monitor.canRender('agent-logs')) return; // skip

// After rendering
monitor.recordRender('agent-logs', actualDurationMs);
```

### Resource contracts

Each category has a default contract. Components can override individual fields:

| Category | Max Updates/s | Max Render (p95) | Throttle Interval | Degrade After |
|---|---|---|---|---|
| `development` | 10 | 20 ms | 100 ms | 5 violations |
| `agent` | 5 | 30 ms | 200 ms | 5 violations |
| `ai` | 8 | 20 ms | 125 ms | 5 violations |
| `session` | 4 | 25 ms | 250 ms | 5 violations |
| `monitoring` | 2 | 50 ms | 500 ms | 3 violations |
| `default` | 5 | 30 ms | 200 ms | 5 violations |

Override contract fields for a specific component:

```ts
monitor.register('latency-graph', 'monitoring', {
  maxUpdatesPerSecond: 4,
  maxRenderMs: 40,
});
```

### Throttle and degrade lifecycle

Components progress through three health states based on contract compliance:

```
normal → throttled (rate or render cost exceeded)
throttled → degraded (consecutiveViolations >= degradeAfterViolations)
throttled → normal (3 consecutive clean windows)
degraded → normal (3 consecutive clean windows)
```

When `throttled`, `canRender` returns false until `throttleIntervalMs` has elapsed. When `degraded`, the component renders at `degradedIntervalMs` regardless of update rate. Recovery to `normal` requires 3 consecutive measurement windows without violations, and applies the same way whether the component was throttled or degraded; a throttled component does not have to pass through degraded to recover.

```ts
const health = monitor.getHealth('agent-logs');
// health.throttleStatus: 'normal' | 'throttled' | 'degraded'
// health.healthStatus: 'healthy' | 'warning' | 'overloaded'
// health.renderP95Ms: number
// health.consecutiveViolations: number
// health.totalSuppressed: number
// health.totalPermitted: number

// Force reset (operator intervention or tests)
monitor.resetHealth('agent-logs');
```

---

## Batch patterns

### Event feed subscription

Subscribe to multiple event types within a domain in a single feed to avoid per-event subscription overhead:

```ts
const feed = sdk.realtime.viaSse();

// Subscribe per event type, all share the same underlying connection
const stopTurns = feed.turn.on('TURN_COMPLETED', (ev) => { /* ... */ });
const stopAgents = feed.agents.on('AGENT_COMPLETED', (ev) => { /* ... */ });
const stopTools = feed.tools.on('TOOL_SUCCEEDED', (ev) => { /* ... */ });

// Each on() returns an unsubscribe function
// Cleanup:
stopTurns();
stopAgents();
stopTools();
```

Filter to only the domains you need using the SSE `domains` query parameter to reduce server-side fan-out:

```
GET /api/control-plane/events?domains=turn,agents,tools
```

### Parallel tool execution

Configure `cohort` strategy via the adaptive planner to fan tasks out across agent cohorts. The planner automatically selects `cohort` for multi-step tasks with risk score ≤ 0.7:

```ts
const decision = planner.select({
  riskScore: 0.2,
  latencyBudgetMs: 30_000,
  isMultiStep: true,
  remoteAvailable: false,
  backgroundEligible: false,
});
// decision.selected === 'cohort'
```

### Background execution

Defer latency-insensitive work to background execution to avoid blocking the conversation loop:

```ts
const decision = planner.select({
  riskScore: 0.1,
  latencyBudgetMs: Infinity,
  isMultiStep: false,
  remoteAvailable: false,
  backgroundEligible: true,
});
// decision.selected === 'background'
```

---

## Next reads

- [Retries and reconnect](./retries-and-reconnect.md)
- [Observability](./observability.md)
- [Error handling](./error-handling.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Runtime events reference](./reference-runtime-events.md)
