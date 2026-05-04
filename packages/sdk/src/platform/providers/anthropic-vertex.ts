import { BaseAnthropic, type ClientOptions } from '@anthropic-ai/sdk/client';
import * as Resources from '@anthropic-ai/sdk/resources/index';
import { AuthClient, GoogleAuth } from 'google-auth-library';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.js';

const DEFAULT_VERSION = 'vertex-2023-10-16';
const MODEL_ENDPOINTS = new Set(['/v1/messages', '/v1/messages?beta=true']);

const VERTEX_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export class AnthropicVertexProvider extends AnthropicSdkProvider {
  constructor() {
    const configured = hasVertexCredentials();
    super({
      name: 'anthropic-vertex',
      label: 'Anthropic Vertex',
      defaultModel: 'claude-sonnet-4-6',
      models: VERTEX_MODELS,
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
  }
}
