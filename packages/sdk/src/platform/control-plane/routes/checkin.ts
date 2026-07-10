/**
 * routes/checkin.ts
 *
 * Handlers for the checkin.* gateway verbs over the CheckinService
 * (../../checkin). Thin verb registration: read the invocation params, call the
 * service, return its result.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { CheckinService } from '../../checkin/index.js';

export type CheckinGatewayService = Pick<CheckinService, 'getConfig' | 'setConfig' | 'listReceipts' | 'evaluate'>;

function createConfigGetHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return () => ({ config: service.getConfig() });
}

function createConfigSetHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const patch: { enabled?: boolean; cadence?: string; deliveryChannel?: string; quietHours?: string } = {};
    if (typeof params.enabled === 'boolean') patch.enabled = params.enabled;
    if (typeof params.cadence === 'string') patch.cadence = params.cadence;
    if (typeof params.deliveryChannel === 'string') patch.deliveryChannel = params.deliveryChannel;
    if (typeof params.quietHours === 'string') patch.quietHours = params.quietHours;
    if (params.enabled !== undefined && typeof params.enabled !== 'boolean') {
      throw new GatewayVerbError('enabled must be a boolean', 'INVALID_ARGUMENT', 400);
    }
    return { config: await service.setConfig(patch) };
  };
}

function createReceiptsListHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;
    return { receipts: await service.listReceipts(limit) };
  };
}

function createRunHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async () => {
    const outcome = await service.evaluate('manual');
    return {
      outcome: outcome.outcome,
      summary: outcome.summary,
      ...(outcome.deliveryId ? { deliveryId: outcome.deliveryId } : {}),
    };
  };
}

export function registerCheckinGatewayMethods(catalog: GatewayMethodCatalog, service: CheckinGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('checkin.config.get', createConfigGetHandler(service));
  attach('checkin.config.set', createConfigSetHandler(service));
  attach('checkin.receipts.list', createReceiptsListHandler(service));
  attach('checkin.run', createRunHandler(service));
}
