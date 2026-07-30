/**
 * device-posture-runtime.ts — one call that stands the paired-device feature up
 * inside whichever process hosts the daemon.
 *
 * What lives here is everything about the feature that is NOT specific to a
 * surface: which peers count as device nodes, how one capability request becomes
 * a work item on that peer's queue, how the confirmation is put to the person
 * through the shared approval path, and how the configuration in
 * device-posture-config.ts reaches the stores and the capability service.
 *
 * It was written once in the agent and nowhere else, which is exactly why the
 * `device.*` posture keys did nothing in the terminal app's daemon — the owner's
 * own deployment. A host now supplies three seams and gets the whole feature:
 *
 *   - a peer transport (the distributed runtime manager in a real daemon),
 *   - an approval bridge (the shared approval broker),
 *   - a configuration reader and a state directory.
 *
 * Nothing here knows what KIND of node answers. A native node that pairs with
 * the same announcement and answers the same work type is served by this code
 * path with no branch of its own.
 */
import { join } from 'node:path';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  resolveDeviceNodeProfile,
  type DeviceNodeAnnouncement,
  type DeviceNodeProfile,
} from './device-capability-contract.js';
import {
  DeviceCapabilityService,
  type DeviceCapabilityDispatcher,
  type DeviceCapabilityPolicy,
  type DeviceConfirmationHandler,
  type DeviceDispatchResult,
} from './device-capability-service.js';
import { DeviceGrantStore } from './device-grants.js';
import { DeviceCaptureArtifactStore } from './device-capture-artifacts.js';
import { DeviceHousekeeper } from './device-housekeeping.js';
import {
  DEVICE_CAPABILITY_WORK_TYPE,
  buildDeviceCapabilityWorkRequest,
  decodeDeviceCapabilityMedia,
  parseDeviceCapabilityWorkResult,
} from './device-peer-work.js';
import {
  readDeviceArtifactPolicy,
  readDeviceCapabilityPolicy,
  readDeviceGrantPolicy,
  readDeviceRequestTimeoutMs,
  readDeviceSweepIntervalMs,
  type DevicePostureConfigReader,
} from './device-posture-config.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../permissions/prompt.js';

/** Metadata key a device node's pair request carries its announcement under. */
export const DEVICE_NODE_ANNOUNCEMENT_KEY = 'deviceNode';

/** The peer fields this runtime reads. A real peer record satisfies it. */
export interface DevicePeerView {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly platform?: string | undefined;
  readonly version?: string | undefined;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly metadata: Record<string, unknown>;
}

/** The work fields this runtime reads back off the queue. */
export interface DeviceWorkView {
  readonly id: string;
  readonly status: string;
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
}

/**
 * The two members of a distributed runtime manager this runtime needs. Declared
 * narrowly so a test can stand up a transport without a live peer process, and
 * so no surface has to hand over its whole runtime graph.
 */
export interface DevicePeerTransport {
  listPeers(kind?: string): readonly DevicePeerView[];
  invokePeer(input: {
    readonly peerId: string;
    readonly command: string;
    readonly type?: string | undefined;
    readonly payload?: unknown | undefined;
    readonly actor?: string | undefined;
    readonly waitMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<{ work: DeviceWorkView; completed: boolean }>;
}

/** The slice of the shared approval path the confirmation prompt rides. */
export interface DeviceApprovalBridge {
  requestApproval(input: {
    readonly request: PermissionPromptRequest;
    readonly sessionId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<PermissionPromptDecision>;
}

export interface DevicePostureRuntimeOptions {
  readonly transport: DevicePeerTransport;
  readonly approvals: DeviceApprovalBridge;
  readonly config: DevicePostureConfigReader;
  /** Directory the grants ledger, captures, and disclosure log live under. */
  readonly stateDirectory: string;
  /**
   * Who the audit trail records for work items and grant revocations, e.g.
   * `tui:phone-tool`. A host that records something it is not makes the ledger
   * lie about where a decision was made.
   */
  readonly actor?: string | undefined;
  /** The host's live session id, when it has one, for session-scoped prompts. */
  readonly getSessionId?: (() => string | undefined) | undefined;
}

/** Everything a host (and its `phone` tool) needs, assembled from the runtime. */
export interface DevicePostureRuntime {
  readonly capabilities: DeviceCapabilityService;
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  readonly housekeeper: DeviceHousekeeper;
  /** The actor string this host records in the ledger. */
  readonly actor: string;
  listNodes(): readonly DeviceNodeProfile[];
  /** The posture in force right now, re-read from configuration. */
  readPolicy(): DeviceCapabilityPolicy;
  /** Recovery sweep plus the periodic timer; call once during bootstrap. */
  startHousekeeping(): Promise<void>;
  stopHousekeeping(): void;
}

/**
 * Read a peer's device-node announcement out of its pairing metadata.
 * A peer without one is an ordinary peer, not a device node.
 */
export function readDeviceAnnouncement(peer: DevicePeerView): DeviceNodeAnnouncement | null {
  const raw = peer.metadata[DEVICE_NODE_ANNOUNCEMENT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const nodeKind = typeof record.nodeKind === 'string' ? record.nodeKind : '';
  if (!nodeKind) return null;
  const declared = Array.isArray(record.capabilities)
    ? record.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : peer.capabilities;
  return {
    nodeId: peer.id,
    nodeKind,
    label: peer.label,
    platform: peer.platform ?? '',
    appVersion: peer.version ?? '',
    contractVersion: typeof record.contractVersion === 'number' ? record.contractVersion : DEVICE_CAPABILITY_CONTRACT_VERSION,
    capabilities: declared,
    secureContext: record.secureContext !== false,
  };
}

/** The paired device nodes a transport currently reports. */
export function listDeviceNodesFromTransport(transport: DevicePeerTransport): readonly DeviceNodeProfile[] {
  const profiles: DeviceNodeProfile[] = [];
  for (const peer of transport.listPeers('device')) {
    if (peer.status === 'revoked') continue;
    const announcement = readDeviceAnnouncement(peer);
    if (!announcement) continue;
    const resolved = resolveDeviceNodeProfile(announcement);
    if (resolved.ok) profiles.push(resolved.profile);
  }
  return profiles;
}

/** One capability request as a work item on the node's queue. */
function createDispatcher(transport: DevicePeerTransport, actor: string): DeviceCapabilityDispatcher {
  return {
    async dispatch(input): Promise<DeviceDispatchResult> {
      const payload = buildDeviceCapabilityWorkRequest({
        capabilityId: input.capabilityId,
        input: input.input,
        reason: typeof input.input.reason === 'string' ? input.input.reason : '',
        timeoutMs: input.timeoutMs,
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
      });
      const { work, completed } = await transport.invokePeer({
        peerId: input.nodeId,
        command: input.capabilityId,
        type: DEVICE_CAPABILITY_WORK_TYPE,
        payload,
        actor,
        waitMs: input.timeoutMs,
        timeoutMs: input.timeoutMs,
      });
      if (!completed || work.status !== 'completed') {
        return {
          ok: false,
          error: work.error?.trim()
            ? work.error.trim()
            : `The device did not answer within ${Math.round(input.timeoutMs / 1000)}s (work ${work.id} is ${work.status}).`,
          workId: work.id,
        };
      }
      const result = parseDeviceCapabilityWorkResult(work.result);
      if (!result) {
        return { ok: false, error: 'The device returned a result this contract does not recognise.', workId: work.id };
      }
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'The device declined or failed the request.', workId: work.id };
      }
      const bytes = decodeDeviceCapabilityMedia(result);
      return {
        ok: true,
        workId: work.id,
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(bytes ? { bytes } : {}),
        ...(result.mediaType ? { mediaType: result.mediaType } : {}),
      };
    },
  };
}

/**
 * The confirmation, routed through the shared approval path so the prompt
 * appears on whatever surface the person is actually looking at.
 *
 * "Always allow" rides the standard remember-tier machinery, so the same prompt
 * renders it on every surface. The 'tool' tier is the durable one here: this
 * capability, on this node, until revoked or expired.
 */
function createConfirmationHandler(options: DevicePostureRuntimeOptions): DeviceConfirmationHandler {
  return async (request) => {
    const promptRequest: PermissionPromptRequest = {
      callId: `phone-${request.capabilityId}-${Date.now()}`,
      tool: 'phone',
      args: {
        node: request.nodeLabel,
        nodeId: request.nodeId,
        capability: request.capabilityId,
        reason: request.reason,
        ...request.input,
      },
      category: request.descriptor.effect === 'actuate' ? 'write' : 'read',
      analysis: {
        classification: `device.${request.descriptor.family}`,
        riskLevel: request.descriptor.sensitivity === 'elevated' ? 'high' : 'medium',
        summary: `${request.descriptor.title} on ${request.nodeLabel}`,
        reasons: [request.descriptor.purpose, request.reason].filter((entry) => entry.trim().length > 0),
        target: request.nodeLabel,
        sideEffects: request.descriptor.producesArtifact
          ? [`retains a ${request.descriptor.artifactKind} capture for the configured retention window`]
          : [],
      },
      ...(request.allowAlwaysOffered
        ? {
          rememberOptions: [{
            tier: 'tool' as const,
            label: `Always allow ${request.descriptor.title.toLowerCase()} on ${request.nodeLabel}`,
            detail: 'Durable grant for this one capability on this one device. Visible and revocable in the device grants surface.',
          }],
        }
        : {}),
    };
    const sessionId = request.sessionId ?? options.getSessionId?.();
    const decision = await options.approvals.requestApproval({
      request: promptRequest,
      ...(sessionId ? { sessionId } : {}),
      metadata: {
        deviceNodeId: request.nodeId,
        deviceNodeKind: request.nodeKind,
        deviceCapability: request.capabilityId,
        allowAlwaysOffered: request.allowAlwaysOffered,
      },
      // The question must not outlive the request it belongs to.
      timeoutMs: readDeviceRequestTimeoutMs(options.config),
    });
    if (!decision.approved) {
      return { decision: 'deny', actor: 'operator', ...(decision.reason ? { note: decision.reason } : {}) };
    }
    const durable = decision.rememberTier !== undefined && decision.rememberTier !== 'session';
    return { decision: durable ? 'always' : 'once', actor: 'operator' };
  };
}

/**
 * Build the device feature for one host. Constructing this opens no connection,
 * starts no timer, and prompts nobody: call `startHousekeeping()` once the host
 * is up.
 *
 * Every policy is passed as a RESOLVER rather than a snapshot, so a `device.*`
 * change in the settings workspace governs the next request, the next grant, and
 * the next sweep without a restart.
 */
export function createDevicePostureRuntime(options: DevicePostureRuntimeOptions): DevicePostureRuntime {
  const { transport, config, stateDirectory } = options;
  const actor = options.actor?.trim() ? options.actor.trim() : 'device-capabilities';

  const listNodes = (): readonly DeviceNodeProfile[] => listDeviceNodesFromTransport(transport);

  const grants = new DeviceGrantStore(join(stateDirectory, 'device-grants.json'), {
    policy: () => readDeviceGrantPolicy(config),
    ownership: {
      // A grant belongs to a paired node. Once that node is gone the grant is
      // reaped rather than left to be re-honoured if the id is ever reused.
      isKnownNode: (nodeId) => listNodes().some((node) => node.nodeId === nodeId),
    },
  });

  const artifacts = new DeviceCaptureArtifactStore(join(stateDirectory, 'captures'), {
    policy: () => readDeviceArtifactPolicy(config),
  });

  const housekeeper = new DeviceHousekeeper({
    grants,
    artifacts,
    disclosurePath: join(stateDirectory, 'device-housekeeping.json'),
  });

  const capabilities = new DeviceCapabilityService({
    grants,
    artifacts,
    dispatcher: createDispatcher(transport, actor),
    confirm: createConfirmationHandler(options),
    listNodes,
    policy: () => readDeviceCapabilityPolicy(config),
  });

  return {
    capabilities,
    grants,
    artifacts,
    housekeeper,
    actor,
    listNodes,
    readPolicy: () => readDeviceCapabilityPolicy(config),
    async startHousekeeping(): Promise<void> {
      // Recovery first: a grant whose node is gone, or a capture torn by a
      // crash, is removed BEFORE the first request of this run is served.
      await housekeeper.runRecoverySweep();
      housekeeper.start(() => readDeviceSweepIntervalMs(config));
    },
    stopHousekeeping(): void {
      housekeeper.stop();
    },
  };
}
