import { summarizeError } from '../utils/error-display.js';
import type {
  CloudflareApiClient,
  CloudflareZoneLike,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import { clean, collectAsync } from './utils.js';

export async function discoverZones(
  client: CloudflareApiClient,
  input: { readonly accountId: string; readonly zoneName?: string; readonly warnings: string[] },
): Promise<readonly CloudflareZoneLike[]> {
  if (!client.zones) return [];
  return await tryDiscover('zones', input.warnings, async () => {
    const query = {
      ...(input.accountId ? { account: { id: input.accountId } } : {}),
      ...(clean(input.zoneName) ? { name: clean(input.zoneName) } : {}),
    };
    return await collectAsync(client.zones!.list(query));
  }) ?? [];
}

export async function selectDiscoveredZone(
  client: CloudflareApiClient,
  zones: readonly CloudflareZoneLike[],
  input: {
    readonly zoneId?: string;
    readonly zoneName?: string;
    readonly configuredZoneId: string;
    readonly configuredZoneName: string;
    readonly warnings: string[];
  },
): Promise<CloudflareZoneLike | undefined> {
  const zoneId = clean(input.zoneId) || input.configuredZoneId;
  if (zoneId && client.zones) {
    try {
      return await client.zones.get({ zone_id: zoneId });
    } catch (error: unknown) {
      input.warnings.push(`Could not load Cloudflare zone ${zoneId}: ${summarizeError(error)}`);
    }
  }
  const zoneName = clean(input.zoneName) || input.configuredZoneName;
  if (zoneName) return zones.find((zone) => zone.name === zoneName);
  return zones.length === 1 ? zones[0] : undefined;
}

export async function resolveZone(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly zoneId?: string;
    readonly zoneName?: string;
    readonly configuredZoneId: string;
    readonly configuredZoneName: string;
    readonly required: boolean;
  },
): Promise<CloudflareZoneLike | undefined> {
  if (!client.zones) {
    if (input.required) {
      throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zones APIs required for the requested operation.', 'CLOUDFLARE_ZONES_API_UNAVAILABLE', 500);
    }
    return undefined;
  }
  const zoneId = clean(input.zoneId) || input.configuredZoneId;
  if (zoneId) return await client.zones.get({ zone_id: zoneId });
  const zoneName = clean(input.zoneName) || input.configuredZoneName;
  const zones = await collectAsync(client.zones.list({
    ...(input.accountId ? { account: { id: input.accountId } } : {}),
    ...(zoneName ? { name: zoneName } : {}),
  }));
  if (zoneName) return zones.find((zone) => zone.name === zoneName);
  return zones.length === 1 ? zones[0] : undefined;
}

export async function tryDiscover<T>(label: string, warnings: string[], run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error: unknown) {
    warnings.push(`Could not discover Cloudflare ${label}: ${summarizeError(error)}`);
    return undefined;
  }
}
