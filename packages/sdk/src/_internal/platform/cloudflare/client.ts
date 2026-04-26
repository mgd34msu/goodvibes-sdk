import type { CloudflareApiClient } from './types.js';

export async function createCloudflareApiClient(apiToken: string): Promise<CloudflareApiClient> {
  const mod = await import('cloudflare');
  const Cloudflare = mod.default;
  return new Cloudflare({
    apiToken,
    maxRetries: 2,
    timeout: 30_000,
  }) as unknown as CloudflareApiClient;
}
