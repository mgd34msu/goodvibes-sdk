import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.js';
import { fetchBedrockModelIds } from './amazon-bedrock.js';
import type { ProviderModelSource } from './interface.js';
import { runLiveModelRefresh, type LiveModelDiscoveryResult } from './live-model-discovery.js';

/**
 * Dated fallback model list — used when no AWS credentials are configured
 * (so a live ListFoundationModels call isn't possible) and as the offline
 * baseline when a live call fails with no prior cache. Re-dated 2026-07-13
 * when live discovery (below) was wired up, reusing the same
 * `bedrock.<region>.amazonaws.com` ListFoundationModels control-plane call
 * `amazon-bedrock.ts` already uses (`fetchBedrockModelIds`, exported from
 * there): Bedrock Mantle shares the same AWS account's Bedrock control plane
 * as direct Bedrock, so one live fetcher covers both. The entries below are
 * still only cross-checked against the direct Anthropic API's /v1/models
 * response, not exercised against a live Bedrock Mantle account's actual
 * ListFoundationModels output — no AWS credentials were available in this
 * environment to verify against, and Bedrock Mantle's model rollout
 * typically trails the direct Anthropic API by weeks, so even a verified
 * direct-Bedrock list is not a guarantee every entry here is already live on
 * Mantle. `refreshModels()` replaces this list with the account's real model
 * ids the first time it runs successfully against real credentials.
 */
export const BEDROCK_MANTLE_DATED_STATIC_MODELS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];
export const BEDROCK_MANTLE_DATED_STATIC_MODELS_AS_OF = '2026-07-13';

function hasMantleCredentials(): boolean {
  return Boolean(
    process.env['AWS_BEARER_TOKEN_BEDROCK']
    || (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
    || process.env['AWS_PROFILE'],
  );
}

export class AmazonBedrockMantleProvider extends AnthropicSdkProvider {
  readonly modelSource: ProviderModelSource = { kind: 'live-discovery' };
  private readonly modelsCachePath: string | undefined;

  constructor(modelsCachePath?: string) {
    const configured = hasMantleCredentials();
    super({
      name: 'amazon-bedrock-mantle',
      label: 'Amazon Bedrock Mantle',
      defaultModel: 'claude-sonnet-4-6',
      models: [...BEDROCK_MANTLE_DATED_STATIC_MODELS],
      createClient: () => new AnthropicBedrockMantle({
        apiKey: process.env['AWS_BEARER_TOKEN_BEDROCK'],
        awsAccessKey: process.env['AWS_ACCESS_KEY_ID'] ?? null,
        awsSecretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? null,
        awsSessionToken: process.env['AWS_SESSION_TOKEN'] ?? null,
        awsProfile: process.env['AWS_PROFILE'],
        awsRegion: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
      }),
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'Bedrock Mantle auth is available through bearer token or AWS credential resolution.'
          : 'Configure AWS_BEARER_TOKEN_BEDROCK or AWS credentials/profile for Bedrock Mantle.',
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
        secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
        allowAnonymous: true,
        anonymousConfigured: Boolean(process.env['AWS_PROFILE']),
        anonymousDetail: 'Bedrock Mantle can also use the AWS credential provider chain.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Bedrock Mantle uses the Anthropic Bedrock Mantle SDK path.'],
    });
    this.modelsCachePath = modelsCachePath;
  }

  isConfigured(): boolean {
    return hasMantleCredentials();
  }

  /**
   * Re-check Bedrock's live foundation-model list via the same
   * ListFoundationModels control-plane call `AmazonBedrockProvider` uses
   * (`fetchBedrockModelIds`, imported from `amazon-bedrock.ts` rather than
   * duplicated here). Always resolves — falls back to the on-disk cache,
   * then to the dated-static list, and reports the honest reason when live
   * discovery fails rather than silently keeping stale data with no
   * explanation.
   */
  async refreshModels(force = false): Promise<LiveModelDiscoveryResult> {
    const result = await runLiveModelRefresh({
      providerName: this.name,
      cachePath: this.modelsCachePath,
      datedStaticModels: BEDROCK_MANTLE_DATED_STATIC_MODELS,
      datedStaticAsOf: BEDROCK_MANTLE_DATED_STATIC_MODELS_AS_OF,
      isConfigured: this.isConfigured(),
      fetchLive: () => fetchBedrockModelIds(),
      force,
    });
    this.models.length = 0;
    this.models.push(...result.models);
    return result;
  }
}
