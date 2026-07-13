import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderModelSource, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import { buildStandardProviderAuthRoutes } from './runtime-metadata.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { summarizeError, toProviderError } from '../utils/error-display.js';
import { instrumentedLlmCall } from '../runtime/llm-observability.js';
import { logger } from '../utils/logger.js';

const COPILOT_TOKEN_URL = `https://api.github.com/${['copilot', 'internal'].join('_')}/v2/token`;
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const COPILOT_EDITOR_VERSION = 'vscode/1.96.2';
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const COPILOT_GITHUB_API_VERSION = '2025-04-01';
const COPILOT_TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * Dated fallback model list — used when no GitHub token is configured (so a
 * live /models call isn't possible) and as the offline baseline when a live
 * call fails with no prior cache. Re-dated 2026-07-13 when live discovery
 * (below) was wired up; the entries themselves are still only cross-checked
 * against the direct Anthropic API's /v1/models response and OpenAI's
 * published model docs, not against a live Copilot subscription's actual
 * /models response (no Copilot subscription was available in this
 * environment to verify against). `refreshModels()` replaces this list with
 * the subscription's real available model ids the first time it runs
 * successfully against real credentials.
 */
export const COPILOT_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'gpt-5.6',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5.4',
  'o1',
  'o1-mini',
  'o3-mini',
];
export const COPILOT_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

interface CachedCopilotToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly updatedAt: number;
}

export interface GitHubCopilotProviderOptions {
  readonly tokenCachePath: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  /**
   * Absolute path to this provider's on-disk live-model-list cache file
   * (see `getProviderModelsCachePath`). Optional: when omitted,
   * `refreshModels()` still works but runs in-memory only for the lifetime
   * of this instance (no TTL skip across restarts).
   */
  readonly modelsCachePath?: string | undefined;
}

export function getGitHubCopilotTokenCachePath(cacheDir: string): string {
  return join(cacheDir, 'credentials', 'github-copilot.token.json');
}

function readFirstEnv(envVars: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (const envVar of envVars) {
    const value = env[envVar]!;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildCopilotIdeHeaders(includeApiVersion = false): Record<string, string> {
  return {
    'Editor-Version': COPILOT_EDITOR_VERSION,
    'User-Agent': COPILOT_USER_AGENT,
    ...(includeApiVersion ? { 'X-Github-Api-Version': COPILOT_GITHUB_API_VERSION } : {}),
  };
}

function hasCopilotVisionInput(messages: ChatRequest['messages']): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image'));
}

function buildCopilotDynamicHeaders(messages: ChatRequest['messages']): Record<string, string> {
  const last = messages[messages.length - 1];
  const initiator = last && last.role !== 'user' ? 'agent' : 'user';
  return {
    ...buildCopilotIdeHeaders(false),
    'X-Initiator': initiator,
    'Openai-Intent': 'conversation-edits',
    ...(hasCopilotVisionInput(messages) ? { 'Copilot-Vision-Request': 'true' } : {}),
  };
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): { token: string; expiresAt: number } {
  if (!value || typeof value !== 'object') {
    throw new Error('Unexpected response from GitHub Copilot token endpoint');
  }
  const record = value as Record<string, unknown>;
  const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
  const rawExpiresAt = record['expires_at'];
  if (!token) throw new Error('Copilot token response missing token');
  let expiresAt: number;
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    expiresAt = rawExpiresAt < 100_000_000_000 ? rawExpiresAt * 1000 : rawExpiresAt;
  } else if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim()) {
    const parsed = Number.parseInt(rawExpiresAt.trim(), 10);
    if (!Number.isFinite(parsed)) throw new Error('Copilot token response has invalid expires_at');
    expiresAt = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  } else {
    throw new Error('Copilot token response missing expires_at');
  }
  return { token, expiresAt };
}

function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const match = token.trim().match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return null;
  const candidate = /^https?:\/\//i.test(proxyEp) ? proxyEp : `https://${proxyEp}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.replace(/^proxy\./i, 'api.');
    return `https://${host}`;
  } catch {
    return null;
  }
}

function parseCachedCopilotToken(value: unknown): CachedCopilotToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<CachedCopilotToken>;
  if (typeof record.token !== 'string' || record.token.trim().length === 0) return null;
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return null;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  return {
    token: record.token,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
  };
}

async function resolveCopilotToken(options: GitHubCopilotProviderOptions): Promise<{ token: string; baseUrl: string; expiresAt: number }> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const githubToken = readFirstEnv(COPILOT_TOKEN_ENV_VARS, env);
  if (!githubToken) {
    throw new Error('GitHub Copilot requires COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.');
  }

  const cachePath = options.tokenCachePath;
  if (existsSync(cachePath)) {
    try {
      const cached = parseCachedCopilotToken(JSON.parse(readFileSync(cachePath, 'utf-8')));
      if (cached && isTokenUsable(cached)) {
        return {
          token: cached.token,
          baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
          expiresAt: cached.expiresAt,
        };
      }
      if (!cached) {
        logger.warn('[github-copilot] Ignoring malformed token cache', { cachePath });
      }
    } catch (error) {
      logger.warn('[github-copilot] Token cache load failed', {
        cachePath,
        error: summarizeError(error),
      });
    }
  }

  const response = await fetchFn(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      ...buildCopilotIdeHeaders(true),
    },
  });
  if (!response.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${response.status}`);
  }
  const parsed = parseCopilotTokenResponse(await response.json());
  const cachePayload: CachedCopilotToken = {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cachePayload, null, 2));
  return {
    token: parsed.token,
    baseUrl: deriveCopilotApiBaseUrlFromToken(parsed.token) ?? DEFAULT_COPILOT_API_BASE_URL,
    expiresAt: parsed.expiresAt,
  };
}

function usesAnthropicTransport(model: string): boolean {
  return model.trim().toLowerCase().includes('claude');
}

interface CopilotModelCapabilities {
  readonly type?: unknown;
}

interface CopilotModelEntry {
  readonly id?: unknown;
  readonly capabilities?: CopilotModelCapabilities;
}

interface CopilotModelsResponse {
  readonly data?: readonly CopilotModelEntry[];
}

/**
 * Fetch GitHub Copilot's live model list: GET /models on the same
 * per-account Copilot API host (and using the same exchanged session token)
 * `resolveCopilotToken` already resolves for chat requests — no new
 * credential source, no new env vars. Verified 2026-07-13 against public,
 * independently-implemented Copilot API proxies (e.g. ericc-ch/copilot-api's
 * `getModels()`, which hits the identical `${baseUrl}/models` endpoint with
 * the same Bearer session token, Editor-Version/User-Agent headers, and a
 * `Copilot-Integration-Id` header) and against GitHub community reports of
 * `curl https://api.githubcopilot.com/models` with that same auth working
 * for the token-exchange flow — no live Copilot subscription was available
 * in this environment to call the endpoint directly. Response shape is
 * OpenAI-like (`{ data: [{ id, capabilities: { type } }] }`); only
 * `type: 'chat'` entries are kept so embedding-only models don't leak into
 * the chat model picker.
 */
async function fetchCopilotModelIds(options: GitHubCopilotProviderOptions): Promise<string[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const session = await resolveCopilotToken(options);
  const url = `${session.baseUrl.replace(/\/+$/, '')}/models`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/json',
      'Copilot-Integration-Id': 'vscode-chat',
      ...buildCopilotIdeHeaders(true),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub Copilot /models (${url}) returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as CopilotModelsResponse;
  const ids = (body.data ?? [])
    .filter((entry) => entry.capabilities?.type === undefined || entry.capabilities.type === 'chat')
    .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => id !== null && id.length > 0);
  return ids;
}

export class GitHubCopilotProvider implements LLMProvider {
  readonly name = 'github-copilot';
  readonly credentialAuthority = 'subscription' as const;
  /**
   * Live-discovery: GET /models on the Copilot API host, verified working
   * for this provider's token-exchange auth mode (see `fetchCopilotModelIds`
   * for the evidence trail). `COPILOT_DATED_STATIC_MODELS` below is the
   * offline fallback used when no GitHub token is configured or a live call
   * fails with no prior cache.
   */
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };

  /**
   * Populated synchronously with the dated-static baseline at construction
   * (never empty), then replaced by `refreshModels()` with the live /models
   * result. See `modelSource`.
   */
  private _models: string[] = [...COPILOT_DATED_STATIC_MODELS];
  get models(): string[] {
    return this._models;
  }

  constructor(private readonly options: GitHubCopilotProviderOptions) {}

  isConfigured(): boolean {
    return readFirstEnv(COPILOT_TOKEN_ENV_VARS, this.options.env ?? process.env) !== null;
  }

  /**
   * Re-check Copilot's live model list. Called at boot (background,
   * respects the on-disk TTL cache) and on-demand for a picker-open
   * re-check or an explicit user refresh (`force: true`, bypasses the TTL
   * cache). Always resolves — falls back to the on-disk cache, then to the
   * dated-static list, and reports the honest reason when live discovery
   * fails rather than silently keeping stale data with no explanation.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const result = await runLiveModelRefresh({
      providerName: this.name,
      cachePath: this.options.modelsCachePath,
      datedStaticModels: COPILOT_DATED_STATIC_MODELS,
      datedStaticAsOf: COPILOT_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchCopilotModelIds(this.options),
      force,
    });
    this._models = [...result.models];
    return result;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    try {
      const model = params.model ?? this.models[0]!;
      const session = await resolveCopilotToken(this.options);
      const baseURL = `${session.baseUrl.replace(/\/+$/, '')}/v1`;
      const defaultHeaders = buildCopilotDynamicHeaders(params.messages);
      if (usesAnthropicTransport(model)) {
        const provider = new AnthropicCompatProvider({
          name: this.name,
          baseURL,
          apiKey: session.token,
          defaultModel: model,
          models: this.models,
          defaultHeaders,
          authEnvVars: COPILOT_TOKEN_ENV_VARS,
          serviceNames: ['github-copilot'],
          authHeaderMode: 'bearer',
          streamProtocol: 'anthropic-sse',
        });
        return provider.chat({ ...params, model });
      }

      const provider = new OpenAICompatProvider({
        name: this.name,
        baseURL,
        apiKey: session.token,
        defaultModel: model,
        models: this.models,
        defaultHeaders,
        authEnvVars: COPILOT_TOKEN_ENV_VARS,
        serviceNames: ['github-copilot'],
        aliases: ['copilot'],
        streamProtocol: 'openai-sse',
      });
      return (await instrumentedLlmCall(
        () => provider.chat({ ...params, model }),
        { provider: this.name, model },
      )).result;
    } catch (error) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'chat',
      });
    }
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const configured = readFirstEnv(COPILOT_TOKEN_ENV_VARS, this.options.env ?? process.env) !== null;
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: COPILOT_TOKEN_ENV_VARS,
      secretKeys: COPILOT_TOKEN_ENV_VARS,
      serviceNames: ['github-copilot'],
    }, deps);
    return {
      auth: {
        mode: 'api-key',
        configured,
        detail: configured
          ? 'GitHub token is available for Copilot token exchange.'
          : 'Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN to use GitHub Copilot.',
        envVars: COPILOT_TOKEN_ENV_VARS,
        routes: authRoutes,
      },
      models: {
        defaultModel: this.models[0],
        models: this.models,
        aliases: ['copilot'],
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        notes: ['Claude-family Copilot models use Anthropic transport. Other models use the OpenAI-compatible Copilot endpoint.'],
      },
      policy: {
        local: false,
        streamProtocol: 'mixed:anthropic+openai',
        reasoningMode: 'provider-managed',
      },
    };
  }
}
