/**
 * Live model discovery — shared fetch/cache/diff/report machinery so a
 * provider's model list can never go stale silently.
 *
 * Each provider that has its own model-listing API (Anthropic, OpenAI,
 * Gemini today) calls `runLiveModelRefresh()` with a small fetch function.
 * The shared logic here handles:
 *   - an on-disk TTL cache (same envelope shape as model-catalog-cache.ts,
 *     via json-ttl-cache.ts's shared helpers) so a restart doesn't re-fetch
 *     immediately and an offline boot still has the last known-good list;
 *   - diffing against the previous list so a refresh can report what
 *     actually changed ("3 new, 1 retired") instead of a silent no-op;
 *   - an honest fallback chain: live fetch -> last on-disk cache (even if
 *     stale) -> the packaged dated-static list -- never a bare empty array.
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { instrumentedFetch, fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { TTL_24H_MS, isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { inferFallbackContextWindow } from './context-window-fallback.js';
import type { ModelDefinition } from './registry-types.js';

const LIVE_FETCH_TIMEOUT_MS = 15_000;

export type LiveModelDiscoverySource = 'live' | 'cache' | 'dated-static';

export interface LiveModelDiscoveryResult {
  /** The resolved model id list to use right now. Never empty when a dated-static baseline exists. */
  readonly models: readonly string[];
  /** Where `models` came from. */
  readonly source: LiveModelDiscoverySource;
  /** Model ids present now that weren't in the previous known list. */
  readonly added: readonly string[];
  /** Model ids that were in the previous known list but are gone now. */
  readonly removed: readonly string[];
  /** Set when `source !== 'live'` because a live fetch was attempted and failed. Honest failure reason. */
  readonly error?: string | undefined;
  /** Set when `source === 'dated-static'`: the date the packaged list was last verified. */
  readonly asOf?: string | undefined;
}

interface ModelListCacheFile {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: string[];
}

/** Cache file path for a provider's live-discovered model list. */
export function getProviderModelsCachePath(persistenceRoot: string, providerId: string): string {
  return join(persistenceRoot, 'provider-models', `${providerId}.json`);
}

function loadModelListCache(cachePath: string): ModelListCacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const { cache, reason } = validateTtlCacheEnvelope<ModelListCacheFile>(parsed, 'models', 'array');
    if (!cache) {
      logger.warn('[provider-models] Ignoring malformed model list cache', { cachePath, reason: reason ?? 'unknown' });
      return null;
    }
    return cache;
  } catch (err) {
    const msg = summarizeError(err);
    if (!msg.includes('ENOENT') && !msg.includes('no such file')) {
      logger.warn('[provider-models] Model list cache load failed', { cachePath, error: msg });
    }
    return null;
  }
}

function saveModelListCache(models: readonly string[], cachePath: string): void {
  try {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp`;
    const payload: ModelListCacheFile = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: TTL_24H_MS,
      models: [...models],
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    logger.warn('[provider-models] Model list cache write failed', { cachePath, error: summarizeError(err) });
  }
}

/** Diff two model id lists. Order-independent. */
export function diffModelIds(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !previousSet.has(id)),
    removed: previous.filter((id) => !nextSet.has(id)),
  };
}

/** Human-readable one-line summary of a refresh, for surfaces that just want a status line. */
export function formatModelDiscoveryReport(providerName: string, result: LiveModelDiscoveryResult): string {
  if (result.source === 'live') {
    if (result.added.length === 0 && result.removed.length === 0) {
      return `${providerName}: no changes (${result.models.length} models)`;
    }
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`${result.added.length} new`);
    if (result.removed.length > 0) parts.push(`${result.removed.length} retired`);
    return `${providerName}: ${parts.join(', ')}`;
  }
  if (result.error) {
    const fallback = result.source === 'cache' ? 'last known list' : `dated static list (as of ${result.asOf ?? 'unknown'})`;
    return `${providerName}: live model refresh failed (${result.error}) — using ${fallback}`;
  }
  return `${providerName}: using dated static list (as of ${result.asOf ?? 'unknown'})`;
}

export interface LiveModelRefreshOptions {
  readonly providerName: string;
  /**
   * Absolute path to this provider's on-disk model-list cache file. When
   * omitted, refresh runs in-memory only (no on-disk persistence, no TTL
   * skip) — used by tests and any caller that hasn't wired a persistence
   * root through yet.
   */
  readonly cachePath?: string | undefined;
  /** Complete, hand-maintained fallback list used when live discovery is unavailable or fails. */
  readonly datedStaticModels: readonly string[];
  /** The date the dated-static list was last verified, e.g. '2026-07-12'. */
  readonly datedStaticAsOf: string;
  /** Whether the provider has credentials configured. When false, live fetch is skipped entirely. */
  readonly isConfigured: boolean;
  /** Performs the live fetch. Should reject on any failure (network, auth, parse). */
  readonly fetchLive: () => Promise<string[]>;
  /**
   * Bypass the TTL cache and always re-check live. Set this for an explicit
   * user-triggered refresh or a picker-open re-check; leave false for
   * routine background refreshes so they respect the on-disk TTL cache
   * instead of hitting the network on every boot.
   */
  readonly force?: boolean | undefined;
}

/**
 * Run a single live-discovery refresh cycle for one provider: try the cache
 * for a diff baseline, attempt a live fetch when configured, fall back to
 * cache-then-dated-static on failure, and persist a successful fetch.
 */
export async function runLiveModelRefresh(opts: LiveModelRefreshOptions): Promise<LiveModelDiscoveryResult> {
  const cache = opts.cachePath ? loadModelListCache(opts.cachePath) : null;
  const baseline = cache?.models ?? opts.datedStaticModels;

  if (cache && !opts.force && !isTtlCacheStale(cache)) {
    return { models: cache.models, source: 'cache', added: [], removed: [] };
  }

  if (!opts.isConfigured) {
    const { added, removed } = diffModelIds(baseline, opts.datedStaticModels);
    return {
      models: opts.datedStaticModels,
      source: 'dated-static',
      added,
      removed,
      asOf: opts.datedStaticAsOf,
    };
  }

  try {
    const fetched = await opts.fetchLive();
    if (fetched.length === 0) {
      throw new Error('live model list was empty');
    }
    const { added, removed } = diffModelIds(baseline, fetched);
    if (opts.cachePath) saveModelListCache(fetched, opts.cachePath);
    return { models: fetched, source: 'live', added, removed };
  } catch (err) {
    const message = summarizeError(err);
    logger.warn('[provider-models] Live model discovery failed', { provider: opts.providerName, error: message });
    if (cache) {
      return { models: cache.models, source: 'cache', added: [], removed: [], error: message };
    }
    return {
      models: opts.datedStaticModels,
      source: 'dated-static',
      added: [],
      removed: [],
      error: message,
      asOf: opts.datedStaticAsOf,
    };
  }
}

/** Chat-capable OpenAI model id — excludes embeddings, audio, image, and moderation endpoints. */
const OPENAI_NON_CHAT_MODEL_PATTERN = /embedding|whisper|tts|dall-e|davinci|babbage|^ada|moderation|text-search|similarity|transcribe|speech|realtime|image/i;

/**
 * Fetch a model id list from an OpenAI-style listing endpoint
 * (GET <url> returning `{ "data": [{ "id": ... }] }`). Shared by every
 * OpenAI-compatible gateway provider; the same response shape is used by
 * Anthropic-style listings, so the Anthropic-compat fetcher delegates here
 * without the chat-capability filter.
 */
export async function fetchModelIdsFromListing(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  options: { readonly filterNonChat?: boolean | undefined } = {},
): Promise<string[]> {
  const res = await fetchWithTimeout(url, { headers }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`${providerName} model listing (${url}) returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as
    | { data?: Array<{ id?: unknown; model_id?: unknown }> }
    | Array<{ id?: unknown; model_id?: unknown }>;
  // Most backends use OpenAI's `{data:[{id}]}`; Together returns a bare array,
  // and a few aggregators (e.g. AiHubMix) use `model_id` instead of `id`.
  const entries = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(entries)) {
    throw new Error(`${providerName} model listing (${url}) returned no model array`);
  }
  let ids = entries
    .map((entry) => (typeof entry.id === 'string' ? entry.id : typeof entry.model_id === 'string' ? entry.model_id : null))
    .filter((id): id is string => id !== null);
  if (options.filterNonChat) {
    ids = ids.filter((id) => !OPENAI_NON_CHAT_MODEL_PATTERN.test(id));
  }
  return ids;
}

/**
 * Fetch Fireworks' live model list. Fireworks' OpenAI-compatible inference
 * surface has no /models listing; the documented listing lives on the
 * account-management API (GET /v1/accounts/fireworks/models, paginated).
 * Model resource names there ("accounts/fireworks/models/<id>") are exactly
 * the ids the chat surface accepts.
 */
export async function fetchFireworksModelIds(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  do {
    const url = `https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
    if (!res.ok) {
      throw new Error(`Fireworks model listing (${url}) returned ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as { models?: Array<{ name?: unknown }>; nextPageToken?: unknown };
    for (const model of body.models ?? []) {
      if (typeof model.name === 'string' && model.name.length > 0) ids.push(model.name);
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
  } while (pageToken && ids.length < 5000);
  return ids;
}

/** Fetch the live model list from Anthropic's GET /v1/models endpoint. */
export async function fetchAnthropicModelIds(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`Anthropic /v1/models returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => id !== null);
  return ids;
}

/** Fetch the live model list from OpenAI's GET /v1/models endpoint, filtered to chat-capable ids. */
export async function fetchOpenAIModelIds(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`OpenAI /v1/models returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => id !== null)
    .filter((id) => !OPENAI_NON_CHAT_MODEL_PATTERN.test(id));
  return ids;
}

/** Fetch the live model list from Google's Gemini ListModels endpoint. */
export async function fetchGeminiModelIds(apiKey: string): Promise<string[]> {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
    {},
    LIVE_FETCH_TIMEOUT_MS,
    instrumentedFetch,
  );
  if (!res.ok) {
    throw new Error(`Gemini ListModels returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> };
  const ids = (body.models ?? [])
    .filter((entry) => {
      const methods = entry.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.length === 0 || methods.includes('generateContent');
    })
    .map((entry) => (typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : null))
    .filter((id): id is string => id !== null);
  return ids;
}

/**
 * Build a ModelDefinition for a live-discovered or dated-static model id that
 * isn't already represented in the shared model catalog (models.dev). Used
 * to fill the gap when the third-party catalog snapshot lags behind a
 * provider's own live listing (e.g. a model released today).
 */
export function buildProviderNativeModelDefinition(providerId: string, modelId: string): ModelDefinition {
  const lowerProvider = providerId.toLowerCase();
  const isOpenAI = lowerProvider.includes('openai');
  const isGemini = lowerProvider.includes('gemini');
  return {
    id: modelId,
    provider: providerId,
    registryKey: `${providerId}:${modelId}`,
    displayName: modelId,
    description: `${modelId} — sourced from live ${providerId} model discovery.`,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: true,
      multimodal: isOpenAI || isGemini,
    },
    contextWindow: inferFallbackContextWindow(providerId, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    // Gateways mark no-cost models with a 'free' suffix (e.g. openrouter's
    // ':free' variants and its 'openrouter/free' router id).
    tier: /[:/-]free$/i.test(modelId) ? 'free' : 'standard',
    reasoningEffort: ['instant', 'low', 'medium', 'high'],
  };
}
