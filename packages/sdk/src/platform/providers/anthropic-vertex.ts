import { BaseAnthropic, type ClientOptions } from '@anthropic-ai/sdk/client';
import * as Resources from '@anthropic-ai/sdk/resources/index';
import { AuthClient, GoogleAuth } from 'google-auth-library';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.js';
import type { ProviderModelSource } from './interface.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { isRecord } from '../utils/record-coerce.js';

const DEFAULT_VERSION = 'vertex-2023-10-16';
const MODEL_ENDPOINTS = new Set(['/v1/messages', '/v1/messages?beta=true']);
const VERTEX_LIVE_FETCH_TIMEOUT_MS = 15_000;
const VERTEX_MODEL_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Dated fallback model list — used when no Google Cloud credentials are
 * configured (so a live publisher-model listing call isn't possible) and as
 * the offline baseline when a live call fails with no prior cache. Re-dated
 * 2026-07-13 when live discovery (below) was wired up; the entries
 * themselves are still only cross-checked against the direct Anthropic
 * API's /v1/models response, not against a live Vertex AI project's actual
 * publisher-model listing (no Google Cloud credentials were available in
 * this environment to verify against). `refreshModels()` replaces this list
 * with the project's real available model ids the first time it runs
 * successfully against real credentials.
 */
export const VERTEX_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];
export const VERTEX_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

interface AnthropicVertexClientOptions extends ClientOptions {
  readonly projectId?: string | null | undefined;
  readonly region?: string | null | undefined;
  readonly googleAuth?: GoogleAuth<AuthClient> | undefined;
  readonly authClient?: AuthClient | undefined;
}

type VertexRequestOptions = Parameters<BaseAnthropic['buildRequest']>[0];

function readEnv(name: string): string | null {
  return process.env[name] ?? null;
}


function resolveVertexBaseUrl(region: string): string {
  if (region === 'global') return 'https://aiplatform.googleapis.com/v1';
  if (region === 'us') return 'https://aiplatform.us.rep.googleapis.com/v1';
  if (region === 'eu') return 'https://aiplatform.eu.rep.googleapis.com/v1';
  return `https://${region}-aiplatform.googleapis.com/v1`;
}

function mergeHeaders(authHeaders: Headers, existingHeaders: unknown): Headers {
  const merged = new Headers(authHeaders);

  if (existingHeaders instanceof Headers) {
    existingHeaders.forEach((value, key) => merged.set(key, value));
    return merged;
  }

  if (Array.isArray(existingHeaders)) {
    for (const entry of existingHeaders) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const [key, value] = entry;
        if (typeof key === 'string' && typeof value === 'string') {
          merged.set(key, value);
        }
      }
    }
    return merged;
  }

  if (isRecord(existingHeaders)) {
    for (const [key, value] of Object.entries(existingHeaders)) {
      if (typeof value === 'string') {
        merged.set(key, value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') merged.append(key, item);
        }
      }
    }
  }

  return merged;
}

class AnthropicVertexClient extends BaseAnthropic {
  readonly messages: Resources.Messages;
  readonly beta: Resources.Beta;

  private readonly region: string;
  private projectId: string | null;
  private readonly authClientPromise: Promise<AuthClient>;

  constructor({
    baseURL = readEnv('ANTHROPIC_VERTEX_BASE_URL'),
    region = readEnv('CLOUD_ML_REGION'),
    projectId = readEnv('ANTHROPIC_VERTEX_PROJECT_ID'),
    googleAuth,
    authClient,
    ...options
  }: AnthropicVertexClientOptions = {}) {
    const resolvedRegion = region ?? 'global';
    super({
      baseURL: baseURL ?? resolveVertexBaseUrl(resolvedRegion),
      ...options,
    });

    if (authClient && googleAuth) {
      throw new Error('Provide either authClient or googleAuth for Anthropic Vertex, not both.');
    }

    this.messages = makeMessagesResource(this);
    this.beta = makeBetaResource(this);
    this.region = resolvedRegion;
    this.projectId = projectId;
    this.authClientPromise = authClient
      ? Promise.resolve(authClient)
      : (googleAuth ?? new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })).getClient();
  }

  protected override validateHeaders(): void {
    // Vertex auth headers are resolved asynchronously in prepareOptions.
  }

  protected override async prepareOptions(options: VertexRequestOptions): Promise<void> {
    const authClient = await this.authClientPromise;
    const authHeaders = await authClient.getRequestHeaders();
    const credentialProjectId = authClient.projectId ?? authHeaders.get('x-goog-user-project');
    if (!this.projectId && credentialProjectId) {
      this.projectId = credentialProjectId;
    }
    options.headers = mergeHeaders(authHeaders, options.headers);
  }

  override async buildRequest(
    options: VertexRequestOptions,
    context?: { retryCount?: number },
  ) {
    if (isRecord(options.body)) {
      options.body = { ...options.body };
    }

    if (isRecord(options.body) && !options.body['anthropic_version']) {
      options.body['anthropic_version'] = DEFAULT_VERSION;
    }

    if (MODEL_ENDPOINTS.has(options.path) && options.method === 'post') {
      if (!this.projectId) {
        throw new Error(
          'No projectId was given and it could not be resolved from credentials. '
          + 'Set ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GOOGLE_CLOUD_PROJECT_ID.',
        );
      }
      if (!isRecord(options.body)) {
        throw new Error('Expected request body to be an object for Vertex messages requests.');
      }
      const model = options.body['model'];
      if (typeof model !== 'string' || model.length === 0) {
        throw new Error('Expected request body to include a non-empty Vertex model string.');
      }
      options.body['model'] = undefined;
      const stream = options.body['stream'] ?? false;
      const specifier = stream ? 'streamRawPredict' : 'rawPredict';
      options.path = `/projects/${this.projectId}/locations/${this.region}/publishers/anthropic/models/${model}:${specifier}`;
    }

    if (
      options.path === '/v1/messages/count_tokens'
      || (options.path === '/v1/messages/count_tokens?beta=true' && options.method === 'post')
    ) {
      if (!this.projectId) {
        throw new Error(
          'No projectId was given and it could not be resolved from credentials. '
          + 'Set ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GOOGLE_CLOUD_PROJECT_ID.',
        );
      }
      options.path = `/projects/${this.projectId}/locations/${this.region}/publishers/anthropic/models/count-tokens:rawPredict`;
    }

    return super.buildRequest(options, context);
  }
}

function makeMessagesResource(client: BaseAnthropic): Resources.Messages {
  const resource = new Resources.Messages(client);
  // Vertex does not expose Anthropic message batches.
  delete (resource as { batches?: unknown }).batches;
  return resource;
}

function makeBetaResource(client: BaseAnthropic): Resources.Beta {
  const resource = new Resources.Beta(client);
  // Vertex does not expose Anthropic beta message batches.
  delete (resource.messages as { batches?: unknown }).batches;
  return resource;
}

function resolveVertexProjectId(): string | null {
  return process.env['ANTHROPIC_VERTEX_PROJECT_ID']
    ?? process.env['GOOGLE_CLOUD_PROJECT']
    ?? process.env['GOOGLE_CLOUD_PROJECT_ID']
    ?? null;
}

function hasVertexCredentials(): boolean {
  return Boolean(
    resolveVertexProjectId()
    && (process.env['GOOGLE_APPLICATION_CREDENTIALS'] || process.env['ANTHROPIC_VERTEX_USE_GCP_METADATA'] === '1'),
  );
}

interface VertexPublisherModelSummary {
  readonly name?: unknown;
}

interface VertexListPublisherModelsResponse {
  readonly publisherModels?: readonly VertexPublisherModelSummary[];
}

/**
 * Fetch Vertex AI's live Anthropic publisher-model list: GET
 * /publishers/anthropic/models on the same regional aiplatform host (via
 * `resolveVertexBaseUrl`) the runtime `AnthropicVertexClient` already talks
 * to. Auth reuses the exact same mechanism `AnthropicVertexClient.
 * prepareOptions` uses for every chat request: a fresh `GoogleAuth` client
 * with the same cloud-platform scope, `getRequestHeaders()` for the
 * Authorization header — no new credential source, no new env vars. Each
 * publisher model's resource name looks like
 * `publishers/anthropic/models/claude-sonnet-4-6` (sometimes with an
 * `@<version>` suffix for a pinned version); only the bare model id after
 * the last path segment is kept, matching the ids this provider's `models`
 * list already uses.
 *
 * `authClient` is an injection seam mirroring `AnthropicVertexClientOptions.
 * authClient` (the same override the runtime chat client already accepts):
 * production code leaves it unset and a fresh `GoogleAuth` client is built;
 * callers that already hold a resolved `AuthClient` (or a test double) can
 * pass one in directly instead of triggering a new ADC/ metadata-server
 * lookup.
 */
async function fetchVertexModelIds(authClient?: Pick<AuthClient, 'getRequestHeaders'>): Promise<string[]> {
  const region = process.env['GOOGLE_CLOUD_LOCATION'] ?? process.env['CLOUD_ML_REGION'] ?? 'global';
  const url = `${resolveVertexBaseUrl(region)}/publishers/anthropic/models`;
  const client = authClient ?? await new GoogleAuth({ scopes: VERTEX_MODEL_SCOPE }).getClient();
  const authHeaders = await client.getRequestHeaders();
  const headers: Record<string, string> = { Accept: 'application/json' };
  authHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  const res = await fetchWithTimeout(url, { headers }, VERTEX_LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`Vertex publisher model listing (${url}) returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as VertexListPublisherModelsResponse;
  const ids = (body.publisherModels ?? [])
    .map((summary) => {
      if (typeof summary.name !== 'string' || summary.name.length === 0) return null;
      const bareName = summary.name.replace(/^publishers\/anthropic\/models\//, '');
      return bareName.replace(/@.*$/, '');
    })
    .filter((id): id is string => id !== null && id.length > 0);
  // De-dup: a versioned pin ("claude-sonnet-4-6@20250514") and its bare
  // alias ("claude-sonnet-4-6") both reduce to the same id above.
  return Array.from(new Set(ids));
}

export class AnthropicVertexProvider extends AnthropicSdkProvider {
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  private readonly modelsCachePath: string | undefined;
  private readonly discoveryAuthClient: Pick<AuthClient, 'getRequestHeaders'> | undefined;

  /**
   * @param discoveryAuthClient Optional override for the `AuthClient` used
   * by `refreshModels()`'s live publisher-model listing (see
   * `fetchVertexModelIds`). Production callers leave this unset.
   */
  constructor(modelsCachePath?: string, discoveryAuthClient?: Pick<AuthClient, 'getRequestHeaders'>) {
    const configured = hasVertexCredentials();
    super({
      name: 'anthropic-vertex',
      label: 'Anthropic Vertex',
      defaultModel: 'claude-sonnet-4-6',
      models: [...VERTEX_DATED_STATIC_MODELS],
      createClient: () => new AnthropicVertexClient({
        projectId: resolveVertexProjectId(),
        region: process.env['GOOGLE_CLOUD_LOCATION'] ?? process.env['CLOUD_ML_REGION'] ?? 'global',
      }),
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'Google Cloud Vertex credentials are available for Anthropic Vertex.'
          : 'Configure project ID plus GOOGLE_APPLICATION_CREDENTIALS or metadata-based auth for Anthropic Vertex.',
        envVars: [
          'ANTHROPIC_VERTEX_PROJECT_ID',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_PROJECT_ID',
          'GOOGLE_CLOUD_LOCATION',
          'CLOUD_ML_REGION',
          'GOOGLE_APPLICATION_CREDENTIALS',
          'ANTHROPIC_VERTEX_USE_GCP_METADATA',
        ],
        allowAnonymous: true,
        anonymousConfigured: Boolean(resolveVertexProjectId()),
        anonymousDetail: 'Anthropic Vertex can use Google ADC or workload identity without a stored API key.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Anthropic Vertex is backed by Google ADC / Vertex auth rather than a provider API key.'],
    });
    this.modelsCachePath = modelsCachePath;
    this.discoveryAuthClient = discoveryAuthClient;
  }

  isConfigured(): boolean {
    return hasVertexCredentials();
  }

  /**
   * Re-check Vertex's live Anthropic publisher-model list. Called at boot
   * (background, respects the on-disk TTL cache) and on-demand for a
   * picker-open re-check or an explicit user refresh (`force: true`,
   * bypasses the TTL cache). Always resolves — falls back to the on-disk
   * cache, then to the dated-static list, and reports the honest reason
   * when live discovery fails rather than silently keeping stale data with
   * no explanation.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const result = await runLiveModelRefresh({
      providerName: this.name,
      cachePath: this.modelsCachePath,
      datedStaticModels: VERTEX_DATED_STATIC_MODELS,
      datedStaticAsOf: VERTEX_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchVertexModelIds(this.discoveryAuthClient),
      force,
    });
    this.models.length = 0;
    this.models.push(...result.models);
    return result;
  }
}
