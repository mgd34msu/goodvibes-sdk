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
  CloudflareResolvedPermissionGroup,
  CloudflareTokenPermissionRequirement,
  CloudflareTokenPolicyParam,
  CloudflareTokenResourceMap,
  CloudflareTokenCreateResponseLike,
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
        scope: 'user',
        permission: 'API Tokens Write',
        alternatives: ['API Tokens Edit'],
        reason: 'Create the narrower GoodVibes operational user token from the temporary bootstrap token.',
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
      permission: 'Queues Write',
      alternatives: ['Workers Queues Write', 'Cloudflare Queues Write'],
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
      permission: 'Account Secrets Store Write',
      alternatives: ['Account Secrets Store Edit', 'Secrets Store Write', 'Secrets Store Edit'],
      reason: 'Create or reuse a Cloudflare Secrets Store for future account-level secrets.',
    });
  }
  if (components.r2) {
    requirements.push({
      component: 'r2',
      scope: 'account',
      scopeAlternatives: ['com.cloudflare.edge.r2.bucket'],
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
    const group = findPermissionGroup(requirement, groups);
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

export async function resolvePermissionGroupIds(
  requirements: readonly CloudflareTokenPermissionRequirement[],
  listPermissionGroups: (params?: { readonly name?: string; readonly scope?: string }) => AsyncIterable<CloudflarePermissionGroupLike>,
): Promise<readonly string[]> {
  return (await resolvePermissionGroups(requirements, listPermissionGroups)).map((entry) => entry.id);
}

export async function resolvePermissionGroups(
  requirements: readonly CloudflareTokenPermissionRequirement[],
  listPermissionGroups: (params?: { readonly name?: string; readonly scope?: string }) => AsyncIterable<CloudflarePermissionGroupLike>,
): Promise<readonly CloudflareResolvedPermissionGroup[]> {
  const resolved: CloudflareResolvedPermissionGroup[] = [];
  const missing: string[] = [];
  let scannedGroups: readonly CloudflarePermissionGroupLike[] | null = null;
  let lastError: unknown;

  const scanAllGroups = async (): Promise<readonly CloudflarePermissionGroupLike[]> => {
    if (scannedGroups) return scannedGroups;
    scannedGroups = await collectAsync(listPermissionGroups(), 5_000);
    return scannedGroups;
  };

  for (const requirement of requirements) {
    const scopes = cloudflareScopesForRequirement(requirement);
    const names = permissionNameCandidates(requirement);
    let group: CloudflarePermissionGroupLike | undefined;

    for (const name of names) {
      if (group) break;
      try {
        for (const scope of scopes) {
          const exactMatches = await collectAsync(listPermissionGroups({ name, scope }), 50);
          group = findPermissionGroup(requirement, exactMatches);
          if (group) break;
        }
      } catch (error: unknown) {
        lastError = error;
        break;
      }
    }

    if (!group) {
      try {
        group = findPermissionGroup(requirement, await scanAllGroups());
      } catch (error: unknown) {
        lastError = error;
      }
    }

    if (group?.id) {
      resolved.push({
        id: group.id,
        requirement,
        cloudflareScope: cloudflareScopeForResolvedGroup(requirement, group),
      });
    } else {
      missing.push(`${requirement.permission} (${requirement.component})`);
    }
  }

  if (missing.length > 0) {
    const suffix = lastError ? ` Last Cloudflare permission-group error: ${summarizeError(lastError)}` : '';
    throw new CloudflareControlPlaneError(
      `Could not resolve Cloudflare permission groups for: ${missing.join(', ')}.${suffix} Use /api/cloudflare/token/requirements to show the exact required token shape and create the operational token manually if this Cloudflare account uses different permission names.`,
      'CLOUDFLARE_PERMISSION_GROUPS_MISSING',
      400,
    );
  }

  return uniqueResolvedPermissionGroups(resolved);
}

export function buildTokenPolicies(
  accountId: string,
  zoneId: string | undefined,
  groups: readonly CloudflareResolvedPermissionGroup[],
): readonly CloudflareTokenPolicyParam[] {
  const byScope = new Map<string, string[]>();
  for (const group of groups) {
    const ids = byScope.get(group.cloudflareScope) ?? [];
    ids.push(group.id);
    byScope.set(group.cloudflareScope, ids);
  }
  const policies: CloudflareTokenPolicyParam[] = [];
  addTokenPolicy(policies, byScope.get('com.cloudflare.api.account'), accountTokenResources(accountId));
  addTokenPolicy(policies, byScope.get('com.cloudflare.api.account.zone'), zoneTokenResources(accountId, zoneId));
  addTokenPolicy(policies, byScope.get('com.cloudflare.edge.r2.bucket'), { 'com.cloudflare.edge.r2.bucket.*': '*' });
  if ((byScope.get('com.cloudflare.api.user')?.length ?? 0) > 0) {
    throw new CloudflareControlPlaneError(
      'Operational Cloudflare tokens cannot include user-scoped permissions. Create the bootstrap token separately from the Cloudflare dashboard.',
      'CLOUDFLARE_USER_POLICY_UNSUPPORTED',
      400,
    );
  }
  return policies;
}

export async function verifyCreatedTokenPolicies(
  token: CloudflareTokenCreateResponseLike,
  expectedGroups: readonly CloudflareResolvedPermissionGroup[],
  loadToken?: (tokenId: string) => Promise<CloudflareTokenCreateResponseLike>,
): Promise<void> {
  const expectedIds = new Set(expectedGroups.map((group) => group.id));
  let policies = token.policies;
  if ((!policies || policies.length === 0) && token.id && loadToken) {
    policies = (await loadToken(token.id)).policies;
  }
  if (!policies) return;

  const actualIds = new Set<string>();
  for (const policy of policies) {
    for (const group of policy.permission_groups ?? []) {
      if (group.id) actualIds.add(group.id);
    }
  }
  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  if (actualIds.size === 0 || missing.length > 0) {
    throw new CloudflareControlPlaneError(
      `Cloudflare created the operational token but did not persist the expected permission policy. Missing permission group ids: ${missing.join(', ') || 'all'}. ` +
        'Delete the unusable token in Cloudflare and retry with this SDK version.',
      'CLOUDFLARE_TOKEN_POLICY_MISMATCH',
      502,
    );
  }
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

export function normalizeHostname(value: string | undefined): string {
  const trimmed = clean(value).replace(/\.+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return hostnameFromUrl(trimmed).toLowerCase();
  const withoutPath = trimmed.split('/')[0] ?? '';
  return withoutPath.split(':')[0]?.toLowerCase() ?? '';
}

export function hostnameBelongsToZone(hostname: string, zoneName: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedZone = normalizeHostname(zoneName);
  return normalizedHostname === normalizedZone || normalizedHostname.endsWith(`.${normalizedZone}`);
}

export function isPlaceholderHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'example.com' ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org') ||
    normalized.endsWith('.example.test');
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost');
}

export function deriveZoneHostname(label: string, zoneName: string): string {
  const normalizedLabel = clean(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'goodvibes';
  return `${normalizedLabel}.${normalizeHostname(zoneName)}`;
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

function uniqueResolvedPermissionGroups(groups: readonly CloudflareResolvedPermissionGroup[]): readonly CloudflareResolvedPermissionGroup[] {
  const seen = new Set<string>();
  const unique: CloudflareResolvedPermissionGroup[] = [];
  for (const group of groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    unique.push(group);
  }
  return unique;
}

function findPermissionGroup(
  requirement: CloudflareTokenPermissionRequirement,
  groups: readonly CloudflarePermissionGroupLike[],
): CloudflarePermissionGroupLike | undefined {
  const names = permissionNameCandidates(requirement).map(normalizePermissionName);
  const scopes = cloudflareScopesForRequirement(requirement);
  return groups.find((entry) =>
    entry.id &&
    entry.name &&
    names.includes(normalizePermissionName(entry.name)) &&
    matchesPermissionScope(entry, scopes),
  );
}

function matchesPermissionScope(group: CloudflarePermissionGroupLike, scopes: readonly string[]): boolean {
  return !group.scopes || group.scopes.length === 0 || group.scopes.some((scope) => scopes.includes(scope));
}

function cloudflareScopeForResolvedGroup(requirement: CloudflareTokenPermissionRequirement, group: CloudflarePermissionGroupLike): string {
  const scopes = cloudflareScopesForRequirement(requirement);
  return group.scopes?.find((scope) => scopes.includes(scope)) ?? scopes[0]!;
}

function cloudflareScopesForRequirement(requirement: CloudflareTokenPermissionRequirement): readonly string[] {
  return [cloudflareScopeForRequirement(requirement), ...(requirement.scopeAlternatives ?? [])];
}

function cloudflareScopeForRequirement(requirement: CloudflareTokenPermissionRequirement): string {
  switch (requirement.scope) {
    case 'account':
      return 'com.cloudflare.api.account';
    case 'zone':
      return 'com.cloudflare.api.account.zone';
    case 'user':
      return 'com.cloudflare.api.user';
  }
}

function normalizePermissionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function permissionNameCandidates(requirement: CloudflareTokenPermissionRequirement): readonly string[] {
  const names = new Set<string>();
  for (const name of [requirement.permission, ...(requirement.alternatives ?? [])]) {
    names.add(name);
    const editVariant = name.replace(/\bWrite\b/g, 'Edit');
    const writeVariant = name.replace(/\bEdit\b/g, 'Write');
    names.add(editVariant);
    names.add(writeVariant);
  }
  return Array.from(names);
}

function accountTokenResources(accountId: string): CloudflareTokenResourceMap {
  return { [`com.cloudflare.api.account.${accountId}`]: '*' };
}

function zoneTokenResources(accountId: string, zoneId: string | undefined): CloudflareTokenResourceMap {
  return zoneId
    ? { [`com.cloudflare.api.account.zone.${zoneId}`]: '*' }
    : { [`com.cloudflare.api.account.${accountId}`]: { 'com.cloudflare.api.account.zone.*': '*' } };
}

function addTokenPolicy(
  policies: CloudflareTokenPolicyParam[],
  ids: readonly string[] | undefined,
  resources: CloudflareTokenResourceMap,
): void {
  const uniqueIds = Array.from(new Set(ids ?? []));
  if (uniqueIds.length === 0) return;
  policies.push({
    effect: 'allow',
    permission_groups: uniqueIds.map((id) => ({ id })),
    resources,
  });
}
