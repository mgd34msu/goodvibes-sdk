import { logger } from '../../utils/logger.js';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import { FETCH_TOOL_SCHEMA } from './schema.js';
import type { FetchInput, FetchUrlInput, FetchAuthInput, FetchExtractMode, FetchVerbosity, FetchSanitizeMode } from './schema.js';
import type { FetchOutput, FetchUrlResult } from './types.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { applySanitizer, resolveSanitizeMode } from './sanitizer.js';
import {
  classifyHostTrustTier,
  emitSsrfDeny,
  emitHostTrustTier,
  extractHostname,
  type TrustTierConfig,
} from './trust-tiers.js';
import { applyExtract, sniffContentType } from './extract.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { toRecord } from '../../utils/record-coerce.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

export interface FetchRuntimeDeps {
  readonly serviceRegistry?: Pick<ServiceRegistry, 'resolveAuth'> | null | undefined;
  readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
}

interface CacheEntry {
  data: FetchUrlResult;
  timestamp: number;
  ttl: number;
}

const MAX_CACHE_SIZE = 500;
const MAX_FETCH_URLS = 20;
const MAX_PARALLEL_FETCHES = 5;
const MAX_REDIRECTS = 10;

const DEFAULT_TIMEOUT_MS = 30_000;

export class FetchRuntimeService {
  private readonly responseCache = new Map<string, CacheEntry>();
  private cacheWriteCount = 0;

  getCached(key: string, cacheTtlSeconds: number): FetchUrlResult | null {
    const entry = this.responseCache.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.timestamp) / 1000 >= cacheTtlSeconds) return null;
    return { ...entry.data, from_cache: true };
  }

  cacheSet(key: string, entry: CacheEntry): void {
    this.cacheWriteCount++;
    if (this.cacheWriteCount % 50 === 0) {
      const now = Date.now();
      for (const [cachedKey, cachedValue] of this.responseCache) {
        if (now - cachedValue.timestamp > cachedValue.ttl * 1000) {
          this.responseCache.delete(cachedKey);
        }
      }
    }
    if (this.responseCache.size >= MAX_CACHE_SIZE) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest !== undefined) this.responseCache.delete(oldest);
    }
    this.responseCache.set(key, entry);
  }

  async execute(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
    const globalExtract: FetchExtractMode = input.extract ?? 'raw';
    const parallel: boolean = input.parallel !== false;
    const verbosity: FetchVerbosity = input.verbosity ?? 'standard';
    const cacheTtlSeconds = input.cache_ttl_seconds ?? 0;
    const rateLimitMs = input.rate_limit_ms ?? 0;
    const maxContentLength = input.max_content_length;

    if (input.urls.length > MAX_FETCH_URLS) {
      return {
        success: false,
        summary: {
          total: input.urls.length,
          succeeded: 0,
          failed: input.urls.length,
          total_ms: 0,
        },
        results: [{
          url: input.urls[0]?.url ?? '',
          error: `Too many URLs: maximum ${MAX_FETCH_URLS} per fetch call`,
        }],
      };
    }

    const sanitizeMode = resolveSanitizeMode(input.sanitize_mode);
    const trustTierConfig: TrustTierConfig = {
      trustedHosts: input.trusted_hosts,
      blockedHosts: input.blocked_hosts,
    };

    const fetchOpts: FetchOneOptions = {
      globalExtract,
      verbosity,
      cacheTtlSeconds,
      maxContentLength,
      sanitizeMode,
      trustTierConfig,
      deps,
    };

    const wallStart = performance.now();
    let results: FetchUrlResult[];

    if (parallel) {
      if (rateLimitMs > 0) {
        logger.debug('fetch tool: rate_limit_ms is ignored in parallel mode; set parallel: false to enforce rate limiting');
      }
      results = await mapWithConcurrency(
        input.urls,
        MAX_PARALLEL_FETCHES,
        (urlInput) => fetchOne(urlInput, fetchOpts, this),
      );
    } else {
      results = [];
      for (let i = 0; i < input.urls.length; i++) {
        if (i > 0 && rateLimitMs > 0) {
          await delay(rateLimitMs);
        }
        results.push(await fetchOne(input.urls[i]!, fetchOpts, this));
      }
    }

    const totalMs = Math.round(performance.now() - wallStart);
    const succeeded = results.filter((result) => result.error === undefined).length;
    const failed = results.filter((result) => result.error !== undefined).length;

    const output: FetchOutput = {
      success: true,
      summary: {
        total: results.length,
        succeeded,
        failed,
        total_ms: totalMs,
      },
    };

    if (verbosity !== 'count_only') {
      output.results = results;
    }

    return output;
  }
}

export async function executeFetchInput(input: FetchInput, deps: FetchRuntimeDeps = {}): Promise<FetchOutput> {
  return new FetchRuntimeService().execute(input, deps);
}

function buildUrl(base: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return base;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`Invalid URL: ${base}`);
  }
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

function cacheKey(
  url: string,
  params: Record<string, string> | undefined,
  extract: FetchExtractMode,
  verbosity: FetchVerbosity,
): string {
  const base = params && Object.keys(params).length > 0
    ? `${url}?${new URLSearchParams(params).toString()}`
    : url;
  return `${base}|${extract}|${verbosity}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const timer = setTimeout(r, ms);
    timer.unref?.();
  });
}

interface FetchOneOptions {
  globalExtract: FetchExtractMode;
  verbosity: FetchVerbosity;
  cacheTtlSeconds: number;
  maxContentLength?: number | undefined;
  sanitizeMode: FetchSanitizeMode;
  trustTierConfig: TrustTierConfig;
  deps: FetchRuntimeDeps;
}

interface PreparedFetchRequest {
  headers: Record<string, string>;
  body?: string | FormData | undefined;
}

function applyAuthHeaders(headers: Record<string, string>, auth: FetchAuthInput): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;
    case 'basic': {
      const user = auth.username ?? '';
      const pass = auth.password ?? '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'api-key': {
      const headerName = auth.header ?? 'X-API-Key';
      if (auth.key) {
        headers[headerName] = auth.key;
      }
      break;
    }
  }
}

function encodeFormBodyData(bodyData: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(bodyData)) {
    params.append(key, value);
  }
  return params.toString();
}

async function fetchOneRaw(
  urlInput: FetchUrlInput,
  headers: Record<string, string>,
  method: string,
  body: string | FormData | undefined,
  effectiveUrl: string,
  trustTierConfig: TrustTierConfig,
  sanitizationEnabled: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = sanitizationEnabled
      ? await fetchWithValidatedRedirects({
          url: effectiveUrl,
          method,
          headers,
          body,
          signal: controller.signal,
          trustTierConfig,
        })
      : await instrumentedFetch(effectiveUrl, {
          method,
          ...(Object.keys(headers).length > 0 ? { headers: headers as HeadersInit } : {}),
          ...(body !== undefined ? { body } : {}),
          signal: controller.signal,
        } as RequestInit);
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchWithValidatedRedirects(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
  signal: AbortSignal;
  trustTierConfig: TrustTierConfig;
}): Promise<Response> {
  let currentUrl = input.url;
  let currentMethod = input.method;
  let currentBody = input.body;
  let currentHeaders = { ...input.headers };

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await instrumentedFetch(currentUrl, {
      method: currentMethod,
      ...(Object.keys(currentHeaders).length > 0 ? { headers: currentHeaders as HeadersInit } : {}),
      ...(currentBody !== undefined ? { body: currentBody } : {}),
      signal: input.signal,
      redirect: 'manual',
    } as RequestInit);

    if (!isRedirectStatus(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    const nextHost = extractHostname(nextUrl);
    if (nextHost !== null) {
      const trustResult = classifyHostTrustTier(nextHost, input.trustTierConfig);
      emitHostTrustTier(nextHost, nextUrl, trustResult);
      if (trustResult.tier === 'blocked') {
        if (trustResult.isSsrf) emitSsrfDeny(nextHost, nextUrl, trustResult.reason);
        throw new Error(`Redirect blocked: ${trustResult.reason}`);
      }
    }

    if (shouldRewriteRedirectToGet(response.status, currentMethod)) {
      currentMethod = 'GET';
      currentBody = undefined;
      currentHeaders = removeContentHeaders(currentHeaders);
    }
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      currentHeaders = removeCredentialHeaders(currentHeaders);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects after ${MAX_REDIRECTS} hops`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
  const upper = method.toUpperCase();
  return status === 303 || ((status === 301 || status === 302) && upper === 'POST');
}

function removeContentHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      const normalized = key.toLowerCase();
      return normalized !== 'content-type' && normalized !== 'content-length';
    }),
  );
}

function removeCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => {
      const normalized = key.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'cookie' && normalized !== 'proxy-authorization';
    }),
  );
}

function prepareFetchHeaders(urlInput: FetchUrlInput): Record<string, string> {
  const headers: Record<string, string> = { ...(urlInput.headers ?? {}) };
  if (urlInput.auth) {
    applyAuthHeaders(headers, urlInput.auth);
  }
  return headers;
}

async function prepareFetchRequest(
  urlInput: FetchUrlInput,
  deps: FetchRuntimeDeps,
): Promise<PreparedFetchRequest> {
  const headers = prepareFetchHeaders(urlInput);

  if (!urlInput.auth && urlInput.service) {
    const serviceHeaders = await deps.serviceRegistry?.resolveAuth(urlInput.service);
    if (serviceHeaders) {
      Object.assign(headers, serviceHeaders);
    }
  }

  try {
    const effectiveUrl = buildUrl(urlInput.url, urlInput.params);
    if (/\/api\/|\/v\d+\/|\/graphql/i.test(effectiveUrl)) {
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
        headers['Accept'] = 'application/json';
      }
    }
  } catch {
    // malformed URL, skip auto-negotiation
  }

  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  let body: string | FormData | undefined;

  if (urlInput.body_type === 'multipart' && urlInput.body_data) {
    const form = new FormData();
    for (const [k, v] of Object.entries(urlInput.body_data)) {
      form.append(k, v);
    }
    body = form;
  } else if (urlInput.body_type === 'form' && urlInput.body_data) {
    body = encodeFormBodyData(urlInput.body_data);
    if (!hasContentType) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else if (urlInput.body_base64 !== undefined) {
    body = Buffer.from(urlInput.body_base64, 'base64').toString();
    if (!hasContentType) {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }
  } else if (urlInput.body !== undefined) {
    body = urlInput.body;
    if (!hasContentType) {
      headers['Content-Type'] = urlInput.body_type === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }
  }

  return { headers, body };
}

function buildFetchResultBase(
  urlInput: FetchUrlInput,
  response: Response,
  durationMs: number,
): FetchUrlResult {
  return {
    url: urlInput.url,
    status: response.status,
    statusText: response.statusText,
    duration_ms: durationMs,
  };
}

async function fetchOne(
  urlInput: FetchUrlInput,
  opts: FetchOneOptions,
  runtime: FetchRuntimeService,
): Promise<FetchUrlResult> {
  const { globalExtract, verbosity, cacheTtlSeconds, maxContentLength, sanitizeMode, trustTierConfig, deps } = opts;
  const extractMode: FetchExtractMode = urlInput.extract ?? globalExtract;
  const method = urlInput.method ?? 'GET';
  const effectiveMaxContent = urlInput.max_content_length ?? maxContentLength;

  const effectiveUrl = buildUrl(urlInput.url, urlInput.params);
  const sanitizationEnabled = deps.featureFlags?.isEnabled('fetch-sanitization') ?? false;
  const effectiveSanitizeModeForBlocked = sanitizationEnabled ? sanitizeMode : 'none';

  const hostname = extractHostname(urlInput.url);
  let initialTrustResult: ReturnType<typeof classifyHostTrustTier> | null = null;
  if (hostname !== null) {
    initialTrustResult = classifyHostTrustTier(hostname, trustTierConfig);
    emitHostTrustTier(hostname, urlInput.url, initialTrustResult);

    if (sanitizationEnabled && initialTrustResult.tier === 'blocked') {
      if (initialTrustResult.isSsrf) {
        emitSsrfDeny(hostname, urlInput.url, initialTrustResult.reason);
      }
      return {
        url: urlInput.url,
        error: `Request blocked: ${initialTrustResult.reason}`,
        host_trust_tier: 'blocked',
        sanitization_tier: effectiveSanitizeModeForBlocked,
      };
    }
  }

  if (cacheTtlSeconds > 0 && method === 'GET') {
    const key = cacheKey(urlInput.url, urlInput.params, extractMode, verbosity);
    const cached = runtime.getCached(key, cacheTtlSeconds);
    if (cached) {
      return cached;
    }
  }

  const { headers, body: requestBody } = await prepareFetchRequest(urlInput, deps);
  const startTime = performance.now();

  try {
    let response = await fetchOneRaw(
      urlInput,
      headers,
      method,
      requestBody,
      effectiveUrl,
      trustTierConfig,
      sanitizationEnabled,
    );

    const retryOnAuth = urlInput.retry_on_auth ?? (urlInput.service !== undefined);
    if (response.status === 401 && retryOnAuth && urlInput.service && !(requestBody instanceof FormData)) {
      const refreshedHeaders = await deps.serviceRegistry?.resolveAuth(urlInput.service);
      if (refreshedHeaders) {
        const retryHeaders = { ...headers };
        Object.assign(retryHeaders, refreshedHeaders);
        response = await fetchOneRaw(
          urlInput,
          retryHeaders,
          method,
          requestBody,
          effectiveUrl,
          trustTierConfig,
          sanitizationEnabled,
        );
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    let contentType = response.headers.get('content-type') ?? '';
    const bodyResult = await readResponseText(response, effectiveMaxContent);
    let rawBody = bodyResult.text;
    contentType = sniffContentType(contentType, rawBody);

    const truncated = bodyResult.truncated;

    const byteSize = Buffer.byteLength(rawBody, 'utf-8');
    const result: FetchUrlResult = buildFetchResultBase(urlInput, response, durationMs);

    if (verbosity === 'count_only') {
      cacheSuccessfulGet(runtime, cacheTtlSeconds, method, cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), result);
      return result;
    }

    result.contentType = contentType;
    result.byteSize = byteSize;
    if (truncated) result.truncated = true;
    result.redirected = response.redirected;
    result.final_url = response.url !== effectiveUrl ? response.url : undefined;

    let effectiveSanitizeMode = sanitizationEnabled ? sanitizeMode : 'none' as const;
    if (sanitizationEnabled && hostname !== null) {
      const hostTrustResult = initialTrustResult ?? classifyHostTrustTier(hostname, trustTierConfig);
      result.host_trust_tier = hostTrustResult.tier;
      if (hostTrustResult.tier === 'unknown' && effectiveSanitizeMode === 'none') {
        effectiveSanitizeMode = 'safe-text';
      }
    } else if (hostname !== null && initialTrustResult !== null) {
      result.host_trust_tier = initialTrustResult.tier;
    }

    if (verbosity === 'minimal') {
      result.sanitization_tier = 'skipped';
    } else {
      result.sanitization_tier = effectiveSanitizeMode;
    }

    if (verbosity !== 'minimal') {
      const extracted = applyExtract(rawBody, contentType, extractMode, { selectors: urlInput.selectors });
      const sanitized = applySanitizer(extracted, effectiveSanitizeMode);
      logger.debug('SANITIZE_MODE_APPLIED', {
        event: 'SANITIZE_MODE_APPLIED',
        url: urlInput.url,
        mode: effectiveSanitizeMode,
        modified: sanitized.modified,
      });
      result.content = sanitized.content;
      result.tokens_used = Math.ceil(sanitized.content.length / 4);
    }

    if (verbosity === 'verbose') {
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      result.metadata = {
        headers: respHeaders,
        redirected: response.redirected,
        finalUrl: response.url,
      };
    }

    cacheSuccessfulGet(runtime, cacheTtlSeconds, method, cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), result);
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `Timeout after ${urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : summarizeError(err);
    logger.warn('fetch tool: request failed', { url: urlInput.url, error: message });
    return { url: urlInput.url, error: message, duration_ms: durationMs };
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number | undefined,
): Promise<{ text: string; truncated: boolean }> {
  if (maxBytes === undefined || maxBytes <= 0 || !response.body) {
    return { text: await response.text(), truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
      if (value.byteLength > remaining) {
        truncated = true;
        await cancelResponseReader(reader, 'Response body limit reached');
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch (error) {
    logger.warn('Fetch response reader cancel failed', {
      reason,
      error: summarizeError(error),
    });
  }
}

function cacheSuccessfulGet(
  runtime: FetchRuntimeService,
  cacheTtlSeconds: number,
  method: string,
  key: string,
  result: FetchUrlResult,
): void {
  if (cacheTtlSeconds > 0 && method === 'GET') {
    runtime.cacheSet(key, { data: result, timestamp: Date.now(), ttl: cacheTtlSeconds });
  }
}

export function createFetchTool(
  deps: FetchRuntimeDeps = {},
  runtime = new FetchRuntimeService(),
): Tool {
  return {
    definition: {
      name: 'fetch',
      description:
        'Fetch one or more URLs via HTTP. Supports batch parallel/sequential requests,'
        + ' per-URL method/headers/body/params, extraction modes (raw, text, json, markdown,'
        + ' readable, code_blocks, links, metadata, structured, tables, pdf, summary),'
        + ' per-URL timeouts, caching, rate limiting, auth refresh, content-length limits,'
        + ' redirect tracking, timing metrics, token estimation, and verbosity control.',
      parameters: toRecord(FETCH_TOOL_SCHEMA),
      sideEffects: ['network'],
      concurrency: 'parallel',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
      if (!Array.isArray(args.urls) || args.urls.length === 0) {
        return { success: false, error: 'Missing or empty "urls" array' };
      }

      try {
        const input = { ...args, urls: args.urls } as unknown as FetchInput;
        const output = await runtime.execute(input, deps);
        return { success: true, output: JSON.stringify(output) };
      } catch (err) {
        const message = summarizeError(err);
        logger.error('fetch tool: unexpected error', { error: message });
        return { success: false, error: `Unexpected error: ${message}` };
      }
    },
  };
}
