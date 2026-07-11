/**
 * decision-otlp.ts — map permission/policy decision-log records to OpenTelemetry
 * (OTLP) span and log semantics, and export them as OTLP/HTTP JSON.
 *
 * HONEST SCOPE: this is EXPORT-ONLY. It surfaces ahead-of-field data that
 * already exists — every allow/deny the DecisionLog already records — by
 * mapping each decision to the OTLP wire shape and POSTing it to a configured
 * collector. There is no ingestion path, no span/trace correlation with the
 * runtime tracer, and no new heavyweight dependency: the payload is plain
 * OTLP/HTTP JSON (which the protocol supports) emitted with the platform's
 * `instrumentedFetch`. Off by default; enabled only with an endpoint.
 *
 * Each decision maps to the same attribute set in both shapes:
 *   decision.id      — the log entry's monotonic sequence number
 *   tool.name        — the tool evaluated
 *   command.class    — the semantic classification (read/write/network/…)
 *   permission.mode  — the active permission mode, when the caller supplies it
 *   decision.layer   — the evaluation layer that produced the decision
 *   decision.reason  — the canonical reason code
 *   decision.allowed — the boolean outcome
 */

import { randomBytes } from 'node:crypto';
import type { DecisionLogEntry } from './decision-log.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

// ── OTLP JSON value/attribute shapes ────────────────────────────────────────

/** An OTLP AnyValue (the subset this mapping emits). */
export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string };

/** An OTLP KeyValue attribute. */
export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

/** An OTLP span (v1/traces) — the fields this mapping populates. */
export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
  readonly status: { readonly code: number };
}

/** An OTLP log record (v1/logs) — the fields this mapping populates. */
export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly observedTimeUnixNano: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: { readonly stringValue: string };
  readonly attributes: readonly OtlpKeyValue[];
}

/** The OTLP/HTTP JSON envelope for a batch of spans. */
export interface OtlpTracePayload {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string };
      readonly spans: readonly OtlpSpan[];
    }[];
  }[];
}

/** The OTLP/HTTP JSON envelope for a batch of log records. */
export interface OtlpLogsPayload {
  readonly resourceLogs: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
    readonly scopeLogs: readonly {
      readonly scope: { readonly name: string };
      readonly logRecords: readonly OtlpLogRecord[];
    }[];
  }[];
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Export configuration; mirrors the `telemetry.decisionOtlp*` config keys. */
export interface DecisionOtlpConfig {
  /** Master switch — off by default. */
  readonly enabled: boolean;
  /** OTLP/HTTP JSON endpoint base (spans → `<base>/v1/traces`, logs → `<base>/v1/logs`). */
  readonly endpoint: string;
  /** Which record shape(s) to emit per decision. */
  readonly signal: 'span' | 'log' | 'both';
  /** `service.name` resource attribute (default: goodvibes-sdk). */
  readonly serviceName?: string | undefined;
  /** Per-request timeout (default 8000ms). */
  readonly timeoutMs?: number | undefined;
  /** Extra headers (e.g. an auth token). */
  readonly headers?: Record<string, string> | undefined;
}

/** Optional per-decision context the log entry does not carry itself. */
export interface DecisionOtlpContext {
  /** The active permission mode, mapped to the `permission.mode` attribute. */
  readonly mode?: string | undefined;
}

const SCOPE_NAME = 'goodvibes.permissions.decisions';

// ── Attribute + record mapping ──────────────────────────────────────────────

/** Map a decision-log entry to the shared OTLP attribute set. */
export function decisionAttributes(
  entry: DecisionLogEntry,
  ctx: DecisionOtlpContext = {},
): OtlpKeyValue[] {
  const { decision } = entry;
  const attrs: OtlpKeyValue[] = [
    { key: 'decision.id', value: { intValue: String(entry.seq) } },
    { key: 'tool.name', value: { stringValue: decision.toolName } },
    { key: 'decision.layer', value: { stringValue: decision.sourceLayer } },
    { key: 'decision.reason', value: { stringValue: decision.reason } },
    { key: 'decision.allowed', value: { boolValue: decision.allowed } },
  ];
  if (decision.classification) {
    attrs.push({ key: 'command.class', value: { stringValue: decision.classification } });
  }
  if (ctx.mode) {
    attrs.push({ key: 'permission.mode', value: { stringValue: ctx.mode } });
  }
  if (decision.policyBundleId) {
    attrs.push({ key: 'policy.bundle.id', value: { stringValue: decision.policyBundleId } });
  }
  return attrs;
}

/** Random OTLP trace/span id (hex of the given byte length). */
function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Map a decision-log entry to an OTLP span. */
export function decisionToSpan(entry: DecisionLogEntry, ctx: DecisionOtlpContext = {}): OtlpSpan {
  const nanos = String(entry.decision.timestamp * 1_000_000);
  return {
    traceId: hexId(16),
    spanId: hexId(8),
    name: 'permission.decision',
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos,
    endTimeUnixNano: nanos,
    attributes: decisionAttributes(entry, ctx),
    status: { code: 0 }, // STATUS_CODE_UNSET — export-only, no error semantics
  };
}

/** Map a decision-log entry to an OTLP log record. */
export function decisionToLogRecord(entry: DecisionLogEntry, ctx: DecisionOtlpContext = {}): OtlpLogRecord {
  const nanos = String(entry.decision.timestamp * 1_000_000);
  const allowed = entry.decision.allowed;
  return {
    timeUnixNano: nanos,
    observedTimeUnixNano: nanos,
    // INFO(9) for an allow, ERROR(17) for a deny — an honest severity mapping.
    severityNumber: allowed ? 9 : 17,
    severityText: allowed ? 'INFO' : 'ERROR',
    body: {
      stringValue: `permission ${allowed ? 'allow' : 'deny'} ${entry.decision.toolName} (${entry.decision.reason})`,
    },
    attributes: decisionAttributes(entry, ctx),
  };
}

function resourceAttributes(serviceName: string): OtlpKeyValue[] {
  return [{ key: 'service.name', value: { stringValue: serviceName } }];
}

/** Build the OTLP/HTTP JSON trace payload for a batch of decisions. */
export function buildTracePayload(
  entries: readonly DecisionLogEntry[],
  serviceName = 'goodvibes-sdk',
  ctx: DecisionOtlpContext = {},
): OtlpTracePayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(serviceName) },
        scopeSpans: [
          { scope: { name: SCOPE_NAME }, spans: entries.map((e) => decisionToSpan(e, ctx)) },
        ],
      },
    ],
  };
}

/** Build the OTLP/HTTP JSON logs payload for a batch of decisions. */
export function buildLogsPayload(
  entries: readonly DecisionLogEntry[],
  serviceName = 'goodvibes-sdk',
  ctx: DecisionOtlpContext = {},
): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(serviceName) },
        scopeLogs: [
          { scope: { name: SCOPE_NAME }, logRecords: entries.map((e) => decisionToLogRecord(e, ctx)) },
        ],
      },
    ],
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

/** Outcome of an export attempt. Never thrown — export never blocks the runtime. */
export interface DecisionExportResult {
  readonly exported: boolean;
  /** Why nothing was exported, when `exported` is false. */
  readonly reason?: string | undefined;
  /** The OTLP signals that were POSTed. */
  readonly signals: readonly ('span' | 'log')[];
}

/** Join an endpoint base with a signal path, tolerating a trailing slash. */
function endpointFor(base: string, path: string): string {
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

async function postOtlp(
  url: string,
  payload: OtlpTracePayload | OtlpLogsPayload,
  config: DecisionOtlpConfig,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000);
  timer.unref?.();
  try {
    const response = await instrumentedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('[decision-otlp] endpoint rejected export', { url, status: response.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('[decision-otlp] export failed', { url, error: summarizeError(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Export a batch of decision-log entries as OTLP/HTTP JSON. Off by default: when
 * `enabled` is false or no endpoint is configured, this is a no-op that reports
 * why. Never throws — an unreachable collector never blocks a permission
 * decision.
 */
export async function exportDecisions(
  entries: readonly DecisionLogEntry[],
  config: DecisionOtlpConfig,
  ctx: DecisionOtlpContext = {},
): Promise<DecisionExportResult> {
  if (!config.enabled) return { exported: false, reason: 'decision OTLP export disabled', signals: [] };
  if (!config.endpoint.trim()) return { exported: false, reason: 'no OTLP endpoint configured', signals: [] };
  if (entries.length === 0) return { exported: false, reason: 'no decisions to export', signals: [] };

  const serviceName = config.serviceName ?? 'goodvibes-sdk';
  const signals: ('span' | 'log')[] = [];

  if (config.signal === 'span' || config.signal === 'both') {
    const ok = await postOtlp(
      endpointFor(config.endpoint, 'v1/traces'),
      buildTracePayload(entries, serviceName, ctx),
      config,
    );
    if (ok) signals.push('span');
  }
  if (config.signal === 'log' || config.signal === 'both') {
    const ok = await postOtlp(
      endpointFor(config.endpoint, 'v1/logs'),
      buildLogsPayload(entries, serviceName, ctx),
      config,
    );
    if (ok) signals.push('log');
  }

  return signals.length > 0
    ? { exported: true, signals }
    : { exported: false, reason: 'all OTLP exports failed', signals: [] };
}
