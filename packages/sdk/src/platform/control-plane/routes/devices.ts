/**
 * routes/devices.ts, handlers for the paired-device verbs over the live
 * device capability service (see platform/devices for the contract).
 *
 * These are what make the paired-phone feature real on every client: listing
 * paired device nodes and their capabilities, ASKING one of them for a
 * capability and reading back what it returned, listing the durable "always
 * allow" grants with their ledger, revoking a grant, and running the
 * housekeeping sweep with its disclosure.
 *
 * `devices.capability.request` and the two artifact verbs are the path for a
 * surface that does not host the device posture runtime itself. In-process the
 * `phone` tool calls DeviceCapabilityService.request directly and reads capture
 * bytes off the daemon's own disk; a client somewhere else could see the grants
 * and revoke them and could not ask a phone for anything. Every gate stays
 * where it was: these handlers shape arguments and render the runtime's own
 * outcome, and re-decide nothing. The confirmation prompt, the durable-grant
 * lookup, the input check, the retention window and the disclosure all belong
 * to the runtime, exactly as they do for the tool.
 *
 * Absent a bound service the verbs stay cataloged-but-unhandled, the same
 * graceful degrade the power and memory verb groups use.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { readInvocationParams } from './invocation-params.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import {
  DEVICE_CAPABILITY_CATALOG,
  describeDeviceNodeKind,
  getDeviceCapability,
  isDeviceCapabilityId,
} from '../../devices/device-capability-contract.js';
import type { DeviceCapabilityService } from '../../devices/device-capability-service.js';
import type { DeviceCaptureArtifact, DeviceCaptureArtifactStore } from '../../devices/device-capture-artifacts.js';
import { encodeDeviceCapabilityMedia } from '../../devices/device-peer-work.js';
import type { DeviceGrantStore } from '../../devices/device-grants.js';
import type { DeviceHousekeeper } from '../../devices/device-housekeeping.js';

/** The device slice the verbs need, bound by whichever runtime owns it. */
export interface DevicesGatewayService {
  readonly capabilities: Pick<DeviceCapabilityService, 'listDeviceNodes' | 'getPolicy' | 'request'>;
  readonly grants: Pick<DeviceGrantStore, 'list' | 'listAudit' | 'revoke'>;
  readonly housekeeper: Pick<DeviceHousekeeper, 'sweep'>;
  readonly artifacts: Pick<DeviceCaptureArtifactStore, 'list' | 'read' | 'getPolicy' | 'pathFor'>;
}

function requireString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400, field);
  }
  return text;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError(`Invalid ${field}: expected an object of capability inputs`, 'INVALID_ARGUMENT', 400, field);
  }
  return value as Record<string, unknown>;
}

function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GatewayVerbError(`Invalid ${field}: expected a positive number of milliseconds`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

/** One retained capture, described identically by every verb that returns one. */
function describeArtifact(
  artifact: DeviceCaptureArtifact,
  artifacts: Pick<DeviceCaptureArtifactStore, 'pathFor'>,
): Record<string, unknown> {
  return {
    artifactId: artifact.id,
    nodeId: artifact.nodeId,
    capabilityId: artifact.capabilityId,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    capturedAt: artifact.capturedAt,
    expiresAt: artifact.expiresAt,
    reason: artifact.reason ?? '',
    daemonPath: artifacts.pathFor(artifact),
  };
}

/**
 * Ask one paired device for one capability.
 *
 * A refusal comes back as `ok: false` with the runtime's own reason rather than
 * an HTTP error, because a person declining to hand over their camera is an
 * ANSWER, the request ran, was put to them, and they said no. Reporting that
 * as a server fault would make a working system look broken and would lose the
 * one thing the caller needs, which is what they said.
 */
export function createDevicesCapabilityRequestHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const nodeId = requireString(params.nodeId, 'nodeId');
    const capabilityId = requireString(params.capabilityId, 'capabilityId');
    const reason = requireString(params.reason, 'reason');
    const capabilityInput = optionalRecord(params.input, 'input');
    const timeoutMs = optionalPositiveNumber(params.timeoutMs, 'timeoutMs');
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';

    const outcome = await service.capabilities.request({
      nodeId,
      capabilityId,
      input: capabilityInput,
      reason,
      ...(sessionId ? { sessionId } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

    const title = getDeviceCapability(outcome.capabilityId)?.title ?? outcome.capabilityId;
    if (!outcome.ok) {
      return {
        ok: false,
        nodeId: outcome.nodeId,
        capabilityId: outcome.capabilityId,
        capabilityTitle: title,
        authority: '',
        grantId: null,
        artifact: null,
        refusal: outcome.refusal,
        detail: outcome.detail,
      };
    }
    return {
      ok: true,
      nodeId: outcome.nodeId,
      capabilityId: outcome.capabilityId,
      capabilityTitle: title,
      // Stated on every result so a reader can see WHY it was allowed.
      authority: outcome.authority,
      grantId: outcome.grantId ?? null,
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
      artifact: outcome.artifact ? describeArtifact(outcome.artifact, service.artifacts) : null,
      refusal: '',
      detail: '',
    };
  };
}

export function createDevicesArtifactsListHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
    const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 50;
    const retained = await service.artifacts.list(nodeId || undefined);
    return {
      artifacts: retained.slice(0, limit).map((artifact) => describeArtifact(artifact, service.artifacts)),
      retained: retained.length,
      retentionHours: Math.round(service.artifacts.getPolicy().retentionMs / 3_600_000),
    };
  };
}

/** Why a capture could not be served, in the words a person would use. */
const ARTIFACT_READ_REFUSALS: Readonly<Record<string, string>> = {
  'not-found': 'No retained capture with that id. It may already have been swept.',
  expired: 'That capture is past its retention window and has been deleted.',
  'file-missing': 'That capture\'s record survived but its bytes are gone from disk; the record has now been reaped.',
  'content-mismatch': 'That capture no longer matches the digest recorded when it was taken, so it is not the picture that was captured; the record has now been reaped.',
};

export function createDevicesArtifactsReadHandler(service: DevicesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const artifactId = requireString(params.artifactId, 'artifactId');
    const result = await service.artifacts.read(artifactId);
    if (!result.ok) {
      throw new GatewayVerbError(
        ARTIFACT_READ_REFUSALS[result.reason] ?? 'That capture is not available.',
        'NOT_FOUND',
        404,
        'artifactId',
      );
    }
    return {
      artifact: describeArtifact(result.artifact, service.artifacts),
      dataBase64: encodeDeviceCapabilityMedia(result.bytes),
    };
  };
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
  attach('devices.capability.request', createDevicesCapabilityRequestHandler(service));
  attach('devices.artifacts.list', createDevicesArtifactsListHandler(service));
  attach('devices.artifacts.read', createDevicesArtifactsReadHandler(service));
  attach('devices.grants.list', createDevicesGrantsListHandler(service));
  attach('devices.grants.revoke', createDevicesGrantsRevokeHandler(service));
  attach('devices.housekeeping.run', createDevicesHousekeepingRunHandler(service));
}
