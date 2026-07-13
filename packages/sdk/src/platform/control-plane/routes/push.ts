/**
 * routes/push.ts
 *
 * Attaches the `push.*` gateway-method handlers to the descriptors declared in
 * ../method-catalog-push.ts. Same mechanism fleet.* uses:
 * `catalog.register(descriptor, handler)`, reached over real HTTP through the
 * generic `/api/control-plane/methods/{id}/invoke` endpoint — no new REST route
 * in the external daemon-sdk package, no router change.
 *
 * Every write is scoped to the authenticated principal (the operator identity
 * the invoke layer resolved), so one operator can neither read, delete, nor
 * test another operator's registered devices.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PushService } from '../../push/index.js';
import type { SubscriptionKeyMaterial } from '../../push/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The narrow slice of PushService these verbs need. */
export type PushGatewayService = Pick<
  PushService,
  'getPublicKey' | 'subscribe' | 'reconcile' | 'listSubscriptions' | 'unsubscribe' | 'verify'
>;

function requirePrincipal(invocation: GatewayMethodInvocation): string {
  const principalId = invocation.context.principalId;
  if (!principalId) {
    throw new GatewayVerbError('Push verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
  return principalId;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`Missing or invalid ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function requireHttpsEndpoint(value: unknown): string {
  const endpoint = requireString(value, 'endpoint');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new GatewayVerbError('endpoint is not a valid URL', 'INVALID_ARGUMENT', 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GatewayVerbError('endpoint must be an http(s) URL', 'INVALID_ARGUMENT', 400);
  }
  return endpoint;
}

function requireKeys(value: unknown): SubscriptionKeyMaterial {
  if (value === null || typeof value !== 'object') {
    throw new GatewayVerbError('Missing subscription keys', 'INVALID_ARGUMENT', 400);
  }
  const keys = value as Record<string, unknown>;
  return {
    p256dh: requireString(keys.p256dh, 'keys.p256dh'),
    auth: requireString(keys.auth, 'keys.auth'),
  };
}

function createVapidGetHandler(service: PushGatewayService): GatewayMethodHandler {
  return async () => ({ publicKey: await service.getPublicKey() });
}

function optionalDeviceId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, 'deviceId');
}

function createSubscribeHandler(service: PushGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const endpoint = requireHttpsEndpoint(params.endpoint);
    const keys = requireKeys(params.keys);
    const deviceId = optionalDeviceId(params.deviceId);
    const subscription = await service.subscribe({ principalId, deviceId, endpoint, keys });
    return { subscription };
  };
}

function createReconcileHandler(service: PushGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const endpoint = requireHttpsEndpoint(params.endpoint);
    const keys = requireKeys(params.keys);
    const deviceId = requireString(params.deviceId, 'deviceId');
    const { subscription, drift } = await service.reconcile({ principalId, deviceId, endpoint, keys });
    return { subscription, drift };
  };
}

function createListHandler(service: PushGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    return { subscriptions: await service.listSubscriptions(principalId) };
  };
}

function createDeleteHandler(service: PushGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const subscriptionId = requireString(params.subscriptionId, 'subscriptionId');
    const deleted = await service.unsubscribe(subscriptionId, principalId);
    if (!deleted) {
      throw new GatewayVerbError('Unknown push subscription', 'SUBSCRIPTION_NOT_FOUND', 404);
    }
    return { subscriptionId, deleted: true };
  };
}

function createVerifyHandler(service: PushGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const principalId = requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const subscriptionId = requireString(params.subscriptionId, 'subscriptionId');
    const receipt = await service.verify(subscriptionId, principalId);
    if (!receipt) {
      throw new GatewayVerbError('Unknown push subscription', 'SUBSCRIPTION_NOT_FOUND', 404);
    }
    return { receipt };
  };
}

const PUSH_HANDLER_FACTORIES: Readonly<Record<string, (service: PushGatewayService) => GatewayMethodHandler>> = {
  'push.vapid.get': createVapidGetHandler,
  'push.subscriptions.create': createSubscribeHandler,
  'push.subscriptions.reconcile': createReconcileHandler,
  'push.subscriptions.list': createListHandler,
  'push.subscriptions.delete': createDeleteHandler,
  'push.subscriptions.verify': createVerifyHandler,
};

/**
 * Attach the `push.*` handlers to their already-cataloged descriptors. Call
 * once, at RuntimeServices construction time, after the PushService exists. A
 * missing descriptor (contract/registration drift) is a silent no-op rather
 * than a throw — construction must never fail because one wire verb failed to
 * register; the operator-contract gates catch a real drift.
 */
export function registerPushGatewayMethods(catalog: GatewayMethodCatalog, service: PushGatewayService): void {
  for (const [methodId, factory] of Object.entries(PUSH_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(service), { replace: true });
    }
  }
}
