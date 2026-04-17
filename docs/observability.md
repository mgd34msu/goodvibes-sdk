# Observability

This guide covers the SDK's observability stack: structured logging, runtime event feeds, session telemetry, health monitoring, failure forensics, and diagnostic panels.

## Logging

### ActivityLogger

The SDK ships a persistent, buffered activity logger that writes structured entries to `.goodvibes/logs/activity.md`. It is the primary debug trail for production diagnosis.

```ts
import { configureActivityLogger } from '@pellux/goodvibes-sdk/platform/utils/logger';

// Call once at startup with the log directory path
configureActivityLogger('/home/user/.goodvibes/logs');
```

The logger is a singleton (`logger`) used throughout the platform. It exposes four levels:

```ts
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';

logger.info('session started', { sessionId });
logger.warn('retry triggered', { attempt, delayMs });
logger.error('provider call failed', { error: err.message });
logger.debug('[AdaptivePlanner] auto-selected', { strategy, score });
```

Each call produces a structured Markdown entry:

```
[2026-04-15T10:23:01.042Z] [INFO] session started
```json
{
  "sessionId": "sess_abc123"
}
```
```

### Write Behavior

Log entries are buffered in memory and written asynchronously to avoid blocking the event loop:

- Entries flush automatically after **100 ms** (configurable via `LOG_FLUSH_INTERVAL_MS`).
- Buffer flushes immediately when it reaches **10 entries** (`LOG_BUFFER_MAX`).
- If `configure()` has not been called, entries are buffered until a log directory is set.

The logger is best-effort: filesystem errors are reported to `stderr` but do not propagate to the caller. Never put secrets or PII in log data.

---

## Runtime Events

### Event Architecture

All runtime state changes are communicated through typed events wrapped in an `EventEnvelope`. The envelope carries trace context, enabling end-to-end correlation across turns, tasks, and agents:

```ts
interface EventEnvelope<TType, TPayload> {
  type: TType;         // event type string
  ts: number;          // epoch ms
  traceId: string;     // UUID, auto-generated if not supplied
  sessionId: string;
  turnId?: string;
  agentId?: string;
  taskId?: string;
  source: string;      // emitting subsystem
  payload: TPayload;
}
```

Create an envelope with automatic trace ID generation:

```ts
import { createEventEnvelope } from '@pellux/goodvibes-sdk/transport-core';

const envelope = createEventEnvelope(
  'TURN_SUBMITTED',
  { turnId: 'turn_xyz', prompt: 'Hello' },
  { sessionId: 'sess_abc', source: 'orchestrator' },
);
```

### Event Domains

Events are partitioned into named domains. Subscribe only to the domains relevant to your use case to reduce transport overhead.

Available runtime domains:

| Domain | Events |
|---|---|
| `agents` | Agent lifecycle: spawn, complete, fail |
| `automation` | Automation job state |
| `compaction` | Context compaction start/complete |
| `control-plane` | Session and control events |
| `deliveries` | Outbound delivery tracking |
| `forensics` | Failure report generated |
| `knowledge` | Knowledge base updates |
| `mcp` | MCP tool call lifecycle |
| `ops` | Operator ops plane |
| `orchestration` | Orchestration plan changes |
| `permissions` | Permission requests and decisions |
| `planner` | AdaptivePlanner decisions |
| `plugins` | Plugin state changes |
| `providers` | Provider health transitions |
| `routes` | Route registration changes |
| `security` | Security policy events |
| `session` | Session lifecycle |
| `surfaces` | UI surface events |
| `tasks` | Task lifecycle |
| `tools` | Tool call dispatch and results |
| `transport` | Connection state (connect, reconnect, disconnect) |
| `turn` | Turn lifecycle (submitted, streaming, completed, cancelled) |
| `ui` | UI interaction events |
| `watchers` | File/resource watcher state |
| `workflows` | Workflow step transitions |

### Subscribing via SSE

```ts
const stop = sdk.realtime.viaSse().turn.on('TURN_COMPLETED', (event) => {
  console.log('turn completed', event.turnId, event.stopReason);
});

// Unsubscribe
stop();
```

Filter to specific domains to reduce server-side event fan-out:

```
GET /api/control-plane/events?domains=turn,tools,forensics
```

### Subscribing via WebSocket

```ts
const stop = sdk.realtime.viaWebSocket().agents.on('AGENT_COMPLETED', (event) => {
  console.log('agent done', event.agentId);
});
```

### Envelope-Level Subscription

Use `onEnvelope` instead of `on` to access the full trace context:

```ts
feed.turn.onEnvelope('TURN_COMPLETED', (envelope) => {
  console.log(envelope.traceId, envelope.ts, envelope.payload);
});
```

### RuntimeEventFeed API

```ts
interface RuntimeEventFeed<TEvent> {
  // Subscribe to payload only
  on(type, listener): () => void;
  // Subscribe to full envelope (includes traceId, sessionId, etc.)
  onEnvelope(type, listener): () => void;
}

interface RuntimeEventFeeds<TDomain, TEvent> {
  domains: readonly TDomain[];
  domain(domain: TDomain): RuntimeEventFeed<TEvent>;
  // Direct domain access: feeds.turn, feeds.agents, etc.
}
```

---

## Telemetry

### Session Telemetry State

The `telemetry` store domain accumulates session-level metrics, correlation IDs, and a recent-event ring buffer. Access it via the selector:

```ts
import { selectTelemetry } from '@pellux/goodvibes-sdk/platform/runtime/store/selectors';

const telemetry = selectTelemetry(state);

// Session-level aggregates
console.log(telemetry.sessionMetrics);
// {
//   turns: 12,
//   toolCalls: 47,
//   toolErrors: 2,
//   agentsSpawned: 5,
//   inputTokens: 38420,
//   outputTokens: 12300,
//   cacheReadTokens: 8000,
//   permissionPrompts: 6,
//   permissionDenials: 1,
//   errors: 3,
//   warnings: 8,
// }
```

### Correlation IDs

Two correlation IDs are tracked:

- `sessionCorrelationId` — set at session start, never changes. Use it to correlate all events from a session.
- `currentTurnCorrelationId` — changes each turn. Use it to correlate events within a single turn.

```ts
const { sessionCorrelationId, currentTurnCorrelationId } = telemetry;
```

### OTel Integration

When OpenTelemetry is active, `traceContext` is populated with OTel-compatible IDs:

```ts
const { traceContext } = telemetry;
if (traceContext?.exportActive) {
  console.log(traceContext.traceId);    // 128-bit hex
  console.log(traceContext.rootSpanId); // 64-bit hex
  console.log(traceContext.endpoint);   // OTel collector URL
}
```

### Telemetry Event Buffer

The `recentEvents` ring buffer holds the last 500 `TelemetryEventRecord` entries by default. Each record carries:

```ts
interface TelemetryEventRecord {
  eventType: string;
  correlationId: string;
  source: string;        // emitting subsystem
  timestamp: number;     // epoch ms
  meta?: Record<string, unknown>;
}
```

### Tool Call Telemetry

Tool calls are tracked individually through the `tools` event domain. Subscribe to `tools` events to build per-tool latency histograms or error-rate dashboards.

### Token Usage Tracking

Input and output token counts accumulate in `sessionMetrics.inputTokens` and `sessionMetrics.outputTokens`. `cacheReadTokens` tracks cache hits to quantify cost savings from prompt caching.

---

## Health Monitoring

### ComponentHealthMonitor

See [Performance and Tuning — Resource Monitoring](./performance.md#resource-monitoring) for full usage. Summary:

- Register components with `monitor.register(id, category)`
- Gate renders with `monitor.canRender(id)` — returns false when throttled or degraded
- Report render cost with `monitor.recordRender(id, durationMs)`
- Read health state with `monitor.getHealth(id)` or `monitor.getAllHealth()`

Health states: `healthy` → `warning` (throttled) → `overloaded` (degraded).

### System Health Selectors

```ts
import {
  selectSystemHealth,
  selectDomainHealth,
  selectProviderHealth,
} from '@pellux/goodvibes-sdk/platform/runtime/store/selectors';

// Aggregate across all health domains
const systemHealth = selectSystemHealth(state);
// {
//   status: 'healthy' | 'degraded' | 'failed',
//   hasCritical: boolean,
//   hasDegraded: boolean,
//   domains: {
//     providerHealth: 'healthy',
//     mcp: 'healthy',
//     daemon: 'healthy',
//     acp: 'healthy',
//     integrations: 'degraded',
//   }
// }

// Single domain
const providerStatus = selectDomainHealth(state, 'providerHealth');
```

### HealthPanel

`HealthPanel` bridges `RuntimeHealthAggregator` into a subscribe/snapshot model for the health diagnostics panel. It includes SLO status rows and remediation action suggestions when optional dependencies are attached:

```ts
const panel = new HealthPanel(
  aggregator,
  sloCollector,   // optional: adds SLO rows to the dashboard
  cascadeTimer,   // optional: adds remediation playbook suggestions
);

const snapshot = panel.getSnapshot();
// snapshot.overall: HealthStatus
// snapshot.domains: DomainHealthSummary[]
// snapshot.sloRows: SloRow[]  (empty if sloCollector not attached)
// snapshot.remediationActions: RemediationAction[]

const unsub = panel.subscribe(() => {
  const updated = panel.getSnapshot();
});
unsub(); // release subscription
panel.dispose();
```

Domain rows are sorted: failed first, then degraded, then healthy, then unknown.

### SLO Collector

`SloCollector` measures four end-to-end SLO metrics from the runtime event stream:

| SLO Metric | Key |
|---|---|
| Turn start latency | `slo.turn_start.p95` |
| Cancel latency | `slo.cancel.p95` |
| Reconnect recovery | `slo.reconnect_recovery.p95` |
| Permission decision | `slo.permission_decision.p95` |

Metrics are computed as p95 over a rolling 200-sample window.

```ts
const collector = new SloCollector(eventBus);

const metrics = collector.getMetrics();
// metrics[0].name === 'slo.turn_start.p95'
// metrics[0].value === 1450  // ms
// metrics[0].unit === 'ms'

const counts = collector.getSampleCounts();
// counts['slo.turn_start.p95'] === 47

collector.dispose();
```

SLO status classification for dashboard rows:
- `ok` — p95 within target
- `warn` — p95 > target / 1.2 (within 20% of target)
- `violated` — p95 > target
- `no_data` — no samples collected yet

---

## Failure Forensics

The forensics subsystem automatically generates structured failure reports whenever a turn or task reaches a terminal failure state. Reports capture the full causal chain without requiring manual log correlation.

### Failure Classification

The `ForensicsClassifier` maps event context to a `FailureClass` using priority-ordered heuristics:

| Class | Triggered By |
|---|---|
| `cancelled` | Explicit operator cancellation |
| `max_tokens` | Stop reason: `max_tokens`, `length`, `context_overflow` |
| `compaction_error` | Compaction failure recorded |
| `permission_denied` | Permission denial or `hook_denied` stop reason |
| `tool_failure` | Tool execution failure or `tool_loop_circuit_breaker` |
| `cascade_failure` | Health cascade events present |
| `turn_timeout` | Error message contains `timeout` / `timed out` |
| `llm_error` | API errors, rate limits, network failures, 5xx responses |
| `unknown` | No pattern matched |

### FailureReport Structure

```ts
interface FailureReport {
  id: string;                        // short hex ID
  traceId: string;                   // full trace ID
  sessionId: string;
  generatedAt: number;               // epoch ms
  classification: FailureClass;
  summary: string;                   // human-readable headline
  stopReason?: string;               // LLM stop reason if applicable
  errorMessage?: string;             // terminal error
  taskId?: string;
  turnId?: string;
  agentId?: string;
  phaseTimings: PhaseTimingEntry[];  // PREFLIGHT, STREAM, TOOL_BATCH, POST_HOOKS, ...
  phaseLedger: PhaseLedgerEntry[];   // explicit phase transition log
  causalChain: CausalChainEntry[];   // root cause first
  cascadeEvents: CausalChainEntry[];
  permissionEvidence: PermissionEvidenceEntry[];
  budgetBreaches: BudgetBreachEvidence[];
  jumpLinks: ForensicsJumpLink[];    // navigable panel/command references
}
```

### ForensicsRegistry

`ForensicsRegistry` stores and indexes failure reports. It holds at most 100 reports by default (configurable). Oldest reports are evicted when the limit is reached.

```ts
import { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/registry';

const registry = new ForensicsRegistry(200); // custom limit

registry.push(report);

const latest = registry.latest();
const all = registry.getAll();       // newest first
const byId = registry.getById(id);
const count = registry.count();

const unsub = registry.subscribe(() => {
  // fired on every push
});
```

### Exporting Reports

Export a single report as JSON:

```ts
const json = registry.exportAsJson(id); // string | undefined
```

Export a full bundle with evidence summary and replay evidence:

```ts
const bundle: ForensicsBundle = registry.buildBundle(id, {
  replaySnapshot: currentReplayState,
});
// bundle.schemaVersion === 'v1'
// bundle.report — the FailureReport
// bundle.evidence — ForensicsEvidenceSummary (counts, slow phases, related IDs)
// bundle.replay — ForensicsReplayEvidence (mismatches, turn summaries)

const bundleJson = registry.exportBundleAsJson(id);
```

### Causal Chain Analysis

Each `CausalChainEntry` in `report.causalChain` traces one step from root cause to terminal state:

```ts
for (const link of report.causalChain) {
  console.log(
    link.seq,
    link.ts,
    link.description,
    link.sourceEventType,
    link.isRootCause,   // true for the first diagnosed root cause
    link.context,       // tool name, error code, domain, etc.
  );
}
```

### Jump Links

Reports include navigable `jumpLinks` that host surfaces render as actionable targets:

```ts
for (const link of report.jumpLinks) {
  // link.kind: 'panel' | 'command'
  // link.target: panel ID or slash command (without leading slash)
  // link.label: 'Replay turn', 'Open health dashboard', etc.
  // link.args: optional pre-selection arguments
}
```

### ForensicsDataPanel

`ForensicsDataPanel` bridges `ForensicsRegistry` into the diagnostics panel subscription model:

```ts
import { ForensicsDataPanel } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/panels/forensics';

const panel = new ForensicsDataPanel(registry);

const all = panel.getAll();               // capped at bufferLimit
const latest = panel.latest();            // most recent report
const report = panel.getById(id);

const unsub = panel.subscribe(() => {
  const reports = panel.getAll();
});
panel.dispose();
```

---

## Diagnostics

### Available Panels

The diagnostics subsystem provides data providers for the following built-in panels:

| Panel | Provider Class | Data |
|---|---|---|
| Health | `HealthPanel` | Domain health, SLO rows, remediation actions |
| Forensics | `ForensicsDataPanel` | Failure reports with causal chains |
| Agents | `AgentsPanel` | Agent lifecycle and state |
| Events | `EventsPanel` | Recent event stream |
| Tool calls | `ToolCallsPanel` | Tool dispatch history |
| Ops | `OpsPanel` | Operations-plane state |
| Tasks | `TasksPanel` | Task queue and status |
| State inspector | `StateInspectorPanel` | Raw domain state |
| Security | `SecurityPanel` | Permission policy state |
| Transport | `TransportPanel` | Connection health |
| Replay | `ReplayPanel` | Deterministic replay state |
| Divergence | `DivergencePanel` | Replay divergence tracking |

All panel providers follow the same pattern: construct with data sources, call `getSnapshot()` / `getAll()` for the current view, subscribe for change notifications, and call `dispose()` to release.

### Provider Health Panel

Provider health is tracked in the `providerHealth` store domain. Read it via selector:

```ts
import { selectProviderHealth } from '@pellux/goodvibes-sdk/platform/runtime/store/selectors';

const ph = selectProviderHealth(state);
// ph.status: provider health status
// ph.providers: per-provider health records
```

### Accessing Diagnostics

```ts
import { createDiagnosticsProvider } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics';

const diag = createDiagnosticsProvider(runtimeServices);

// Access individual panels
const health = diag.health.getSnapshot();
const forensics = diag.forensics.getAll();
```

---

## SDKObserver — Pluggable Telemetry Hooks

The `SDKObserver` interface lets you attach custom telemetry without reaching into `_internal/`. All methods are optional; the SDK works identically whether an observer is provided or not.

### Interface

```ts
import type { SDKObserver } from '@pellux/goodvibes-sdk';

export interface SDKObserver {
  /** Called for every event dispatched through the RuntimeEventBus. */
  onEvent?(event: AnyRuntimeEvent): void;

  /** Called when the SDK catches and is about to rethrow a GoodVibesSdkError. */
  onError?(err: GoodVibesSdkError): void;

  /** Called at HTTP/SSE/WS transport boundaries. */
  onTransportActivity?(activity: {
    readonly direction: 'send' | 'recv';
    readonly url: string;
    readonly status?: number;
    readonly durationMs?: number;
    readonly kind?: 'http' | 'sse' | 'ws';
  }): void;

  /** Called when auth state transitions (login, logout, refresh, expire, revoke). */
  onAuthTransition?(transition: {
    readonly from: 'anonymous' | 'session' | 'token';
    readonly to: 'anonymous' | 'session' | 'token';
    readonly reason: 'login' | 'logout' | 'refresh' | 'expire' | 'revoke';
  }): void;
}
```

### Registering an observer

Pass an observer as the fourth argument to `createGoodVibesAuthClient`:

```ts
import {
  createGoodVibesAuthClient,
  createMemoryTokenStore,
  createConsoleObserver,
} from '@pellux/goodvibes-sdk';

const auth = createGoodVibesAuthClient(
  operatorSdk,
  createMemoryTokenStore(),
  undefined, // getAuthToken resolver
  createConsoleObserver({ level: 'debug' }),
);
```

### Error swallowing guarantee

Every observer call site is wrapped in:

```ts
try {
  observer.onX?.(...);
} catch {
  // Observer errors must not propagate into SDK logic.
  // Observers are passive listeners; they have no authority to break flows.
}
```

An observer that throws will never disrupt the SDK. This is the hard correctness invariant for the observer contract.

### Console adapter

`createConsoleObserver` is the built-in development adapter. It logs auth transitions and errors at `info` level, and transport activity + runtime events at `debug` level.

```ts
import { createConsoleObserver } from '@pellux/goodvibes-sdk';

const observer = createConsoleObserver({ level: 'debug' });
```

Output example:
```
[sdk:observer] auth transition anonymous → token (login)
[sdk:observer] transport recv http https://daemon.example.com/api/control-plane/auth/login status=200 142ms
```

### OpenTelemetry adapter

`createOpenTelemetryObserver` accepts a pre-configured OTel `Tracer` and `Meter`. There is no hard dependency on `@opentelemetry/*` — the adapter accepts structurally-compatible interfaces so consumers bring their own.

```ts
import { trace, metrics } from '@opentelemetry/api';
import { createOpenTelemetryObserver } from '@pellux/goodvibes-sdk';

const observer = createOpenTelemetryObserver(
  trace.getTracer('goodvibes-sdk'),
  metrics.getMeter('goodvibes-sdk'),
);
```

Metrics emitted:

| Metric | Type | Description |
|---|---|---|
| `sdk.auth.transitions` | Counter | Auth state transitions, tagged with `from`, `to`, `reason` |
| `sdk.errors` | Counter | SDK errors, tagged with `kind` and `category` |
| `sdk.transport.duration_ms` | Histogram | HTTP transport call duration (recv only), tagged with `kind` and `status` |

Spans emitted:

| Span | When |
|---|---|
| `sdk.auth.transition` | On each auth state transition |
| `sdk.error` | On each `GoodVibesSdkError` |

### Wire-up status (S-θ)

| Seam | Status |
|---|---|
| `createGoodVibesAuthClient` — `onAuthTransition` on login | Wired |
| `createGoodVibesAuthClient` — `onAuthTransition` on logout (clearToken) | Wired |
| `RuntimeEventBus.emit` — `onEvent` | Deferred to S-θ.2 |
| `OperatorSdk` / `PeerSdk` transport — `onTransportActivity` | Deferred to S-θ.2 |
| Error rethrow sites — `onError` | Deferred to S-θ.2 |

---

## Related

- [Performance and Tuning](./performance.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Runtime events reference](./reference-runtime-events.md)
- [Error handling](./error-handling.md)
- [Troubleshooting](./troubleshooting.md)
