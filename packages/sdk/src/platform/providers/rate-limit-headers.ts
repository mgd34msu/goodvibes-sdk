/**
 * rate-limit-headers.ts
 *
 * A single, provider-agnostic parser for the rate-limit / quota headers that
 * upstream LLM providers return on EVERY response (success and 429 alike), so
 * the runtime can maintain a quota snapshot and warn before a limit is hit
 * rather than only reacting after a 429.
 *
 * Covers the three families seen in the wild:
 *   - Anthropic: `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`
 *     (reset is an ISO-8601 timestamp) plus `anthropic-ratelimit-unified-*`.
 *   - OpenAI / OpenAI-compatible: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 *     (reset is a duration like `1s`, `6m0s`, or `1h2m3s`).
 *   - IETF draft `RateLimit` (`ratelimit-limit`, `ratelimit-remaining`,
 *     `ratelimit-reset` — reset is delta-seconds).
 * Plus the universal `retry-after` (delta-seconds or an HTTP-date).
 *
 * HONESTY IDIOM: a field is populated ONLY when a header actually carried it.
 * `parseRateLimitHeaders` returns null when NO recognized header was present, so
 * a caller records a signal only for a genuine observation — never a fabricated
 * "full quota". The requests dimension is preferred for limit/remaining (the
 * fan-out assessment reasons over request counts); the tokens dimension is used
 * only as a fallback when no requests header is present.
 */

/** A normalized rate-limit observation parsed from one response's headers. */
export interface ParsedRateLimit {
  /** Observed window limit (requests preferred, else tokens), when a header carried it. */
  readonly limit?: number | undefined;
  /** Observed remaining in the window (requests preferred, else tokens), when a header carried it. */
  readonly remaining?: number | undefined;
  /** Epoch ms the window resets, when a reset header carried it. */
  readonly resetAt?: number | undefined;
  /** Retry-after the provider asked for (ms), when a `retry-after` header carried one. */
  readonly retryAfterMs?: number | undefined;
}

/** A minimal, header-shape-agnostic reader: Headers, a plain record, or an array of pairs. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | ReadonlyArray<readonly [string, string]>;

function getHeader(source: HeaderSource, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(lower) ?? undefined;
  }
  if (Array.isArray(source)) {
    for (const pair of source as ReadonlyArray<readonly [string, string]>) {
      if (pair[0]?.toLowerCase() === lower) return pair[1];
    }
    return undefined;
  }
  const record = source as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) {
      const value = record[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an OpenAI-style duration (`1s`, `6m0s`, `1h2m3s`, `500ms`) to milliseconds. */
export function parseOpenAiResetDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Plain number → seconds (some compat servers emit a bare delta-seconds).
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let matched = false;
  while ((match = re.exec(trimmed)) !== null) {
    matched = true;
    const amount = Number.parseFloat(match[1]!);
    switch (match[2]) {
      case 'ms': totalMs += amount; break;
      case 's': totalMs += amount * 1000; break;
      case 'm': totalMs += amount * 60_000; break;
      case 'h': totalMs += amount * 3_600_000; break;
    }
  }
  return matched ? Math.round(totalMs) : undefined;
}

/** Parse a `retry-after` value (delta-seconds or an HTTP-date) to milliseconds. */
export function parseRetryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
}

/**
 * Parse rate-limit headers from a response. Returns null when no recognized
 * header was present (nothing observed). `now` is injectable for testing.
 */
export function parseRateLimitHeaders(source: HeaderSource, now: number = Date.now()): ParsedRateLimit | null {
  // Anthropic (requests preferred, tokens fallback).
  const anthReqLimit = parseIntOrUndefined(getHeader(source, 'anthropic-ratelimit-requests-limit'));
  const anthReqRemaining = parseIntOrUndefined(getHeader(source, 'anthropic-ratelimit-requests-remaining'));
  const anthReqReset = getHeader(source, 'anthropic-ratelimit-requests-reset');
  const anthTokLimit = parseIntOrUndefined(getHeader(source, 'anthropic-ratelimit-tokens-limit'));
  const anthTokRemaining = parseIntOrUndefined(getHeader(source, 'anthropic-ratelimit-tokens-remaining'));
  const anthTokReset = getHeader(source, 'anthropic-ratelimit-tokens-reset');
  const anthUnifiedReset = getHeader(source, 'anthropic-ratelimit-unified-reset');

  // OpenAI-style (x-ratelimit-*-requests / *-tokens).
  const oaiReqLimit = parseIntOrUndefined(getHeader(source, 'x-ratelimit-limit-requests'));
  const oaiReqRemaining = parseIntOrUndefined(getHeader(source, 'x-ratelimit-remaining-requests'));
  const oaiReqReset = parseOpenAiResetDurationMs(getHeader(source, 'x-ratelimit-reset-requests'));
  const oaiTokLimit = parseIntOrUndefined(getHeader(source, 'x-ratelimit-limit-tokens'));
  const oaiTokRemaining = parseIntOrUndefined(getHeader(source, 'x-ratelimit-remaining-tokens'));
  const oaiTokReset = parseOpenAiResetDurationMs(getHeader(source, 'x-ratelimit-reset-tokens'));

  // IETF draft RateLimit (single dimension; reset is delta-seconds).
  const draftLimit = parseIntOrUndefined(getHeader(source, 'ratelimit-limit'));
  const draftRemaining = parseIntOrUndefined(getHeader(source, 'ratelimit-remaining'));
  const draftResetSec = parseIntOrUndefined(getHeader(source, 'ratelimit-reset'));

  const retryAfterMs = parseRetryAfterMs(getHeader(source, 'retry-after'), now);

  const limit = firstDefined(anthReqLimit, oaiReqLimit, draftLimit, anthTokLimit, oaiTokLimit);
  const remaining = firstDefined(anthReqRemaining, oaiReqRemaining, draftRemaining, anthTokRemaining, oaiTokRemaining);

  // Reset: Anthropic/absolute ISO timestamps are epoch-ms directly; OpenAI/draft
  // deltas are added to `now`.
  const resetAt = firstDefined(
    parseIsoResetToEpochMs(anthReqReset),
    parseIsoResetToEpochMs(anthTokReset),
    parseIsoResetToEpochMs(anthUnifiedReset),
    oaiReqReset !== undefined ? now + oaiReqReset : undefined,
    oaiTokReset !== undefined ? now + oaiTokReset : undefined,
    draftResetSec !== undefined ? now + draftResetSec * 1000 : undefined,
  );

  if (limit === undefined && remaining === undefined && resetAt === undefined && retryAfterMs === undefined) {
    return null;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function parseIsoResetToEpochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}
