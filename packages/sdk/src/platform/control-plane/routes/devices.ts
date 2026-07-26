/**
 * routes/devices.ts — handlers for the paired-device verbs over the live
 * device capability service (see platform/devices for the contract).
 *
 * These are what make the grants surface real on every client: one contract for
 * listing paired device nodes and their capabilities, listing the durable
 * "always allow" grants with their ledger, revoking a grant, and running the
 * housekeeping sweep with its disclosure.
 *
 * Absent a bound service the verbs stay cataloged-but-unhandled, the same
 * graceful degrade the power and memory verb groups use.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { readInvocationParams } from './invocation-params.js';
import {
  DEVICE_CAPABILITY_CATALOG,
  describeDeviceNodeKind,
  getDeviceCapability,
  isDeviceCapabilityId,
} from '../../devices/device-capability-contract.js';
import type { DeviceCapabilityService } from '../../devices/device-capability-service.js';
import type { DeviceGrantStore } from '../../devices/device-grants.js';
import type { DeviceHousekeeper } from '../../devices/device-housekeeping.js';

/** The device slice the verbs need, bound by whichever runtime owns it. */
export interface DevicesGatewayService {
  readonly capabilities: Pick<DeviceCapabilityService, 'listDeviceNodes' | 'getPolicy'>;
  readonly grants: Pick<DeviceGrantStore, 'list' | 'listAudit' | 'revoke'>;
  readonly housekeeper: Pick<DeviceHousekeeper, 'sweep'>;
}

export function createDevicesNodesListHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return () => {
    const policy = service.capabilities.getPolicy();
    return {
      nodes: service.capabilities.listDeviceNodes().map((node) => ({
        nodeId: node.nodeId,
        nodeKind: node.nodeKind,
        nodeKindLabel: describeDeviceNodeKind(node.nodeKind),
        label: node.label,
        platform: node.platform,
        appVersion: node.appVersion,
        contractVersion: node.contractVersion,
        contractCompatible: node.contractCompatible,
        supported: node.supported,
        undeclared: node.undeclared,
        gatedBySecureContext: node.gatedBySecureContext,
        unknownDeclared: node.unknownDeclared,
      })),
      capabilities: DEVICE_CAPABILITY_CATALOG.map((descriptor) => ({
        id: descriptor.id,
        family: descriptor.family,
        title: descriptor.title,
        purpose: descriptor.purpose,
        effect: descriptor.effect,
        sensitivity: descriptor.sensitivity,
        producesArtifact: descriptor.producesArtifact,
        allowAlwaysOffered: descriptor.allowAlwaysOffered,
      })),
      mode: policy.mode,
      allowAlwaysOffer: policy.allowAlwaysOffer,
      captureRetentionHours: Math.round(policy.captureRetentionMs / 3_600_000),
    };
  };
}

export function createDevicesGrantsListHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 100;
    const grants = await service.grants.list();
    const audit = await service.grants.listAudit(limit);
    return {
      grants: grants
        .filter((grant) => !nodeId || grant.nodeId === nodeId)
        .slice(0, limit)
        .map((grant) => ({
          grantId: grant.id,
          nodeId: grant.nodeId,
          nodeKind: grant.nodeKind,
          capabilityId: grant.capabilityId,
          capabilityTitle: getDeviceCapability(grant.capabilityId)?.title ?? grant.capabilityId,
          scope: grant.scope,
          grantedAt: grant.grantedAt,
          expiresAt: grant.expiresAt,
          lastUsedAt: grant.lastUsedAt ?? null,
          useCount: grant.useCount,
          grantedBy: grant.grantedBy,
        })),
      audit: audit.map((entry) => ({
        id: entry.id,
        action: entry.action,
        grantId: entry.grantId,
        nodeId: entry.nodeId,
        capabilityId: entry.capabilityId,
        at: entry.at,
        actor: entry.actor,
        reason: entry.reason ?? '',
      })),
    };
  };
}

export function createDevicesGrantsRevokeHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const grantId = typeof params.grantId === 'string' ? params.grantId.trim() : '';
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
    const capabilityId = typeof params.capabilityId === 'string' ? params.capabilityId.trim() : '';
    const note = typeof params.note === 'string' ? params.note.trim() : '';
    const removals = await service.grants.revoke({
      ...(grantId ? { grantId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(capabilityId && isDeviceCapabilityId(capabilityId) ? { capabilityId } : {}),
      actor: 'operator',
      ...(note ? { note } : {}),
    });
    return {
      revoked: removals.length,
      removals: removals.map((removal) => ({
        grantId: removal.grantId,
        nodeId: removal.nodeId,
        capabilityId: removal.capabilityId,
        scope: removal.scope,
        reason: removal.reason,
        removedAt: removal.removedAt,
      })),
    };
  };
}

export function createDevicesHousekeepingRunHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async () => {
    const report = await service.housekeeper.sweep('manual');
    return {
      summary: report.summary,
      sweptAt: report.sweptAt,
      grantsRemoved: report.grants.removed.map((removal) => ({
        grantId: removal.grantId,
        nodeId: removal.nodeId,
        capabilityId: removal.capabilityId,
        scope: removal.scope,
        reason: removal.reason,
        removedAt: removal.removedAt,
      })),
      grantsRetained: report.grants.retained,
      capturesRemoved: report.artifacts.removed.map((removal) => ({
        artifactId: removal.artifactId,
        nodeId: removal.nodeId,
        capabilityId: removal.capabilityId,
        fileName: removal.fileName,
        reason: removal.reason,
        removedAt: removal.removedAt,
        byteLength: removal.byteLength,
      })),
      capturesRetained: report.artifacts.retained,
      bytesReclaimed: report.artifacts.bytesReclaimed,
    };
  };
}

/** Attach the device handlers to their registered descriptors (missing = no-op). */
export function registerDevicesGatewayMethods(catalog: GatewayMethodCatalog, service: DevicesGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('devices.nodes.list', createDevicesNodesListHandler(service));
  attach('devices.grants.list', createDevicesGrantsListHandler(service));
  attach('devices.grants.revoke', createDevicesGrantsRevokeHandler(service));
  attach('devices.housekeeping.run', createDevicesHousekeepingRunHandler(service));
}
