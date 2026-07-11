/**
 * routes/cost.ts
 *
 * Handlers for cost.attribution.get + quota.fanout.get over the daemon's
 * CostAttributionService and QuotaWindowTracker. Registered from
 * register-gateway-verb-groups.ts (the same composition root that wires
 * ci/checkin), which also feeds the services from the runtime bus.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type {
  CostAttributionService,
  CostDimension,
  CostWindow,
} from '../../runtime/cost/attribution.js';
import type { QuotaWindowTracker } from '../../runtime/cost/quota-window.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

const COST_WINDOWS: readonly CostWindow[] = ['24h', '7d'];
const COST_DIMENSIONS: readonly CostDimension[] = ['agent', 'tool', 'hook', 'mcp', 'model', 'provider', 'session'];

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new GatewayVerbError(`Invalid ${field}: ${String(value)} (expected one of ${allowed.join(', ')})`, 'INVALID_ARGUMENT', 400);
  }
  return value as T;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new GatewayVerbError(`Invalid ${field}: ${String(value)} (expected a non-negative number)`, 'INVALID_ARGUMENT', 400);
  }
  return Math.floor(n);
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePositiveInt(value, field);
}

export function createCostAttributionGetHandler(service: Pick<CostAttributionService, 'attribution'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const window = requireEnum(params.window, COST_WINDOWS, 'window');
    const dimension = requireEnum(params.dimension, COST_DIMENSIONS, 'dimension');
    return service.attribution(window, dimension);
  };
}

export function createQuotaFanoutGetHandler(tracker: Pick<QuotaWindowTracker, 'assessFanout'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const provider = requireString(params.provider, 'provider');
    const agentCount = requirePositiveInt(params.agentCount, 'agentCount');
    const callsPerAgent = optionalPositiveInt(params.callsPerAgent, 'callsPerAgent');
    return tracker.assessFanout({ provider, agentCount, callsPerAgent });
  };
}

export function createQuotaSnapshotGetHandler(tracker: Pick<QuotaWindowTracker, 'snapshot'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const provider = requireString(params.provider, 'provider');
    return tracker.snapshot(provider);
  };
}

export interface CostGatewayDeps {
  readonly costAttribution: Pick<CostAttributionService, 'attribution'>;
  readonly quotaWindow: Pick<QuotaWindowTracker, 'assessFanout' | 'snapshot'>;
}

/** Attach the cost.attribution.get + quota.fanout.get + quota.snapshot.get handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerCostGatewayMethods(catalog: GatewayMethodCatalog, deps: CostGatewayDeps): void {
  const costDescriptor = catalog.get('cost.attribution.get');
  if (costDescriptor) catalog.register(costDescriptor, createCostAttributionGetHandler(deps.costAttribution), { replace: true });

  const quotaDescriptor = catalog.get('quota.fanout.get');
  if (quotaDescriptor) catalog.register(quotaDescriptor, createQuotaFanoutGetHandler(deps.quotaWindow), { replace: true });

  const snapshotDescriptor = catalog.get('quota.snapshot.get');
  if (snapshotDescriptor) catalog.register(snapshotDescriptor, createQuotaSnapshotGetHandler(deps.quotaWindow), { replace: true });
}
