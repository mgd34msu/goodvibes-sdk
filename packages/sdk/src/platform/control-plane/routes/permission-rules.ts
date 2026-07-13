/**
 * permissions.rules.* gateway handlers — the settings-domain surface over the
 * durable user-origin permission rule store. Read/delete only: rules are
 * WRITTEN by remembered approval decisions (PermissionManager), never minted
 * ad hoc through the wire, so the store's provenance stays "a user answered
 * an ask".
 */

import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Invalid ${field}: expected a non-empty string`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

export interface PermissionRulesGatewayDeps {
  readonly userRuleStore: Pick<UserPermissionRuleStore, 'list' | 'delete'>;
}

export function createPermissionRulesListHandler(store: PermissionRulesGatewayDeps['userRuleStore']): GatewayMethodHandler {
  return async () => ({
    rules: store.list().map((record) => ({
      id: record.rule.id,
      effect: record.rule.effect,
      tier: record.tier,
      tool: record.tool,
      ...(record.rule.description ? { description: record.rule.description } : {}),
      createdAt: record.createdAt,
    })),
  });
}

export function createPermissionRulesDeleteHandler(store: PermissionRulesGatewayDeps['userRuleStore']): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const ruleId = requireString(params.ruleId, 'ruleId');
    return { deleted: await store.delete(ruleId) };
  };
}

/** Attach the permissions.rules.list/.delete handlers to their descriptors. Missing descriptor is a silent no-op. */
export function registerPermissionRulesGatewayMethods(catalog: GatewayMethodCatalog, deps: PermissionRulesGatewayDeps): void {
  const listDescriptor = catalog.get('permissions.rules.list');
  if (listDescriptor) catalog.register(listDescriptor, createPermissionRulesListHandler(deps.userRuleStore), { replace: true });

  const deleteDescriptor = catalog.get('permissions.rules.delete');
  if (deleteDescriptor) catalog.register(deleteDescriptor, createPermissionRulesDeleteHandler(deps.userRuleStore), { replace: true });
}
