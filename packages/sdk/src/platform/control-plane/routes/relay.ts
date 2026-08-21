/**
 * routes/relay.ts, the handlers behind `relay.reachability.get` and
 * `relay.pairing.mint`.
 *
 * Both read the SAME controller the facade's `getRelayReachability()` hands
 * back, so an in-process surface and a client over the wire cannot disagree
 * about whether the relay is up. The controller is composed at start and torn
 * down at stop, so it is genuinely absent some of the time; absence is reported
 * as `disabled`, which is what a daemon with no relay controller is.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';

/** The controller surface these verbs need, declared rather than imported whole. */
export interface RelayReachabilityService {
  readonly status: string;
  mintPairing(): Promise<unknown>;
}

/**
 * How the verbs reach the controller. A FUNCTION, not the controller itself:
 * the daemon builds one at start and drops it at stop, so a handler holding the
 * instance would keep answering for a relay that is no longer running.
 */
export type RelayReachabilityAccessor = () => RelayReachabilityService | null;

/** All three gates open. `disabled` is the controller's word for "one is not". */
function isConfigured(service: RelayReachabilityService | null): boolean {
  return service !== null && service.status !== 'disabled';
}

function statusOf(service: RelayReachabilityService | null): string {
  return service?.status ?? 'disabled';
}

export function createRelayReachabilityHandler(accessor: RelayReachabilityAccessor): GatewayMethodHandler {
  return () => {
    const service = accessor();
    return { status: statusOf(service), configured: isConfigured(service) };
  };
}

export function createRelayPairingMintHandler(accessor: RelayReachabilityAccessor): GatewayMethodHandler {
  return async () => {
    const service = accessor();
    // Null rather than a refusal, and the status alongside it: "there is
    // nothing to pair against yet" is an answer a caller renders, and the
    // status is what tells them whether to wait or to turn the relay on.
    const pairing = service ? (await service.mintPairing()) ?? null : null;
    return { pairing, status: statusOf(service) };
  };
}

/** Every verb this module owns. */
export const RELAY_METHOD_IDS: readonly string[] = ['relay.reachability.get', 'relay.pairing.mint'];

export function registerRelayGatewayMethods(
  catalog: GatewayMethodCatalog,
  accessor: RelayReachabilityAccessor,
): void {
  const handlers: Readonly<Record<string, GatewayMethodHandler>> = {
    'relay.reachability.get': createRelayReachabilityHandler(accessor),
    'relay.pairing.mint': createRelayPairingMintHandler(accessor),
  };
  for (const id of RELAY_METHOD_IDS) {
    const descriptor = catalog.get(id);
    const handler = handlers[id];
    if (descriptor && handler) catalog.register(descriptor, handler, { replace: true });
  }
}
