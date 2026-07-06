/**
 * routes/register-gateway-verb-groups.ts
 *
 * One entry point the runtime-services composition root calls to attach every
 * handler-registered gateway verb group, so services.ts needs a single import
 * and a single call regardless of how many groups exist.
 *
 * It folds in the pre-existing fleet / checkpoints / sessions.search group
 * (registerW3S2GatewayMethods, unchanged) and constructs + wires the browser-
 * push group: a PushService over the subscription store and VAPID key custody,
 * its verb handlers, and — the real event source — a subscription to the
 * approval broker so an approval that needs a decision fans out as a push to the
 * operator's registered devices.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { registerW3S2GatewayMethods, type W3S2GatewayDeps } from './register-w3-s2.js';
import { registerPushGatewayMethods } from './push.js';
import {
  PushService,
  PushSubscriptionStore,
  VapidManager,
  type ApprovalSource,
  type VapidSecretStore,
} from '../../push/index.js';

export interface GatewayVerbGroupDeps extends W3S2GatewayDeps {
  /** SecretsManager (get/set) — VAPID keypair custody lives here, never in config. */
  readonly secretsManager: VapidSecretStore;
  /** The approval broker — the real event source push fans out from. */
  readonly approvalBroker: ApprovalSource;
  /** Home-scoped path service; the subscription store file resolves under it. */
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  /** Optional VAPID JWT `sub` contact. */
  readonly vapidSubject?: string | undefined;
}

export function registerGatewayVerbGroups(catalog: GatewayMethodCatalog, deps: GatewayVerbGroupDeps): void {
  registerW3S2GatewayMethods(catalog, deps);

  const pushService = new PushService({
    vapid: new VapidManager(deps.secretsManager, { subject: deps.vapidSubject }),
    store: new PushSubscriptionStore(
      deps.shellPaths.resolveUserPath('control-plane', 'push-subscriptions.json'),
    ),
  });
  registerPushGatewayMethods(catalog, pushService);
  // Real event source: approvals-needed -> push to every registered device.
  // The unsubscribe handle is intentionally not retained — the subscription
  // lives for the daemon's lifetime, exactly like the fleet/checkpoint verb
  // registrations above (there is no RuntimeServices-wide shutdown seam yet).
  pushService.attachApprovalSource(deps.approvalBroker);
}
