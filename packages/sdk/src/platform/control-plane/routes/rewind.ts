/**
 * routes/rewind.ts
 *
 * Handlers for rewind.plan + rewind.apply over the UnifiedRewindService. Both
 * are registered together with their descriptors from
 * register-gateway-verb-groups.ts. rewind.apply follows the checkpoints.restore
 * confirm idiom: an unconfirmed call returns a non-error refusal body, a bad
 * confirm token is an honest 400.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { RewindAnchor, RewindScope } from '../../rewind/index.js';
import { RewindTokenError, type UnifiedRewindService } from '../../rewind/index.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

const REWIND_SCOPES: readonly RewindScope[] = ['files', 'conversation', 'both'];

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function requireScope(value: unknown): RewindScope {
  if (typeof value !== 'string' || !REWIND_SCOPES.includes(value as RewindScope)) {
    throw new GatewayVerbError(
      `Invalid scope: ${String(value)} (expected one of ${REWIND_SCOPES.join(', ')})`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as RewindScope;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new GatewayVerbError(`Invalid ${field}: expected a boolean`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function readAnchor(params: Record<string, unknown>): { anchor: RewindAnchor; scope: RewindScope } {
  const sessionId = requireString(params.sessionId, 'sessionId');
  const turnId = optionalString(params.turnId, 'turnId');
  const scope = requireScope(params.scope);
  return { anchor: turnId !== undefined ? { sessionId, turnId } : { sessionId }, scope };
}

export function createRewindPlanHandler(service: Pick<UnifiedRewindService, 'plan'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const { anchor, scope } = readAnchor(params);
    return service.plan(anchor, scope);
  };
}

export function createRewindApplyHandler(service: Pick<UnifiedRewindService, 'apply'>): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const { anchor, scope } = readAnchor(params);
    const confirm = optionalBoolean(params.confirm, 'confirm');
    const confirmToken = optionalString(params.confirmToken, 'confirmToken');
    try {
      return await service.apply(anchor, scope, { confirm, confirmToken });
    } catch (error) {
      if (error instanceof RewindTokenError) {
        throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400);
      }
      throw error;
    }
  };
}

/** Attach the rewind.plan + rewind.apply handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerRewindGatewayMethods(catalog: GatewayMethodCatalog, service: UnifiedRewindService): void {
  const planDescriptor = catalog.get('rewind.plan');
  if (planDescriptor) catalog.register(planDescriptor, createRewindPlanHandler(service), { replace: true });

  const applyDescriptor = catalog.get('rewind.apply');
  if (applyDescriptor) catalog.register(applyDescriptor, createRewindApplyHandler(service), { replace: true });
}
