import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.js';
import type { ProviderAuthRouteDescriptor, ProviderRuntimeMetadataDeps } from './interface.js';

export interface StandardProviderAuthOptions {
  readonly providerId: string;
  readonly apiKeyEnvVars?: readonly string[] | undefined;
  readonly secretKeys?: readonly string[] | undefined;
  readonly serviceNames?: readonly string[] | undefined;
  readonly subscriptionProviderId?: string | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

/**
 * The conventional API-key env var for a provider that declared none:
 * uppercase, runs of non-alphanumerics to a single underscore, `_API_KEY`
 * suffix. `abacusai` derives `ABACUSAI_API_KEY`.
 */
export function deriveProviderApiKeyEnvVar(providerId: string): string {
  const stem = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${stem}_API_KEY`;
}

function determineFreshness(expiresAt?: number): 'healthy' | 'expiring' | 'expired' {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'healthy';
  if (expiresAt <= Date.now()) return 'expired';
  if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
  return 'healthy';
}

/**
 * Fold the per-route truth into the aggregate `auth.configured` / `auth.detail`
 * pair a provider reports.
 *
 * The aggregate used to be computed from the provider's own local signal alone
 * (usually "is the API key env var set"), while the routes array right next to
 * it reported a usable subscription-oauth session. A caller reading only the
 * aggregate then saw `configured: false` with "OPENAI_API_KEY or OPENAI_KEY not
 * set" on a provider whose subscription route was healthy and serving turns.
 *
 * When the local signal says configured, it stands. Otherwise the first route
 * that is usable, or failing that the first route that is configured with a
 * real credential behind it (`freshness` not `'unconfigured'`, so a built-in
 * adapter with no stored session does not count), makes the aggregate
 * configured and the detail names that route instead of a missing env key.
 */
export function summarizeProviderAuth(
  base: { readonly configured: boolean; readonly detail: string },
  routes: readonly ProviderAuthRouteDescriptor[],
): { readonly configured: boolean; readonly detail: string } {
  if (base.configured) return base;
  const winner = routes.find((route) => route.usable === true)
    ?? routes.find((route) => route.configured && route.freshness !== 'unconfigured');
  if (winner === undefined) return base;
  return {
    configured: true,
    detail: winner.detail === undefined ? winner.label : `${winner.label}: ${winner.detail}`,
  };
}

export async function buildStandardProviderAuthRoutes(
  options: StandardProviderAuthOptions,
  deps: ProviderRuntimeMetadataDeps,
): Promise<readonly ProviderAuthRouteDescriptor[]> {
  const secretKeys = [...new Set([...(options.secretKeys ?? []), ...(options.apiKeyEnvVars ?? [])])];
  const detailedSecrets = await deps.secretsManager.listDetailed();
  const builtinSubscriptions = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const subscriptionProviderId = options.subscriptionProviderId ?? options.providerId;
  const subscription = deps.subscriptionManager.get(subscriptionProviderId);
  const pendingSubscription = deps.subscriptionManager.getPending(subscriptionProviderId);
  const hasSubscriptionRoute = builtinSubscriptions.has(subscriptionProviderId) || subscription != null || pendingSubscription != null;
  // A revocation stamp overrides the timestamp: the authorization server
  // refused this session's grant, so deriving "healthy" from expiresAt would
  // show a green light over a login every send is going to fail.
  const subscriptionFreshness = pendingSubscription
    ? 'pending'
    : subscription
      ? (subscription.revokedAt !== undefined ? 'expired' : determineFreshness(subscription.expiresAt))
      : 'unconfigured';
  const serviceNames = options.serviceNames && options.serviceNames.length > 0
    ? [...new Set(options.serviceNames)]
    : Object.values(deps.serviceRegistry.getAll())
      .filter((service) => service.authType === 'oauth' && (service.providerId ?? service.name) === options.providerId)
      .map((service) => service.name);
  const serviceInspections = await Promise.all(serviceNames.map(async (name) => ({
    name,
    inspection: await deps.serviceRegistry.inspect(name),
  })));
  const hasServiceConfig = serviceInspections.some(({ inspection }) => inspection?.config.authType === 'oauth');
  const hasUsableServiceOauth = serviceInspections.some(({ inspection }) => Boolean(inspection?.hasPrimaryCredential));

  const routes: ProviderAuthRouteDescriptor[] = [];
  const pushApiKeyRoutes = (envVars: readonly string[], keys: readonly string[]): void => {
    const matchingSecretRecords = detailedSecrets.filter((record) => keys.includes(record.key) && record.source !== 'env');
    const hasSecretRef = matchingSecretRecords.some((record) => Boolean(record.refSource));
    const hasStoredDirectSecret = matchingSecretRecords.some((record) => !record.refSource);
    const hasEnv = envVars.some((envVar) => {
      const value = process.env[envVar]!;
      return typeof value === 'string' && value.length > 0;
    });
    routes.push({
      route: 'api-key',
      label: 'Ambient API key',
      configured: hasEnv || hasStoredDirectSecret,
      usable: hasEnv || hasStoredDirectSecret,
      freshness: hasEnv || hasStoredDirectSecret ? 'healthy' : 'unconfigured',
      detail: hasEnv
        ? 'Environment-backed API key is available.'
        : hasStoredDirectSecret
          ? 'GoodVibes secret store contains a direct API key value.'
          : 'No direct API key is configured.',
      ...(envVars.length > 0 ? { envVars } : {}),
      ...(keys.length > 0 ? { secretKeys: keys } : {}),
      repairHints: [
        ...(envVars.length > 0
          ? [`Set ${envVars.join(' or ')} or store one of those keys in /secrets.`]
          : ['Store the provider API key in /secrets or the process environment.']),
      ],
    });
    routes.push({
      route: 'secret-ref',
      label: 'SecretRef-backed API key',
      configured: hasSecretRef,
      usable: hasSecretRef,
      freshness: hasSecretRef ? 'healthy' : 'unconfigured',
      detail: hasSecretRef
        ? 'A GoodVibes SecretRef is configured for this provider.'
        : 'No SecretRef-backed credential is configured.',
      ...(keys.length > 0 ? { secretKeys: keys } : {}),
      repairHints: [
        'Use /secrets link <KEY> <secret-ref> to attach Bitwarden, Vaultwarden, BWS, or another supported SecretRef.',
      ],
    });
  };
  if ((options.apiKeyEnvVars?.length ?? 0) > 0 || secretKeys.length > 0) {
    pushApiKeyRoutes(options.apiKeyEnvVars ?? [], secretKeys);
  }

  if (hasServiceConfig || serviceNames.length > 0) {
    routes.push({
      route: 'service-oauth',
      label: 'Service OAuth',
      configured: hasServiceConfig,
      usable: hasUsableServiceOauth,
      freshness: hasUsableServiceOauth ? 'healthy' : 'unconfigured',
      detail: hasUsableServiceOauth
        ? 'A service-owned OAuth credential is available for this provider.'
        : 'Service OAuth metadata exists, but the credential path is incomplete.',
      ...(serviceNames.length > 0 ? { serviceNames } : {}),
      repairHints: ['Repair the provider service credential in /services or the settings surface.'],
    });
  }

  if (hasSubscriptionRoute) {
    routes.push({
      route: 'subscription-oauth',
      label: 'Subscription OAuth',
      configured: subscription != null || pendingSubscription != null || builtinSubscriptions.has(subscriptionProviderId),
      usable: subscriptionFreshness !== 'expired' && subscriptionFreshness !== 'unconfigured',
      freshness: subscriptionFreshness,
      detail: pendingSubscription
        ? 'Subscription OAuth login is pending completion.'
        : subscription?.revokedAt !== undefined
          ? 'The provider ended this subscription session; it must be signed in again.'
          : subscription
            ? 'A stored subscription OAuth session is available for this provider.'
            : 'A built-in subscription OAuth adapter is available, but no session is stored yet.',
      providerId: subscriptionProviderId,
      repairHints: subscription?.revokedAt !== undefined
        ? [`Sign in again with /subscription login ${subscriptionProviderId} start; the stored session was ended by the provider.`]
        : [`Use /subscription login ${subscriptionProviderId} start or refresh the stored subscription session.`],
    });
  }

  if (options.allowAnonymous) {
    routes.push({
      route: 'anonymous',
      label: 'Anonymous / local access',
      configured: Boolean(options.anonymousConfigured),
      usable: Boolean(options.anonymousConfigured),
      freshness: options.anonymousConfigured ? 'healthy' : 'unconfigured',
      detail: options.anonymousDetail ?? 'This provider can be used without an API key.',
    });
  }

  if (routes.length === 0) {
    // A catalog-derived provider can arrive with no declared auth metadata at
    // all: no env vars, no secret keys, no service, no subscription, no
    // anonymous access. The old answer was a single dead-end 'none' route,
    // which meant a stored key under the provider's conventional env name
    // could never register anywhere. Such a provider now gets the api-key and
    // secret-ref routes under the derived convention, so it can be
    // credentialed and reported like any other. A provider that DOES declare
    // an auth surface (openai-codex is subscription-only by design) never
    // reaches this branch.
    const derivedEnvVar = deriveProviderApiKeyEnvVar(options.providerId);
    pushApiKeyRoutes([derivedEnvVar], [derivedEnvVar]);
  }

  return routes;
}
