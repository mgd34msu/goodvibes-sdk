/**
 * decision-log-otlp.test.ts
 *
 * The permission/policy decision log maps to OpenTelemetry (OTLP) span and log
 * semantics and exports as OTLP/HTTP JSON — export-only, off by default, no new
 * heavyweight dependency. Pins: the emitted payload validates against the OTLP
 * JSON shape for BOTH a span-style and a log-style record; the shared attribute
 * mapping; the off-by-default / no-endpoint no-ops; and a live POST round-trip
 * proving the on-the-wire body parses back into the OTLP shape.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import type { Server } from 'bun';
import {
  buildTracePayload,
  buildLogsPayload,
  decisionToSpan,
  decisionToLogRecord,
  decisionAttributes,
  exportDecisions,
  type OtlpTracePayload,
  type OtlpLogsPayload,
  type OtlpKeyValue,
} from '../packages/sdk/src/platform/runtime/permissions/decision-otlp.js';
import type { DecisionLogEntry } from '../packages/sdk/src/platform/runtime/permissions/decision-log.js';
import type { PermissionDecision } from '../packages/sdk/src/platform/runtime/permissions/types.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeDecision(over: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    allowed: true,
    reason: 'RULE_ALLOW_USER',
    sourceLayer: 'policy',
    toolName: 'exec',
    args: { command: 'ls' },
    classification: 'read',
    timestamp: 1_700_000_000_000,
    evaluationTrace: [],
    ...over,
  };
}

function entry(seq: number, over: Partial<PermissionDecision> = {}): DecisionLogEntry {
  return { seq, decision: makeDecision(over) };
}

const HEX = /^[0-9a-f]+$/;

// ── OTLP JSON shape validators (mirror the proto-JSON contract) ──────────────

function validateAttributes(attrs: readonly OtlpKeyValue[]): void {
  expect(Array.isArray(attrs)).toBe(true);
  for (const a of attrs) {
    expect(typeof a.key).toBe('string');
    const v = a.value as Record<string, unknown>;
    const hasOne =
      typeof v['stringValue'] === 'string' ||
      typeof v['boolValue'] === 'boolean' ||
      typeof v['intValue'] === 'string';
    expect(hasOne).toBe(true);
  }
}

function validateTracePayload(p: OtlpTracePayload): void {
  expect(Array.isArray(p.resourceSpans)).toBe(true);
  const rs = p.resourceSpans[0]!;
  expect(rs.resource.attributes.some((a) => a.key === 'service.name')).toBe(true);
  const ss = rs.scopeSpans[0]!;
  expect(typeof ss.scope.name).toBe('string');
  for (const span of ss.spans) {
    expect(span.traceId).toMatch(HEX);
    expect(span.traceId).toHaveLength(32); // 16 bytes hex
    expect(span.spanId).toMatch(HEX);
    expect(span.spanId).toHaveLength(16); // 8 bytes hex
    expect(typeof span.name).toBe('string');
    expect(typeof span.kind).toBe('number');
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    expect(typeof span.status.code).toBe('number');
    validateAttributes(span.attributes);
  }
}

function validateLogsPayload(p: OtlpLogsPayload): void {
  expect(Array.isArray(p.resourceLogs)).toBe(true);
  const rl = p.resourceLogs[0]!;
  expect(rl.resource.attributes.some((a) => a.key === 'service.name')).toBe(true);
  const sl = rl.scopeLogs[0]!;
  expect(typeof sl.scope.name).toBe('string');
  for (const rec of sl.logRecords) {
    expect(rec.timeUnixNano).toMatch(/^\d+$/);
    expect(rec.observedTimeUnixNano).toMatch(/^\d+$/);
    expect(typeof rec.severityNumber).toBe('number');
    expect(typeof rec.severityText).toBe('string');
    expect(typeof rec.body.stringValue).toBe('string');
    validateAttributes(rec.attributes);
  }
}

// ── attribute mapping ────────────────────────────────────────────────────────

describe('decisionAttributes', () => {
  test('maps id, tool, class, layer, reason, allowed — plus mode when supplied', () => {
    const attrs = decisionAttributes(entry(7), { mode: 'prompt' });
    const byKey = new Map(attrs.map((a) => [a.key, a.value]));
    expect(byKey.get('decision.id')).toEqual({ intValue: '7' });
    expect(byKey.get('tool.name')).toEqual({ stringValue: 'exec' });
    expect(byKey.get('command.class')).toEqual({ stringValue: 'read' });
    expect(byKey.get('decision.layer')).toEqual({ stringValue: 'policy' });
    expect(byKey.get('decision.reason')).toEqual({ stringValue: 'RULE_ALLOW_USER' });
    expect(byKey.get('decision.allowed')).toEqual({ boolValue: true });
    expect(byKey.get('permission.mode')).toEqual({ stringValue: 'prompt' });
  });
});

// ── span-style + log-style shape ─────────────────────────────────────────────

describe('OTLP JSON shape', () => {
  test('span-style record validates against the OTLP trace shape', () => {
    const payload = buildTracePayload([entry(1), entry(2, { allowed: false, reason: 'RULE_DENY_USER' })]);
    validateTracePayload(payload);
    // the payload survives a JSON round-trip unchanged in shape
    validateTracePayload(JSON.parse(JSON.stringify(payload)) as OtlpTracePayload);
  });

  test('log-style record validates against the OTLP logs shape', () => {
    const payload = buildLogsPayload([entry(1), entry(2, { allowed: false, reason: 'RULE_DENY_USER' })]);
    validateLogsPayload(payload);
    validateLogsPayload(JSON.parse(JSON.stringify(payload)) as OtlpLogsPayload);
  });

  test('allow → INFO(9), deny → ERROR(17) severity in the log record', () => {
    expect(decisionToLogRecord(entry(1, { allowed: true })).severityNumber).toBe(9);
    expect(decisionToLogRecord(entry(2, { allowed: false })).severityNumber).toBe(17);
  });

  test('span timestamps are the decision timestamp in unix nanos', () => {
    const span = decisionToSpan(entry(1));
    expect(span.startTimeUnixNano).toBe(String(1_700_000_000_000 * 1_000_000));
  });
});

// ── export gating (off by default) ───────────────────────────────────────────

describe('exportDecisions gating', () => {
  const base = { endpoint: 'http://localhost:1/', signal: 'span' as const };
  test('disabled → no-op', async () => {
    const r = await exportDecisions([entry(1)], { ...base, enabled: false });
    expect(r.exported).toBe(false);
    expect(r.reason).toContain('disabled');
  });
  test('no endpoint → no-op', async () => {
    const r = await exportDecisions([entry(1)], { enabled: true, endpoint: '', signal: 'span' });
    expect(r.exported).toBe(false);
    expect(r.reason).toContain('endpoint');
  });
  test('no decisions → no-op', async () => {
    const r = await exportDecisions([], { ...base, enabled: true });
    expect(r.exported).toBe(false);
    expect(r.reason).toContain('no decisions');
  });
});

// ── live POST round-trip: the on-the-wire body parses as OTLP JSON ───────────

describe('exportDecisions POST round-trip', () => {
  const received: Array<{ path: string; body: unknown }> = [];
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received.push({ path: url.pathname, body: await req.json() });
      return new Response('{}', { status: 200 });
    },
  });
  const endpoint = `http://localhost:${server.port}`;
  afterAll(() => { server.stop(true); });

  test('signal=both POSTs a valid OTLP trace body AND a valid OTLP logs body', async () => {
    const r = await exportDecisions(
      [entry(1), entry(2, { allowed: false, reason: 'SAFETY_DENY_GUARDRAIL', sourceLayer: 'safety' })],
      { enabled: true, endpoint, signal: 'both' },
      { mode: 'prompt' },
    );
    expect(r.exported).toBe(true);
    expect(r.signals.sort()).toEqual(['log', 'span']);

    const traces = received.find((x) => x.path === '/v1/traces');
    const logs = received.find((x) => x.path === '/v1/logs');
    expect(traces).toBeDefined();
    expect(logs).toBeDefined();
    validateTracePayload(traces!.body as OtlpTracePayload);
    validateLogsPayload(logs!.body as OtlpLogsPayload);
  });
});
