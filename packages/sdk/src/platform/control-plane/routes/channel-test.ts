/**
 * routes/channel-test.ts
 *
 * Handler for `channels.test.send` — a live per-channel test-message probe over
 * the daemon's own `ChannelDeliveryRouter`. Registered from
 * register-gateway-verb-groups when the delivery router is present (the same
 * composition root that wires ci and checkin), so the daemon — which owns the
 * delivery/retest lifecycle — is authoritative over whether a channel actually
 * sends.
 *
 * Honesty contract: the router throws when a target is unsupported (no strategy
 * for the surface) or a strategy's delivery fails. Those are caught and surfaced
 * as a structured `delivered:false` outcome carrying the real error string — a
 * 200 body the caller can branch on, NOT a fabricated success and NOT a blanket
 * 500. Only a missing/invalid `surface` argument is a thrown 400.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { ChannelDeliveryRouter } from '../../channels/delivery-router.js';
import type { ChannelDeliveryTarget } from '../../channels/delivery/types.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The delivery surface `channels.test.send` needs — just `deliver`. */
export type ChannelTestDeliveryRouter = Pick<ChannelDeliveryRouter, 'deliver'>;

const DEFAULT_TEST_TITLE = 'GoodVibes channel test';
const DEFAULT_TEST_BODY =
  'This is a GoodVibes test message confirming this channel can deliver. If you can read it, delivery works.';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createChannelTestSendHandler(router: ChannelTestDeliveryRouter): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surface = requiredString(params.surface, 'surface');
    const address = optionalString(params.address);
    const body = optionalString(params.body) ?? DEFAULT_TEST_BODY;

    const target: ChannelDeliveryTarget = {
      kind: 'surface',
      surfaceKind: surface as ChannelDeliveryTarget['surfaceKind'],
      ...(address ? { address } : {}),
    };

    try {
      const responseId = await router.deliver({
        target,
        body,
        title: DEFAULT_TEST_TITLE,
        jobId: 'channel-test',
        runId: `channel-test-${Date.now()}`,
        includeLinks: false,
      });
      return {
        surface,
        delivered: true,
        ...(responseId ? { responseId } : {}),
        ...(address ? { address } : {}),
      };
    } catch (err: unknown) {
      return {
        surface,
        delivered: false,
        ...(address ? { address } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Attach the `channels.test.send` handler to its already-registered descriptor.
 * A missing descriptor is a silent no-op (mirrors the checkpoints/fleet
 * registration sites).
 */
export function registerChannelTestGatewayMethods(catalog: GatewayMethodCatalog, router: ChannelTestDeliveryRouter): void {
  const descriptor = catalog.get('channels.test.send');
  if (descriptor) catalog.register(descriptor, createChannelTestSendHandler(router), { replace: true });
}
