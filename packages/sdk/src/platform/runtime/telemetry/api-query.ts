import type { ReadableSpan } from './types.js';
import type {
  TelemetryFilter,
  TelemetryPageInfo,
  TelemetryRecord,
  TelemetryViewMode,
} from './api.js';
import {
  buildSpanCursor,
  clampLimit,
  extractRecordSequence,
  normalizeTraceId,
  sanitizeRecord,
  sanitizeSpan,
} from './api-helpers.js';

export function applyTelemetryRecordFilter(
  records: readonly TelemetryRecord[],
  filter: TelemetryFilter,
  view: TelemetryViewMode,
): { items: readonly TelemetryRecord[]; pageInfo: TelemetryPageInfo } {
  const filtered = records.filter((record) => telemetryRecordMatches(record, filter));
  filtered.sort((left, right) => {
    const timestampDelta = right.timestamp - left.timestamp;
    if (timestampDelta !== 0) return timestampDelta;
    return extractRecordSequence(right) - extractRecordSequence(left);
  });
  const limit = clampLimit(filter.limit, 100);
  const startIndex = filter.cursor ? resolveTelemetryRecordCursor(filtered, filter.cursor) + 1 : 0;
  const page = filtered.slice(startIndex, startIndex + limit);
  const next = filtered[startIndex + limit];
  return {
    items: page.map((record) => sanitizeRecord(record, view)),
    pageInfo: {
      limit,
      returned: page.length,
      hasMore: Boolean(next),
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
      ...(next ? { nextCursor: next.id } : {}),
    },
  };
}

export function applyTelemetrySpanFilter(
  spans: readonly ReadableSpan[],
  filter: TelemetryFilter,
  view: TelemetryViewMode,
): { items: readonly ReadableSpan[]; pageInfo: TelemetryPageInfo } {
  const normalizedTraceId = filter.traceId ? normalizeTraceId(filter.traceId) : undefined;
  const filtered = spans.filter((span) => {
    if (filter.since !== undefined && span.startTimeMs < filter.since) return false;
    if (filter.until !== undefined && span.endTimeMs > filter.until) return false;
    if (normalizedTraceId && span.spanContext.traceId !== normalizedTraceId) return false;
    if (filter.turnId !== undefined && span.attributes.turnId !== filter.turnId) return false;
    if (filter.agentId !== undefined && span.attributes.agentId !== filter.agentId) return false;
    if (filter.taskId !== undefined && span.attributes.taskId !== filter.taskId) return false;
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      const startEventType = typeof span.attributes.startEventType === 'string' ? span.attributes.startEventType : '';
      if (!filter.eventTypes.includes(startEventType)) return false;
    }
    return true;
  }).sort((left, right) => right.endTimeMs - left.endTimeMs);
  const limit = clampLimit(filter.limit, 100);
  const startIndex = filter.cursor ? resolveTelemetrySpanCursor(filtered, filter.cursor) + 1 : 0;
  const page = filtered.slice(startIndex, startIndex + limit);
  const next = filtered[startIndex + limit];
  return {
    items: page.map((span) => sanitizeSpan(span, view)),
    pageInfo: {
      limit,
      returned: page.length,
      hasMore: Boolean(next),
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
      ...(next ? { nextCursor: buildSpanCursor(next) } : {}),
    },
  };
}

export function telemetryRecordMatches(record: TelemetryRecord, filter: TelemetryFilter): boolean {
  if (filter.since !== undefined && record.timestamp < filter.since) return false;
  if (filter.until !== undefined && record.timestamp > filter.until) return false;
  if (filter.domains && filter.domains.length > 0 && !filter.domains.includes(record.domain)) return false;
  if (filter.eventTypes && filter.eventTypes.length > 0 && !filter.eventTypes.includes(record.type)) return false;
  if (filter.severity && record.severity !== filter.severity) return false;
  if (filter.traceId && record.traceId !== normalizeTraceId(filter.traceId)) return false;
  if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
  if (filter.turnId && record.turnId !== filter.turnId) return false;
  if (filter.agentId && record.agentId !== filter.agentId) return false;
  if (filter.taskId && record.taskId !== filter.taskId) return false;
  return true;
}

export function resolveTelemetryRecordCursor(records: readonly TelemetryRecord[], cursor: string): number {
  const index = records.findIndex((record) => record.id === cursor);
  if (index >= 0) return index;
  throw new Error(`Invalid telemetry cursor: ${cursor}`);
}

export function resolveTelemetrySpanCursor(spans: readonly ReadableSpan[], cursor: string): number {
  const index = spans.findIndex((span) => buildSpanCursor(span) === cursor);
  if (index >= 0) return index;
  throw new Error(`Invalid telemetry cursor: ${cursor}`);
}
