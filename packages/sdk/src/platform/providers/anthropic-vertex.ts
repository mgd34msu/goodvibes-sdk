/**
 * anthropic-vertex.ts, Claude on Google Cloud Vertex AI.
 *
 * `@anthropic-ai/sdk` and `google-auth-library` are both declared under
 * `optionalDependencies` in packages/sdk/package.json, and this file used to
 * import both as VALUES at module init: `AnthropicVertexClient extends
 * BaseAnthropic`, `new Resources.Messages(...)`, `new GoogleAuth(...)`. The
 * provider registry puts this module on the daemon's graph, so an install
 * without either package did not lose Vertex, it lost the daemon, at module
 * init, before anything could report why (see utils/optional-dependency.ts).
 *
 * A class cannot extend a dynamically imported base directly, because the
 * `extends` expression is evaluated when the class declaration is evaluated.
 * So the class is DECLARED INSIDE an async factory that is called once and
 * memoised: the declaration, and with it the `extends` expression, runs
 * after the import resolves, and every later `new` gets the same class object.
 * The type-only imports below stay type-only and are erased, so no specifier
 * for either package survives on the module graph.
 */

import type { BaseAnthropic, ClientOptions } from '@anthropic-ai/sdk/client';
import type * as Resources from '@anthropic-ai/sdk/resources/index';
import type { AuthClient, GoogleAuth } from 'google-auth-library';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.js';
import type { ProviderModelSource } from './interface.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { isRecord } from '../utils/record-coerce.js';
import { loadOptionalDependency } from '../utils/optional-dependency.js';

type AnthropicClientModule = typeof import('@anthropic-ai/sdk/client');
type AnthropicResourcesModule = typeof import('@anthropic-ai/sdk/resources/index');
type GoogleAuthModule = typeof import('google-auth-library');

/**
 * Load one optional package, or throw an error whose message says which one is
 * missing and that it is an optional dependency of the SDK. Every caller is
 * inside an async request or model-refresh path, so the throw lands on an
 * error path a person already sees.
 */
async function loadAnthropicClientModule(): Promise<AnthropicClientModule> {
  const loaded = await loadOptionalDependency(
    '@anthropic-ai/sdk/client',
    () => import('@anthropic-ai/sdk/client'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

async function loadAnthropicResourcesModule(): Promise<AnthropicResourcesModule> {
  const loaded = await loadOptionalDependency(
    '@anthropic-ai/sdk/resources/index',
    () => import('@anthropic-ai/sdk/resources/index'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

async function loadGoogleAuthLibrary(): Promise<GoogleAuthModule> {
  const loaded = await loadOptionalDependency(
    'google-auth-library',
    () => import('google-auth-library'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

/**
 * Whether the Vertex provider can run in this installation, and why not.
 *
 * Every package is checked, not just the first missing one: an install that
 * skipped both optional packages should be told about both rather than led
 * through them one error at a time.
 */
export async function describeAnthropicVertexAvailability(): Promise<{ available: boolean; reason?: string }> {
  const reasons: string[] = [];
  const client = await loadOptionalDependency('@anthropic-ai/sdk/client', () => import('@anthropic-ai/sdk/client'));
  if (!client.available) reasons.push(client.reason);
  const resources = await loadOptionalDependency(
    '@anthropic-ai/sdk/resources/index',
    () => import('@anthropic-ai/sdk/resources/index'),
  );
  if (!resources.available) reasons.push(resources.reason);
  const auth = await loadOptionalDependency('google-auth-library', () => import('google-auth-library'));
  if (!auth.available) reasons.push(auth.reason);
  return reasons.length === 0 ? { available: true } : { available: false, reason: reasons.join(' ') };
}

const DEFAULT_VERSION = 'vertex-2023-10-16';
const MODEL_ENDPOINTS = new Set(['/v1/messages', '/v1/messages?beta=true']);
const VERTEX_LIVE_FETCH_TIMEOUT_MS = 15_000;
const VERTEX_MODEL_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Dated fallback model list, used when no Google Cloud credentials are
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

/** The Vertex client's shape, independent of when its base class is built. */
export interface AnthropicVertexClientLike extends BaseAnthropic {
  readonly messages: Resources.Messages;
  readonly beta: Resources.Beta;
}

type AnthropicVertexClientConstructor =
  new (options?: AnthropicVertexClientOptions) => AnthropicVertexClientLike;

let vertexClientClass: Promise<AnthropicVertexClientConstructor> | undefined;

/**
 * The `AnthropicVertexClient` class, built once per process.
 *
 * The class is declared inside `buildAnthropicVertexClientClass` rather than at
 * module scope because `extends BaseAnthropic` is evaluated when the
 * declaration is evaluated, and `BaseAnthropic` comes from an optional package
 * that must not be resolved at module init. Memoising the promise means one
 * class object for the whole process, so `instanceof` and prototype identity
 * behave exactly as they did with a module-scope declaration.
 */
function loadAnthropicVertexClientClass(): Promise<AnthropicVertexClientConstructor> {
  vertexClientClass ??= buildAnthropicVertexClientClass();
  return vertexClientClass;
}

async function buildAnthropicVertexClientClass(): Promise<AnthropicVertexClientConstructor> {
  const { BaseAnthropic: BaseAnthropicClass } = await loadAnthropicClientModule();
  const resources = await loadAnthropicResourcesModule();
  const { GoogleAuth: GoogleAuthClass } = await loadGoogleAuthLibrary();

  function makeMessagesResource(client: BaseAnthropic): Resources.Messages {
    const resource = new resources.Messages(client);
    // Vertex does not expose Anthropic message batches.
    delete (resource as { batches?: unknown }).batches;
    return resource;
  }

  function makeBetaResource(client: BaseAnthropic): Resources.Beta {
    const resource = new resources.Beta(client);
    // Vertex does not expose Anthropic beta message batches.
    delete (resource.messages as { batches?: unknown }).batches;
    return resource;
  }

  class AnthropicVertexClient extends BaseAnthropicClass {
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
        : (googleAuth ?? new GoogleAuthClass({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })).getClient();
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

  return AnthropicVertexClient as unknown as AnthropicVertexClientConstructor;
}

/**
 * Build a Vertex client. Resolves the two optional packages first, so an
 * install without them fails this one construction with a message naming the
 * missing package rather than preventing the process from starting.
 */
export async function createAnthropicVertexClient(
  options: AnthropicVertexClientOptions = {},
): Promise<AnthropicVertexClientLike> {
  const ClientClass = await loadAnthropicVertexClientClass();
  return new ClientClass(options);
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
 * Authorization header, no new credential source, no new env vars. Each
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
  const client = authClient ?? await (async () => {
    const { GoogleAuth } = await loadGoogleAuthLibrary();
    return new GoogleAuth({ scopes: VERTEX_MODEL_SCOPE }).getClient();
  })();
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
      // Async because the client class itself is built after
      // `@anthropic-ai/sdk` and `google-auth-library` resolve; `createClient`
      // accepts a promise for exactly this.
      createClient: () => createAnthropicVertexClient({
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
   * bypasses the TTL cache). Always resolves, falls back to the on-disk
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
