# Performance and Tuning

> **Surface scope:** This document covers performance tuning for the **full surface (Bun runtime)**. Code examples use `createGoodVibesSdk` from the full-surface entry point. Companion-surface consumers (React Native, browser) use surface-specific constructors — see [Runtime Surfaces](./surfaces.md) for the full breakdown.

This guide covers the tuning knobs, runtime contracts, and internal subsystems that govern SDK performance across provider calls, context management, component rendering, and tool execution.

## Provider Optimization

### Retry Strategy

The SDK uses exponential backoff with jitter for all retryable HTTP failures. The `withRetry` utility is the underlying primitive; runtime-specific entrypoints expose it through the top-level `retry` config.

```ts
import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
  retry: {
    maxAttempts: 4,       // 1 initial attempt + 3 retries
    baseDelayMs: 250,     // starting delay before first retry
    maxDelayMs: 2_500,    // ceiling regardless of attempt count
  },
});
```

Delay for attempt `n` is: `min(baseDelay * 2^n + jitter, maxDelay)`. Jitter is uniform random up to `baseDelayMs` and prevents thundering-herd on shared infrastructure.

Retries are only triggered for retryable errors. An error is retryable when:
- It is an `AppError` with `recoverable: true`, or
- Its HTTP status code is in `RETRYABLE_STATUS_CODES` (typically 429, 500, 502, 503, 504).

Never retry unsafe mutations blindly. Only idempotent reads and operations with application-level idempotency guarantees are safe to retry.

### Adaptive Execution Planner

The `AdaptivePlanner` selects an execution strategy each turn based on risk, latency budget, and task shape. It supports five strategies:

| Strategy | When Selected |
|---|---|
| `single` | Risk > 0.7, latency budget < 5 s, or no multi-step signal |
| `cohort` | Multi-step task, risk ≤ 0.7 — fan-out to coordinated agents |
| `background` | `backgroundEligible` true, no latency constraint, risk ≤ 0.6 |
| `remote` | Remote endpoint available, risk ≤ 0.7 |
| `auto` | Planner evaluates all strategies and picks the highest scorer |

```ts
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';

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

The planner keeps a rolling audit log of the last 100 decisions. Use `planner.explain()` to see a human-readable breakdown of the most recent decision, or `planner.getHistory()` to retrieve the full log.

User overrides take absolute precedence over automatic scoring:

```ts
planner.override('single');   // force single-agent execution
planner.clearOverride();      // return to automatic selection
```

### Circuit Breaker

`ConsecutiveErrorBreaker` guards against runaway error loops. It tracks consecutive all-failed turns and returns graduated signals:

```ts
import { ConsecutiveErrorBreaker } from '@pellux/goodvibes-sdk/platform/core/circuit-breaker';

const breaker = new ConsecutiveErrorBreaker();

const result = breaker.recordAllFailed();
// 'ok'    — under warning threshold (< 5 consecutive)
// 'warn'  — approaching break threshold (>= 5)
// 'break' — at break threshold (>= 10)

breaker.recordSuccess(); // resets counter to 0
```

Default thresholds: warn at 5 consecutive failures, break at 10.

---

## Connection Management

### SSE vs WebSocket

Choose based on runtime environment:

| Scenario | Recommendation |
|---|---|
| Node/Bun service | SSE (`realtime.viaSse()`) |
| Browser dashboard | SSE (`realtime.viaSse()`) |
| React Native / Expo | WebSocket (`realtime.viaWebSocket()`) |
| Android / iOS native | WebSocket |

SSE is simpler (standard HTTP, firewall-friendly, works in all browser environments). WebSocket provides bidirectional communication and lower overhead for high-frequency event streams on mobile.

### SSE Reconnect

```ts
const sdk = createBrowserGoodVibesSdk({
  realtime: {
    sseReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

On reconnect the SDK sends `Last-Event-ID` so the server can replay missed events when supported. The reconnect delay uses exponential backoff with the same `baseDelayMs * 2^n` formula as HTTP retry.

### WebSocket Reconnect

```ts
const sdk = createReactNativeGoodVibesSdk({
  baseUrl: 'https://goodvibes.example.com',
  authToken: token,
  realtime: {
    webSocketReconnect: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

### Token Rotation on Long-Lived Connections

For long-lived clients where tokens expire, use `tokenStore` or `getAuthToken` instead of a static `authToken`. Reconnects automatically pick up the latest token:

```ts
import { createMemoryTokenStore } from '@pellux/goodvibes-sdk/auth';

const sdk = createGoodVibesSdk({
  baseUrl: 'http://127.0.0.1:3210',
  tokenStore: createMemoryTokenStore(), // refreshed externally via tokenStore.set()
});
```

---

## Token Management

### Context Window Limits

The SDK tracks token usage continuously against the active model's context window. Key constants:

| Constant | Value | Purpose |
|---|---|---|
| `COMPACTION_BUFFER_TOKENS` | 15,000 | Safety buffer kept free below the window ceiling |
| `SMALL_WINDOW_THRESHOLD` | 12,000 | Models with windows ≤ this use simplified compaction |

`shouldAutoCompact` returns true when `currentTokens >= contextWindow - COMPACTION_BUFFER_TOKENS`.

### Compaction Strategies

Compaction collapses the conversation history into a structured handoff document that preserves essential context while drastically reducing token count.

**Automatic compaction** fires when token usage crosses the buffer threshold:

```ts
import { checkAndCompact } from '@pellux/goodvibes-sdk/platform/core/context-compaction';

const result = await checkAndCompact(
  { currentTokens, contextWindow, isCompacting: false },
  compactionContext,
  providerRegistry,
);

if (result) {
  // result.messages — new compacted message list
  // result.tokensBeforeEstimate / result.tokensAfterEstimate
  // result.event — CompactionEvent for telemetry
}
```

**Manual compaction** bypasses the threshold check:

```ts
import { compactMessages } from '@pellux/goodvibes-sdk/platform/core/context-compaction';

const result = await compactMessages(ctx, providerRegistry);
```

**Small-window compaction** handles models with tight context windows (≤ 12,000 token effective budget). It uses a simpler keep-recent strategy (`compactSmallWindow`) that retains the last N messages without an LLM extraction pass.

### Compaction Section Budgets

The compacted output is assembled from named sections, each with its own token budget:

| Section | Default Budget |
|---|---|
| Recent conversation | 3,000 tokens |
| Tool results | 1,500 tokens |
| Agent activity table | 1,500 tokens |
| Older agent summary | 500 tokens |
| Resolved problems | 300 tokens |
| **Total ceiling** | **6,500 tokens** |

Override the defaults via `CompactionConfig`:

```ts
const ctx: CompactionContext = {
  // ...
  config: {
    recentConversationBudget: 4_000,
    toolResultsBudget: 2_000,
    agentActivityBudget: 1_000,
    olderAgentSummaryBudget: 500,
    resolvedProblemsBudget: 300,
    totalCeiling: 8_000,
  },
};
```

### Token Estimation

`estimateConversationTokens` scans the current message list and uses a 4-chars-per-token heuristic. It is fast and non-blocking, designed to be called every turn.

```ts
import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core/context-compaction';

const estimate = estimateConversationTokens(messages); // number
```

---

## Tool Execution

### Performance Budgets

The SDK defines two categories of performance budgets: **bundle size budgets** and **runtime SLO gates**.

**Bundle size budgets** are enforced per entry point via `bundle-budgets.json` at the repo root. Each entry has a gzip ceiling (measured actual × 1.2 headroom). CI fails when an entry grows beyond its ceiling:

```bash
bun run bundle:check  # prints actual vs. budget for every entry point
```

To update after a legitimate size increase, see [Testing and Validation](./testing-and-validation.md#bundle-budget-enforcement).

**Runtime SLO gates** use consecutive-violation counting: a budget fails only when the threshold is exceeded on `tolerance` consecutive samples, preventing transient spikes from failing the gate.

| Metric | Threshold | Tolerance |
|---|---|---|
| Frame render latency (p95) | 16 ms | 3 |
| Event queue depth | 1,000 events | 5 |
| **Tool executor overhead (p95)** | **5 ms** | 3 |
| Memory growth rate | 50 MiB/hr | 2 |
| Compaction latency (p95) | 500 ms | 3 |

Tool executor overhead measures scheduling, dispatch, and teardown phases only — not the tool's own execution time.

### SLO Gates

Four end-to-end SLO latency gates are enforced at runtime via `SloCollector`:

| SLO | Target (p95) |
|---|---|
| Turn start (TURN_SUBMITTED → first STREAM_DELTA) | 2,000 ms |
| Cancel latency (TURN_CANCEL → confirmed stop) | 500 ms |
| Reconnect recovery (TRANSPORT_RECONNECTING → TRANSPORT_CONNECTED) | 10,000 ms |
| Permission decision (PERMISSION_REQUESTED → DECISION_EMITTED) | 100 ms |

SLO metrics are computed over a rolling window of 200 samples. Expired pending measurements are swept every 30 seconds to prevent stale correlation entries from distorting p95 values.

---

## State Management

### Store Domain Selectors

The runtime store partitions state into typed domains. Use the provided selector functions to read domain state — selectors avoid unnecessary recomputation and enforce the read model boundary.

```ts
import {
  selectSession,
  selectTelemetry,
  selectSystemHealth,
  selectRunningTasks,
  selectProviderHealth,
} from '@pellux/goodvibes-sdk/platform/runtime/store/selectors';

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

### Read Model Pattern

Use read models for derived UI state rather than subscribing to raw domain state. Read models are pre-computed projections that compose multiple selectors and expose stable surface contracts:

```ts
import { createObservabilityReadModels } from '@pellux/goodvibes-sdk/platform/runtime';

const models = createObservabilityReadModels(runtimeServices);
// models.system   — system-level health and status
// models.security — security and permission state
// models.remote   — transport and connection health
// models.maintenance — compaction, sessions, maintenance state
```

---

## Resource Monitoring

### ComponentHealthMonitor

The `ComponentHealthMonitor` enforces per-component resource contracts at render time. It is surface-agnostic: TUI panels, web widgets, and any renderable unit can register.

**Registration and render gating:**

```ts
import { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor';

const monitor = new ComponentHealthMonitor();

// Register with a category — inherits category defaults
monitor.register('agent-logs', 'agent');

// Before rendering
if (!monitor.canRender('agent-logs')) return; // skip

// After rendering
monitor.recordRender('agent-logs', actualDurationMs);
```

### Resource Contracts

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

### Throttle and Degrade Lifecycle

Components progress through three health states based on contract compliance:

```
normal → throttled (rate or render cost exceeded)
throttled → degraded (consecutiveViolations >= degradeAfterViolations)
degraded → normal (3 consecutive clean windows)
```

When `throttled`, `canRender` returns false until `throttleIntervalMs` has elapsed. When `degraded`, the component renders at `degradedIntervalMs` regardless of update rate. Recovery requires 3 consecutive measurement windows without violations.

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

## Batch Patterns

### Event Feed Subscription

Subscribe to multiple event types within a domain in a single feed to avoid per-event subscription overhead:

```ts
const feed = sdk.realtime.viaSse();

// Subscribe per event type — all share the same underlying connection
const stopTurns = feed.turn.on('TURN_COMPLETED', (ev) => { /* ... */ });
const stopAgents = feed.agents.on('AGENT_COMPLETED', (ev) => { /* ... */ });
const stopTools = feed.tools.on('TOOL_RESULT', (ev) => { /* ... */ });

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

### Parallel Tool Execution

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

### Background Execution

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

## Related

- [Retries and reconnect](./retries-and-reconnect.md)
- [Observability](./observability.md)
- [Error handling](./error-handling.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Runtime events reference](./reference-runtime-events.md)
