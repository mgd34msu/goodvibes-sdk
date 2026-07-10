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
import { registerSkillsGatewayMethods } from './skills.js';
import { registerPrincipalsGatewayMethods } from './principals.js';
import { PrincipalRegistry, PrincipalStore } from '../../principals/index.js';
import { registerChannelProfilesGatewayMethods } from './channel-profiles.js';
import { ChannelProfileRegistry, ChannelProfileStore } from '../../channel-profiles/index.js';
import { registerCheckinGatewayMethods } from './checkin.js';
import {
  CheckinService,
  CheckinReceiptStore,
  createProviderBackedCheckinJudge,
  createRuntimeCheckinStateReader,
  type CheckinSessionView,
} from '../../checkin/index.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { AutomationManager } from '../../automation/index.js';
import type { ChannelDeliveryRouter } from '../../channels/delivery-router.js';
import type { ChannelDeliveryTarget } from '../../channels/delivery/types.js';
import { createSessionRuntimeControls, registerSessionRuntimeGatewayMethods } from './session-runtime.js';
import type { ConfigManager } from '../../config/manager.js';
import type { RuntimeStore } from '../../runtime/store/index.js';
import { FileSystemSkillStore, SkillService } from '../../skills/index.js';
import {
  PushService,
  PushSubscriptionStore,
  VapidManager,
  type ApprovalSource,
  type FleetNotice,
  type FleetNoticeSource,
  type NeedsInputPresence,
  type VapidSecretStore,
} from '../../push/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { FleetEvent } from '../../../events/fleet.js';

export interface GatewayVerbGroupDeps extends W3S2GatewayDeps {
  /** SecretsManager (get/set) — VAPID keypair custody lives here, never in config. */
  readonly secretsManager: VapidSecretStore;
  /** The approval broker — the real event source push fans out from. */
  readonly approvalBroker: ApprovalSource;
  /** Home-scoped path service; the subscription store file resolves under it. */
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  /** Optional VAPID JWT `sub` contact. */
  readonly vapidSubject?: string | undefined;
  /**
   * Optional: the runtime event bus. When present, a fleet node that becomes
   * blocked on the operator fans out as a 'needs-input' push (the poll-free
   * counterpart to the approval source above). Absent → no needs-input pushes
   * (graceful degrade); every other verb group is unaffected.
   */
  readonly runtimeBus?: Pick<RuntimeEventBus, 'onDomain'> | undefined;
  /**
   * Optional: operator presence lookup. When present, a needs-input push is
   * suppressed while an operator surface is actively attached to that node's
   * session (someone is already looking). Absent → every needs-input block
   * pushes.
   */
  readonly sessionPresence?: NeedsInputPresence | undefined;
  /**
   * Config surface backing the session-scoped permission-mode verbs
   * (sessions.permissionMode.get/set): the daemon's own `permissions.mode`
   * read/write. A set flows to surfaces as runtime.permissions via the
   * already-wired mode-change binding.
   */
  readonly configManager: Pick<ConfigManager, 'get' | 'set'>;
  /**
   * Runtime store backing sessions.contextUsage.get and the local-session
   * resolution the session-runtime verbs gate on (getState().session.id).
   */
  readonly runtimeStore: Pick<RuntimeStore, 'getState'>;
  /**
   * The following three are wired only by the full runtime-services composition
   * root; when any is absent (e.g. the terminal-shell embed) the proactive
   * check-in verb group is simply not registered — a graceful degrade, exactly
   * like the runtimeBus-gated needs-input push source above.
   */
  readonly channelDeliveryRouter?: Pick<ChannelDeliveryRouter, 'deliver'> | undefined;
  readonly providerRegistry?: ProviderRegistry | undefined;
  readonly automationManager?:
    | Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'setEnabled' | 'attachCheckinEvaluator' | 'listRuns'>
    | undefined;
  /** A read-only session lister for the check-in briefing (the full SharedSessionBroker satisfies it). */
  readonly sessionLister?: { listSessions(limit?: number): readonly CheckinSessionView[] } | undefined;
}

/** Adapt a fleet event payload down to the structural notice the push source needs. */
function toFleetNotice(event: FleetEvent): FleetNotice {
  return {
    type: event.type,
    nodeId: event.nodeId,
    ...('label' in event && event.label ? { label: event.label } : {}),
    ...('reason' in event && event.reason ? { reason: event.reason } : {}),
    ...('sessionId' in event && event.sessionId ? { sessionId: event.sessionId } : {}),
  };
}

export function registerGatewayVerbGroups(catalog: GatewayMethodCatalog, deps: GatewayVerbGroupDeps): void {
  registerW3S2GatewayMethods(catalog, deps);

  // The canonical skill service over a directory of Markdown documents under the
  // daemon's own state directory. Constructed here (from the shellPaths this
  // registrar already receives) rather than threaded through the runtime-services
  // composition root, exactly like the push group below.
  const skillService = new SkillService(
    new FileSystemSkillStore(deps.shellPaths.resolveUserPath('skills')),
  );
  registerSkillsGatewayMethods(catalog, skillService);

  // The cross-channel principal identity registry over a JSON snapshot under the
  // daemon's own control-plane state directory. Constructed here (from the
  // shellPaths this registrar already receives) rather than threaded through the
  // runtime-services composition root, exactly like the skill/push groups.
  const principalRegistry = new PrincipalRegistry(
    new PrincipalStore(deps.shellPaths.resolveUserPath('control-plane', 'principals.json')),
  );
  registerPrincipalsGatewayMethods(catalog, principalRegistry);

  // Per-channel profile bindings (model/permission defaults for the sessions a
  // channel originates), over a JSON snapshot under the daemon's control-plane
  // state directory. Constructed here like the principal/skill/push groups. The
  // intake helpers in ../../channel-profiles (attribution + profile resolution)
  // pair this registry with the principal registry above at the inbound seam.
  const channelProfileRegistry = new ChannelProfileRegistry(
    new ChannelProfileStore(deps.shellPaths.resolveUserPath('control-plane', 'channel-profiles.json')),
  );
  registerChannelProfilesGatewayMethods(catalog, channelProfileRegistry);

  // Proactive check-in (the "heartbeat initiative"): a briefing→judgment→
  // conditional-delivery loop that rides the automation scheduler as a
  // kind:'checkin' job. Registered only when the full runtime wired the channel
  // delivery router, provider registry, and automation manager (the pieces the
  // loop genuinely needs); absent → the verbs stay cataloged-but-unhandled,
  // never a facade that pretends to deliver.
  if (deps.channelDeliveryRouter && deps.providerRegistry && deps.automationManager && deps.sessionLister) {
    const channelDeliveryRouter = deps.channelDeliveryRouter;
    const automation = deps.automationManager;
    const sessionLister = deps.sessionLister;
    // The checkin.* keys are string-keyed (they live in the config defaults tree,
    // not the grandfathered ConfigKey union); adapt the daemon's ConfigManager to
    // the check-in's string-keyed config surface.
    const configManager = deps.configManager;
    const checkinConfig = {
      get: (key: string): unknown => (configManager.get as unknown as (k: string) => unknown)(key),
      set: (key: string, value: string | boolean): void =>
        (configManager.set as unknown as (k: string, v: string | boolean) => void)(key, value),
    };
    const checkinService = new CheckinService({
      config: checkinConfig,
      stateReader: createRuntimeCheckinStateReader({
        listSessions: () => sessionLister.listSessions(500),
        listRuns: () => automation.listRuns(),
      }),
      judge: createProviderBackedCheckinJudge(deps.providerRegistry),
      deliverer: {
        deliver: async (channel, message) => {
          const separator = channel.indexOf(':');
          const surfaceKind = (separator === -1 ? channel : channel.slice(0, separator)).trim();
          const address = separator === -1 ? '' : channel.slice(separator + 1).trim();
          const target: ChannelDeliveryTarget = {
            kind: 'surface',
            surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'],
            ...(address ? { address } : {}),
          };
          return channelDeliveryRouter.deliver({
            target,
            body: message,
            title: 'Check-in',
            jobId: 'checkin',
            runId: `checkin-${Date.now()}`,
            includeLinks: false,
          });
        },
      },
      receipts: new CheckinReceiptStore(deps.shellPaths.resolveUserPath('control-plane', 'checkin-receipts.json')),
      automation,
    });
    registerCheckinGatewayMethods(catalog, checkinService);
    void checkinService.attach().catch(() => {
      // Automation may be disabled at construction; the schedule syncs on the
      // next checkin.config.set once it is enabled. Never fail construction.
    });
  }

  // Session-scoped permission mode (get/set) + context-usage exposure on the
  // wire, over the daemon's own config + runtime store (its live local
  // runtime). Constructed here rather than threaded through the runtime-
  // services composition root, exactly like the skill/push groups above.
  registerSessionRuntimeGatewayMethods(
    catalog,
    createSessionRuntimeControls({ config: deps.configManager, store: deps.runtimeStore }),
  );

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

  // Second event source: a fleet node blocked on the operator -> a 'needs-input'
  // push carrying the session/node deep link, suppressed when an operator is
  // already attached to that session. Only when the runtime bus is wired.
  if (deps.runtimeBus) {
    const bus = deps.runtimeBus;
    const source: FleetNoticeSource = {
      subscribe: (listener) => bus.onDomain('fleet', (envelope) => listener(toFleetNotice(envelope.payload))),
    };
    pushService.attachFleetNeedsInputSource(source, deps.sessionPresence);
  }
}
