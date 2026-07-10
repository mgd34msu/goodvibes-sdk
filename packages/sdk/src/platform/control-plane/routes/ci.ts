/**
 * routes/ci.ts
 *
 * Handlers for the ci.* gateway verbs over the CiWatchService (../../ci-watch).
 * Thin verb registration: read params, call the service, map CiWatchError to an
 * honest wire status (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { CiWatchError, type CiWatchService } from '../../ci-watch/index.js';

export type CiWatchGatewayService = Pick<
  CiWatchService,
  'status' | 'listWatches' | 'createWatch' | 'deleteWatch' | 'checkWatch'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
};

function rethrow(error: unknown): never {
  if (error instanceof CiWatchError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function createStatusHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const report = await service.status({
        repo: requireString(params.repo, 'repo'),
        ...(optionalString(params.ref) ? { ref: optionalString(params.ref)! } : {}),
        ...(optionalNumber(params.prNumber) !== undefined ? { prNumber: optionalNumber(params.prNumber)! } : {}),
      });
      return { report };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createListHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async () => ({ watches: await service.listWatches() });
}

function createCreateHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const watch = await service.createWatch({
        repo: requireString(params.repo, 'repo'),
        ...(optionalString(params.ref) ? { ref: optionalString(params.ref)! } : {}),
        ...(optionalNumber(params.prNumber) !== undefined ? { prNumber: optionalNumber(params.prNumber)! } : {}),
        deliveryChannel: requireString(params.deliveryChannel, 'deliveryChannel'),
        triggerFixSession: params.triggerFixSession === true,
      });
      return { watch };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createDeleteHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const watchId = requireString(params.watchId, 'watchId');
    try {
      return { watchId, deleted: await service.deleteWatch(watchId) };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createRunHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const watchId = requireString(params.watchId, 'watchId');
    try {
      const result = await service.checkWatch(watchId);
      return {
        report: result.report,
        notified: result.notified,
        ...(result.notificationId ? { notificationId: result.notificationId } : {}),
        fixSessionTriggered: result.fixSessionTriggered,
        ...(result.fixSessionId ? { fixSessionId: result.fixSessionId } : {}),
      };
    } catch (error) {
      rethrow(error);
    }
  };
}

export function registerCiGatewayMethods(catalog: GatewayMethodCatalog, service: CiWatchGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('ci.status', createStatusHandler(service));
  attach('ci.watches.list', createListHandler(service));
  attach('ci.watches.create', createCreateHandler(service));
  attach('ci.watches.delete', createDeleteHandler(service));
  attach('ci.watches.run', createRunHandler(service));
}
