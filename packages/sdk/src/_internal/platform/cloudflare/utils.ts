import { summarizeError } from '../utils/error-display.js';
import { COMPONENT_ORDER, DEFAULT_COMPONENTS } from './constants.js';
import type {
  CloudflareAccountLike,
  CloudflareApiClient,
  CloudflareComponent,
  CloudflareComponentSelection,
  CloudflareKvNamespaceLike,
  CloudflarePermissionGroupLike,
  CloudflareQueueLike,
  CloudflareTokenPermissionRequirement,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';

export function resolveComponents(selection: CloudflareComponentSelection | undefined): Readonly<Record<CloudflareComponent, boolean>> {
  return COMPONENT_ORDER.reduce((components, component) => {
    components[component] = selection?.[component] ?? DEFAULT_COMPONENTS[component];
    return components;
  }, { ...DEFAULT_COMPONENTS });
}

export function buildTokenRequirements(
  components: Readonly<Record<CloudflareComponent, boolean>>,
  includeBootstrap: boolean,
): readonly CloudflareTokenPermissionRequirement[] {
  const requirements: CloudflareTokenPermissionRequirement[] = [];
  if (includeBootstrap) {
    requirements.push(
      {
        component: 'bootstrap',
        scope: 'account',
        permission: 'Account API Tokens Write',
        alternatives: ['API Tokens Write'],
        reason: 'Create the narrower GoodVibes operational token from the temporary bootstrap token.',
      },
      {
        component: 'bootstrap',
        scope: 'account',
        permission: 'Account Settings Read',
        alternatives: ['Account Read'],
        reason: 'Read the selected Cloudflare account during bootstrap validation.',
      },
    );
  }
  if (components.workers) {
    requirements.push({
      component: 'workers',
      scope: 'account',
      permission: 'Workers Scripts Write',
      alternatives: ['Workers Scripts Edit', 'Worker Scripts Write'],
      reason: 'Deploy the GoodVibes Worker bridge, install bindings, cron triggers, and Worker secrets.',
    });
  }
  if (components.queues) {
    requirements.push({
      component: 'queues',
      scope: 'account',
      permission: 'Workers Queues Write',
      alternatives: ['Queues Write', 'Cloudflare Queues Write'],
      reason: 'Create GoodVibes batch queues, dead-letter queues, and Worker consumers.',
    });
  }
  if (components.zeroTrustTunnel) {
    requirements.push({
      component: 'zeroTrustTunnel',
      scope: 'account',
      permission: 'Cloudflare Tunnel Write',
      alternatives: ['Cloudflare Tunnels Write', 'Cloudflare Tunnel Edit'],
      reason: 'Create and configure a remotely-managed Tunnel for daemon ingress.',
    });
  }
  if (components.zeroTrustAccess) {
    requirements.push(
      {
        component: 'zeroTrustAccess',
        scope: 'account',
        permission: 'Access: Apps and Policies Write',
        alternatives: ['Access Apps and Policies Write', 'Zero Trust Write'],
        reason: 'Create/update the Access application that protects the daemon hostname.',
      },
      {
        component: 'zeroTrustAccess',
        scope: 'account',
        permission: 'Access: Service Tokens Write',
        alternatives: ['Access Service Tokens Write', 'Zero Trust Service Tokens Write'],
        reason: 'Create a service token for GoodVibes daemon-to-Access authentication.',
      },
    );
  }
  if (components.dns) {
    requirements.push(
      {
        component: 'dns',
        scope: 'zone',
        permission: 'Zone Read',
        alternatives: ['Zone Settings Read'],
        reason: 'Discover/select the Cloudflare zone for GoodVibes hostnames.',
      },
      {
        component: 'dns',
        scope: 'zone',
        permission: 'DNS Write',
        alternatives: ['DNS Edit'],
        reason: 'Create or update GoodVibes CNAME records.',
      },
    );
  }
  if (components.kv) {
    requirements.push({
      component: 'kv',
      scope: 'account',
      permission: 'Workers KV Storage Write',
      alternatives: ['Workers KV Storage Edit', 'KV Storage Write'],
      reason: 'Create and bind the GoodVibes KV namespace for lightweight edge state.',
    });
  }
  if (components.durableObjects) {
    requirements.push({
      component: 'durableObjects',
      scope: 'account',
      permission: 'Workers Scripts Write',
      alternatives: ['Workers Scripts Edit', 'Worker Scripts Write'],
      reason: 'Apply the Worker migration and Durable Object binding used for edge coordination.',
    });
  }
  if (components.secretsStore) {
    requirements.push({
      component: 'secretsStore',
      scope: 'account',
      permission: 'Secrets Store Write',
      alternatives: ['Secrets Store Edit', 'Secrets Write'],
      reason: 'Create or reuse a Cloudflare Secrets Store for future account-level secrets.',
    });
  }
  if (components.r2) {
    requirements.push({
      component: 'r2',
      scope: 'r2',
      permission: 'Workers R2 Storage Write',
      alternatives: ['R2 Storage Write', 'Workers R2 Storage Edit'],
      reason: 'Create and bind a Standard R2 bucket for optional GoodVibes artifacts.',
    });
  }
  return uniqueRequirements(requirements);
}

export function selectPermissionGroups(
  requirements: readonly CloudflareTokenPermissionRequirement[],
  groups: readonly CloudflarePermissionGroupLike[],
): readonly string[] {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const names = [requirement.permission, ...(requirement.alternatives ?? [])];
    const group = groups.find((entry) => entry.id && entry.name && names.some((name) => normalizePermissionName(entry.name!) === normalizePermissionName(name)));
    if (group?.id) {
      ids.push(group.id);
    } else {
      missing.push(`${requirement.permission} (${requirement.component})`);
    }
  }
  if (missing.length > 0) {
    throw new CloudflareControlPlaneError(
      `Could not resolve Cloudflare permission groups for: ${missing.join(', ')}. Use /api/cloudflare/token/requirements to show the exact required token shape and create the operational token manually if this Cloudflare account uses different permission names.`,
      'CLOUDFLARE_PERMISSION_GROUPS_MISSING',
      400,
    );
  }
  return Array.from(new Set(ids));
}

export function buildTokenResources(
  accountId: string,
  zoneId: string | undefined,
  components: Readonly<Record<CloudflareComponent, boolean>>,
): Record<string, string> {
  const resources: Record<string, string> = {
    [`com.cloudflare.api.account.${accountId}`]: '*',
  };
  if (components.dns || components.zeroTrustAccess) {
    resources[zoneId ? `com.cloudflare.api.account.zone.${zoneId}` : 'com.cloudflare.api.account.zone.*'] = '*';
  }
  if (components.r2) {
    resources['com.cloudflare.edge.r2.bucket.*'] = '*';
  }
  return resources;
}

export async function collectSingleAccount(
  client: CloudflareApiClient,
  accountId: string,
  warnings: string[],
): Promise<readonly CloudflareAccountLike[]> {
  if (!accountId) {
    warnings.push('The Cloudflare token cannot list accounts and no accountId was supplied.');
    return [];
  }
  try {
    return [await client.accounts.get({ account_id: accountId })];
  } catch (error: unknown) {
    warnings.push(`Could not load Cloudflare account ${accountId}: ${summarizeError(error)}`);
    return [];
  }
}

export async function collectAsync<T>(iterable: AsyncIterable<T>, limit = 250): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

export function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function hostnameFromUrl(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

export function requireQueueId(queue: CloudflareQueueLike, queueName: string): string {
  if (queue.queue_id) return queue.queue_id;
  throw new CloudflareControlPlaneError(`Cloudflare Queue '${queueName}' did not include a queue_id.`, 'CLOUDFLARE_QUEUE_ID_MISSING', 502);
}

export function requireKvNamespaceId(namespace: CloudflareKvNamespaceLike): string {
  if (namespace.id) return namespace.id;
  throw new CloudflareControlPlaneError('Cloudflare KV namespace did not include an id.', 'CLOUDFLARE_KV_NAMESPACE_ID_MISSING', 502);
}

export async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function uniqueRequirements(requirements: readonly CloudflareTokenPermissionRequirement[]): readonly CloudflareTokenPermissionRequirement[] {
  const seen = new Set<string>();
  const unique: CloudflareTokenPermissionRequirement[] = [];
  for (const requirement of requirements) {
    const key = `${requirement.scope}:${requirement.permission}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(requirement);
  }
  return unique;
}

function normalizePermissionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
