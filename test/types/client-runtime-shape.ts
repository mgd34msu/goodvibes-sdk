/**
 * Compile-time pins for the pure-client composition shape.
 *
 * Three things have to stay true, and none of them can be checked at runtime:
 *
 *  1. A daemon-grade `RuntimeServices` still satisfies the SHARED part of the
 *     client shape (`ClientRuntimeServicesFromHost`), field for field, with no
 *     change to `RuntimeServices` at all. This is what makes the split additive
 *     rather than a fork: SDK code that only needs "a composition that can run a
 *     turn" takes the narrow view and accepts either graph.
 *
 *  2. The client shape does NOT require the daemon furniture, the gateway
 *     method catalog, watchers, channel delivery, automation, pairing tokens,
 *     the memory governor, so a surface can compose it without constructing
 *     any of that.
 *
 *  3. The two narrowings hold in both directions: the concrete
 *     `SharedSessionBroker` satisfies the dispatch seam and the concrete
 *     `UserPermissionRuleStore` satisfies the rule-store access, while neither
 *     narrow type is mistaken for the concrete class.
 *
 * If a member is ever added to the client shape that a daemon-grade graph does
 * not carry, pin (1) fails here and the member has to be named in
 * `ClientOnlyServiceMember` deliberately instead of drifting in.
 *
 * Everything resolves through the package NAME so the exports map is exercised
 * exactly as a consumer install would (checked by `bun run types:check`).
 */
import type { bootstrap } from '@pellux/goodvibes-sdk/platform/runtime';
import type { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { UserPermissionRuleStore } from '@pellux/goodvibes-sdk/platform/permissions';

declare function stub<T>(): T;

// (1) The daemon-grade graph satisfies the shared part of the client shape.
declare const full: bootstrap.RuntimeServices;
const sharedView: bootstrap.ClientRuntimeServicesFromHost = full;

// ...and the runtime helper agrees (it is the same assignment, given a name).
declare const asView: typeof import('@pellux/goodvibes-sdk/platform/runtime').bootstrap.asClientRuntimeView;
const sharedViewViaHelper: bootstrap.ClientRuntimeServicesFromHost = asView(full);

// (2) The client shape carries none of the daemon furniture. Each of these is a
// field `RuntimeServices` has and the client shape deliberately does not.
declare const client: bootstrap.ClientRuntimeServices;
// @ts-expect-error, a client composes no gateway method catalog (the daemon serves verbs).
const noGateway = client.gatewayMethods;
// @ts-expect-error, a client composes no watcher registry (daemon-owned).
const noWatchers = client.watcherRegistry;
// @ts-expect-error, a client composes no channel delivery router (daemon-owned).
const noDelivery = client.channelDeliveryRouter;
// @ts-expect-error, a client composes no automation manager (daemon-owned).
const noAutomation = client.automationManager;
// @ts-expect-error, a client mints no pairing tokens (daemon-owned).
const noPairing = client.pairingTokens;
// @ts-expect-error, a client runs no memory governor (one per machine, daemon-owned).
const noGovernor = client.memoryGovernor;
// @ts-expect-error, a client opens no knowledge store (daemon-hosted).
const noKnowledge = client.knowledgeService;

// ...but it does carry what a turn needs in-process.
const loopPieces: readonly unknown[] = [
  client.agentOrchestrator,
  client.agentManager,
  client.providerRegistry,
  client.permissionManager,
  client.userPermissionRuleStore,
  client.requestApproval,
  client.sessionBroker,
  client.sessionSpine,
  client.memoryAccess,
  client.workflow,
  client.mcpRegistry,
  client.fileCache,
  client.projectIndex,
] as const;

// (3a) The concrete broker satisfies the narrow dispatch seam...
const dispatchFromBroker: bootstrap.SessionContinuationDispatch = stub<SharedSessionBroker>();
// ...and so does anything else that can hand a surface its inbound work.
const dispatchFromWireClient: bootstrap.SessionContinuationDispatch = {
  setContinuationRunner: () => { /* a wire-backed inbound poller binds here */ },
};
// The reverse does NOT hold: the seam is not a broker.
// @ts-expect-error, the dispatch seam has one method; a SharedSessionBroker has the store.
const notABroker: SharedSessionBroker = stub<bootstrap.SessionContinuationDispatch>();

// (3b) The concrete durable store satisfies the narrow rule access...
const ruleAccessFromStore: bootstrap.UserPermissionRuleAccess = stub<UserPermissionRuleStore>();
// The reverse does NOT hold: read+add is not the whole store.
// @ts-expect-error, the access type has rules/add; the store also lists, deletes and initialises.
const notTheStore: UserPermissionRuleStore = stub<bootstrap.UserPermissionRuleAccess>();

export {
  sharedView,
  sharedViewViaHelper,
  noGateway,
  noWatchers,
  noDelivery,
  noAutomation,
  noPairing,
  noGovernor,
  noKnowledge,
  loopPieces,
  dispatchFromBroker,
  dispatchFromWireClient,
  notABroker,
  ruleAccessFromStore,
  notTheStore,
};
