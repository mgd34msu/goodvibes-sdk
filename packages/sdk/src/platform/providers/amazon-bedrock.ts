import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
// The exact SigV4 signer AnthropicBedrock itself calls internally
// (core/auth.js's `getAuthHeaders`) to sign runtime `invoke` requests against
// `bedrock-runtime.<region>.amazonaws.com`. Reused here, unmodified, to sign
// a GET against the control-plane `bedrock.<region>.amazonaws.com` host
// instead — same AWS service ('bedrock'), same credential resolution,
// different path.
import { getAuthHeaders } from '@anthropic-ai/bedrock-sdk/core/auth.js';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.js';
import type { ProviderModelSource } from './interface.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';
import { fetchWithTimeout, instrumentedFetch } from '../utils/fetch-with-timeout.js';

const BEDROCK_LIVE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Dated fallback model list — used when no AWS credentials are configured
 * (so a live ListFoundationModels call isn't possible) and as the offline
 * baseline when a live call fails with no prior cache. Re-dated 2026-07-13
 * when live discovery (below) was wired up; the entries themselves are still
 * only cross-checked against the direct Anthropic API's /v1/models response,
 * not against a live Bedrock account's actual ListFoundationModels output
 * (no AWS credentials were available in this environment to verify against).
 * `refreshModels()` replaces this list with the account's real model ids the
 * first time it runs successfully against real credentials.
 */
export const BEDROCK_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];
export const BEDROCK_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

function hasAwsCredentials(): boolean {
  return Boolean(
    process.env['AWS_BEARER_TOKEN_BEDROCK']
    || (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
    || process.env['AWS_PROFILE'],
  );
}

function resolveBedrockRegion(): string {
  return process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

interface BedrockModelLifecycle {
  readonly status?: unknown;
}

interface BedrockModelSummary {
  readonly modelId?: unknown;
  readonly providerName?: unknown;
  readonly outputModalities?: unknown;
  readonly responseStreamingSupported?: unknown;
  readonly modelLifecycle?: BedrockModelLifecycle;
}

interface BedrockListFoundationModelsResponse {
  readonly modelSummaries?: readonly BedrockModelSummary[];
}

/**
 * Fetch Amazon Bedrock's live foundation-model list: GET /foundation-models
 * on the `bedrock.<region>.amazonaws.com` control-plane host (distinct from
 * the `bedrock-runtime.<region>.amazonaws.com` host chat requests use). Auth
 * mirrors `AnthropicBedrock` exactly: the bearer-token path when
 * AWS_BEARER_TOKEN_BEDROCK is set (same header AnthropicBedrock sends as its
 * `authToken`), otherwise the same SigV4 signer against explicit
 * AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or, failing those, the AWS
 * credential provider chain (profile, IAM role, etc.) — no new credential
 * source, no new env vars.
 */
async function fetchBedrockModelIds(): Promise<string[]> {
  const region = resolveBedrockRegion();
  const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
  const bearerToken = process.env['AWS_BEARER_TOKEN_BEDROCK']?.trim();
  let headers: Record<string, string>;
  if (bearerToken) {
    headers = { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' };
  } else {
    const signed = await getAuthHeaders(
      { method: 'GET' },
      {
        url,
        regionName: region,
        awsAccessKey: process.env['AWS_ACCESS_KEY_ID']?.trim() || null,
        awsSecretKey: process.env['AWS_SECRET_ACCESS_KEY']?.trim() || null,
        awsSessionToken: process.env['AWS_SESSION_TOKEN']?.trim() || null,
      },
    );
    headers = { Accept: 'application/json', ...signed };
  }
  const res = await fetchWithTimeout(url, { headers }, BEDROCK_LIVE_FETCH_TIMEOUT_MS, instrumentedFetch);
  if (!res.ok) {
    throw new Error(`Bedrock ListFoundationModels (${url}) returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as BedrockListFoundationModelsResponse;
  const ids = (body.modelSummaries ?? [])
    .filter((summary) =>
      typeof summary.providerName === 'string'
      && summary.providerName.toLowerCase() === 'anthropic'
      && (summary.modelLifecycle?.status === undefined || summary.modelLifecycle.status === 'ACTIVE')
      && Array.isArray(summary.outputModalities) && summary.outputModalities.includes('TEXT')
      && summary.responseStreamingSupported === true)
    .map((summary) => (typeof summary.modelId === 'string' ? summary.modelId : null))
    .filter((id): id is string => id !== null && id.length > 0);
  return ids;
}

export class AmazonBedrockProvider extends AnthropicSdkProvider {
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  private readonly modelsCachePath: string | undefined;

  constructor(modelsCachePath?: string) {
    const configured = hasAwsCredentials();
    super({
      name: 'amazon-bedrock',
      label: 'Amazon Bedrock',
      defaultModel: 'claude-sonnet-4-6',
      models: [...BEDROCK_DATED_STATIC_MODELS],
      createClient: () => {
        const apiKey = process.env['AWS_BEARER_TOKEN_BEDROCK']?.trim();
        const awsAccessKey = process.env['AWS_ACCESS_KEY_ID']?.trim();
        const awsSecretKey = process.env['AWS_SECRET_ACCESS_KEY']?.trim();
        const awsSessionToken = process.env['AWS_SESSION_TOKEN']?.trim();
        const baseOptions = {
          ...(apiKey ? { apiKey } : {}),
          awsRegion: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
        };
        if (awsAccessKey && awsSecretKey) {
          return new AnthropicBedrock({
            ...baseOptions,
            awsAccessKey,
            awsSecretKey,
            ...(awsSessionToken ? { awsSessionToken } : {}),
          });
        }
        return new AnthropicBedrock(baseOptions);
      },
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'AWS Bedrock credentials are available through bearer token or AWS credential resolution.'
          : 'Configure AWS_BEARER_TOKEN_BEDROCK or AWS credentials/profile for Amazon Bedrock.',
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
        secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
        allowAnonymous: true,
        anonymousConfigured: Boolean(process.env['AWS_PROFILE']),
        anonymousDetail: 'The AWS credential provider chain can satisfy Bedrock auth without storing an API key in GoodVibes.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Claude-on-Bedrock models are exposed through the Anthropic Bedrock SDK.'],
    });
    this.modelsCachePath = modelsCachePath;
  }

  isConfigured(): boolean {
    return hasAwsCredentials();
  }

  /**
   * Re-check Bedrock's live foundation-model list. Called at boot
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
      datedStaticModels: BEDROCK_DATED_STATIC_MODELS,
      datedStaticAsOf: BEDROCK_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchBedrockModelIds(),
      force,
    });
    this.models.length = 0;
    this.models.push(...result.models);
    return result;
  }
}
