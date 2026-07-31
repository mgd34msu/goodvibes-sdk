/**
 * device-capability-service.ts — the one path a paired device's camera, screen,
 * location, clipboard, or device command is reached through.
 *
 * Every request walks the same seven steps, in this order, with no shortcuts:
 *   1. the node must be paired and must have announced the capability,
 *   2. configuration must allow the capability at all,
 *   3. the request's inputs must satisfy the capability's declared fields,
 *   4. a live grant is looked up (re-read from disk, never cached in process),
 *   5. with no grant, the person is asked — ask-every-time is the default for
 *      EVERY capture and effect, and "always allow" is offered on every
 *      capability per the owner ruling of 2026-07-25,
 *   6. the work is dispatched to the node over the peer transport,
 *   7. bytes that came back are retained under the capture TTL and disclosed.
 *
 * The dispatcher and the confirmation handler are injected, which is what keeps
 * this node-kind neutral: the same service serves a web PWA node and a native
 * node with no branch of its own.
 */
import {
  getDeviceCapability,
  type DeviceCapabilityDescriptor,
  type DeviceCapabilityId,
  type DeviceNodeProfile,
} from './device-capability-contract.js';
import type { DeviceCapabilityGrant, DeviceGrantStore } from './device-grants.js';
import type { DeviceCaptureArtifact, DeviceCaptureArtifactStore } from './device-capture-artifacts.js';
import { validateDeviceCapabilityInput } from './device-peer-work.js';
import { resolveDevicePolicySource, type DevicePolicySource } from './device-policy-source.js';

/** How the feature behaves overall (`device.capabilities.mode`). */
export type DeviceCapabilityMode = 'off' | 'ask-every-time' | 'honor-grants';

/** Which capabilities may be granted durably (`device.capabilities.allowAlwaysOffer`). */
export type DeviceAllowAlwaysOffer = 'every-capability' | 'standard-only' | 'never';

/** Location precision posture (`device.location.precision`). */
export type DeviceLocationPrecision = 'coarse-only' | 'ask-precise' | 'precise-grantable';

/** Clipboard read posture (`device.clipboard.readMode`). */
export type DeviceClipboardReadMode = 'off' | 'ask-only' | 'grantable';

/** The resolved configuration this service enforces. */
export interface DeviceCapabilityPolicy {
  readonly mode: DeviceCapabilityMode;
  readonly allowAlwaysOffer: DeviceAllowAlwaysOffer;
  readonly locationPrecision: DeviceLocationPrecision;
  readonly clipboardReadMode: DeviceClipboardReadMode;
  readonly requestTimeoutMs: number;
  readonly captureRetentionMs: number;
}

/**
 * Stock policy — matches the owner rulings exactly: ask every time by default,
 * "always allow" offered on every capability, 24h capture retention, clipboard
 * read present and grantable.
 */
export const DEFAULT_DEVICE_CAPABILITY_POLICY: DeviceCapabilityPolicy = {
  mode: 'honor-grants',
  allowAlwaysOffer: 'every-capability',
  locationPrecision: 'precise-grantable',
  clipboardReadMode: 'grantable',
  requestTimeoutMs: 60_000,
  captureRetentionMs: 24 * 60 * 60 * 1000,
};

/** What the person chose when asked. */
export type DeviceConfirmationDecision = 'once' | 'always' | 'deny';

/** The question put to the person, verbatim fields and all. */
export interface DeviceConfirmationRequest {
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly nodeLabel: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly descriptor: DeviceCapabilityDescriptor;
  /** The caller's stated reason, shown verbatim. */
  readonly reason: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * Whether the prompt offers a durable "always allow". True for every
   * capability under stock configuration.
   */
  readonly allowAlwaysOffered: boolean;
  readonly sessionId?: string | undefined;
}

export interface DeviceConfirmationResponse {
  readonly decision: DeviceConfirmationDecision;
  readonly actor: string;
  readonly note?: string | undefined;
}

export type DeviceConfirmationHandler = (
  request: DeviceConfirmationRequest,
) => Promise<DeviceConfirmationResponse>;

/** What came back from the node. */
export interface DeviceDispatchResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** Structured payload (a location fix, clipboard text, a command ack). */
  readonly data?: unknown | undefined;
  /** Raw bytes for a capture. Retained under the capture TTL when present. */
  readonly bytes?: Uint8Array | undefined;
  readonly mediaType?: string | undefined;
  readonly workId?: string | undefined;
}

export interface DeviceDispatchInput {
  readonly nodeId: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

/** Transport to the node. The peer work queue in the daemon; a stub in tests. */
export interface DeviceCapabilityDispatcher {
  dispatch(input: DeviceDispatchInput): Promise<DeviceDispatchResult>;
}

/** Why a request did not run. */
export type DeviceRequestRefusal =
  | 'node-unknown'
  | 'capability-unknown'
  | 'capability-unsupported'
  | 'capability-gated-by-secure-context'
  | 'disabled-by-config'
  | 'invalid-input'
  | 'denied-by-person'
  | 'dispatch-failed';

export type DeviceCapabilityOutcome =
  | {
    readonly ok: true;
    readonly capabilityId: DeviceCapabilityId;
    readonly nodeId: string;
    /** How authority was established for this specific request. */
    readonly authority: 'existing-grant' | 'confirmed-once' | 'confirmed-always';
    readonly grantId?: string | undefined;
    readonly data?: unknown | undefined;
    readonly artifact?: DeviceCaptureArtifact | undefined;
  }
  | {
    readonly ok: false;
    readonly capabilityId: string;
    readonly nodeId: string;
    readonly refusal: DeviceRequestRefusal;
    readonly detail: string;
  };

export interface DeviceCapabilityServiceOptions {
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  readonly dispatcher: DeviceCapabilityDispatcher;
  readonly confirm: DeviceConfirmationHandler;
  /** Paired device nodes, resolved from the peer registry. */
  readonly listNodes: () => readonly DeviceNodeProfile[];
  /**
   * A fixed posture, or a resolver called once per request so a settings change
   * governs the NEXT request rather than waiting for a restart — the same
   * liveness `device.nodes.maxPaired` already has at the pairing path. See
   * device-policy-source.ts.
   */
  readonly policy?: DevicePolicySource<DeviceCapabilityPolicy> | undefined;
}

/**
 * Whether a durable grant may be offered for this capability under the current
 * configuration. Under the stock policy this is true for EVERY capability —
 * the ruling offers "always allow" on front camera, screen capture, precise
 * location, and clipboard alike.
 */
export function isAllowAlwaysOffered(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
): boolean {
  if (!descriptor.allowAlwaysOffered) return false;
  if (policy.allowAlwaysOffer === 'never') return false;
  if (policy.mode === 'ask-every-time') return false;
  if (descriptor.id === 'device.clipboard.read' && policy.clipboardReadMode !== 'grantable') return false;
  if (descriptor.id === 'device.location.precise' && policy.locationPrecision === 'ask-precise') return false;
  if (policy.allowAlwaysOffer === 'standard-only' && descriptor.sensitivity === 'elevated') return false;
  return true;
}

/**
 * The deadline one request gives the device, from the configured posture and
 * whatever the caller asked for.
 *
 * A caller may ask for a SHORTER deadline than the configured one and get it —
 * a surface that will stop waiting after ten seconds should not leave a phone
 * working for sixty. It can never ask for a LONGER one: `device.requestTimeoutMs`
 * is the posture, and a caller that could extend it would be setting the posture
 * from the wire. A missing, zero, or nonsense value is simply the configured
 * deadline.
 *
 * This bounds the DISPATCH only. The confirmation prompt keeps the configured
 * deadline in every case, because the person answering it is not the caller and
 * their time is not the caller's to shorten.
 */
export function resolveDeviceRequestTimeoutMs(
  policy: DeviceCapabilityPolicy,
  requestedMs: number | undefined,
): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return policy.requestTimeoutMs;
  }
  return Math.min(Math.floor(requestedMs), policy.requestTimeoutMs);
}

/** Configuration-level availability, before any node or person is consulted. */
export function capabilityDisabledReason(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
): string | null {
  if (policy.mode === 'off') {
    return 'Paired-device capabilities are turned off (device.capabilities.mode = off).';
  }
  if (descriptor.id === 'device.clipboard.read' && policy.clipboardReadMode === 'off') {
    return 'Reading the phone clipboard is turned off (device.clipboard.readMode = off).';
  }
  if (descriptor.id === 'device.location.precise' && policy.locationPrecision === 'coarse-only') {
    return 'Precise location is turned off; only approximate location is available (device.location.precision = coarse-only).';
  }
  return null;
}

export class DeviceCapabilityService {
  private readonly grants: DeviceGrantStore;
  private readonly artifacts: DeviceCaptureArtifactStore;
  private readonly dispatcher: DeviceCapabilityDispatcher;
  private readonly confirm: DeviceConfirmationHandler;
  private readonly listNodes: () => readonly DeviceNodeProfile[];
  private readonly resolvePolicy: () => DeviceCapabilityPolicy;

  constructor(options: DeviceCapabilityServiceOptions) {
    this.grants = options.grants;
    this.artifacts = options.artifacts;
    this.dispatcher = options.dispatcher;
    this.confirm = options.confirm;
    this.listNodes = options.listNodes;
    this.resolvePolicy = resolveDevicePolicySource(options.policy, DEFAULT_DEVICE_CAPABILITY_POLICY);
  }

  /** The posture in force right now (re-read when given a resolver). */
  getPolicy(): DeviceCapabilityPolicy {
    return this.resolvePolicy();
  }

  /** Paired nodes with the capabilities each can actually serve right now. */
  listDeviceNodes(): readonly DeviceNodeProfile[] {
    return this.listNodes();
  }

  /**
   * Run one capability on one node.
   *
   * A grant is consulted but never assumed: `grants.find()` re-reads the store,
   * so a grant revoked from any surface — or expired, or belonging to a node
   * that has since been unpaired — falls through to the confirmation prompt
   * instead of being honoured.
   */
  async request(input: {
    readonly nodeId: string;
    readonly capabilityId: string;
    readonly input?: Readonly<Record<string, unknown>> | undefined;
    readonly reason: string;
    readonly sessionId?: string | undefined;
    /**
     * A shorter deadline for the device than the configured one. Clamped by
     * `resolveDeviceRequestTimeoutMs` — it can only shorten, never extend.
     */
    readonly timeoutMs?: number | undefined;
  }): Promise<DeviceCapabilityOutcome> {
    // One read for the whole request: the posture that gates the capability, the
    // posture that decides whether a durable grant may be offered, and the
    // deadline the device is given are all the same snapshot.
    const policy = this.getPolicy();
    const node = this.listNodes().find((candidate) => candidate.nodeId === input.nodeId);
    if (!node) {
      return {
        ok: false,
        capabilityId: input.capabilityId,
        nodeId: input.nodeId,
        refusal: 'node-unknown',
        detail: `No paired device node with id ${JSON.stringify(input.nodeId)}.`,
      };
    }

    const descriptor = getDeviceCapability(input.capabilityId);
    if (!descriptor) {
      return {
        ok: false,
        capabilityId: input.capabilityId,
        nodeId: input.nodeId,
        refusal: 'capability-unknown',
        detail: `${input.capabilityId} is not a capability this contract defines.`,
      };
    }

    if (node.gatedBySecureContext.includes(descriptor.id)) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'capability-gated-by-secure-context',
        detail: `${descriptor.title} needs an https (or loopback) connection to ${node.label}; it is announced but cannot be served from the current origin.`,
      };
    }
    if (!node.supported.includes(descriptor.id)) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'capability-unsupported',
        detail: `${node.label} does not offer ${descriptor.title}.`,
      };
    }

    const disabled = capabilityDisabledReason(descriptor, policy);
    if (disabled) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'disabled-by-config',
        detail: disabled,
      };
    }

    // The host half of the two-sided input check device-peer-work.ts describes
    // ("runs on the host before dispatch AND on the node, so neither side has
    // to trust the other's validation"). It lives here rather than in a caller
    // because this is the one path a capability is reached through: the `phone`
    // tool checked its own arguments, and when the control-plane verb became a
    // second caller the host half would otherwise have been simply absent from
    // it — a malformed request travelling to somebody's phone before anything
    // noticed.
    //
    // Ordered before the confirmation prompt on purpose. Asking a person to
    // approve a request that cannot run, and only then refusing it, spends
    // their attention on nothing.
    const problems = validateDeviceCapabilityInput(descriptor.id, { ...(input.input ?? {}), reason: input.reason });
    if (problems.length > 0) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'invalid-input',
        detail: `${descriptor.title} needs ${problems
          .map((problem) => `${problem.field} (${problem.problem}, expected ${problem.expected})`)
          .join('; ')}.`,
      };
    }

    let authority: 'existing-grant' | 'confirmed-once' | 'confirmed-always' = 'confirmed-once';
    let grant: DeviceCapabilityGrant | null = null;

    if (policy.mode === 'honor-grants') {
      grant = await this.grants.find({
        nodeId: node.nodeId,
        capabilityId: descriptor.id,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
    }

    if (grant) {
      authority = 'existing-grant';
      await this.grants.markUsed(grant.id);
    } else {
      const allowAlwaysOffered = isAllowAlwaysOffered(descriptor, policy);
      const response = await this.confirm({
        nodeId: node.nodeId,
        nodeKind: node.nodeKind,
        nodeLabel: node.label,
        capabilityId: descriptor.id,
        descriptor,
        reason: input.reason,
        input: input.input ?? {},
        allowAlwaysOffered,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      if (response.decision === 'deny') {
        return {
          ok: false,
          capabilityId: descriptor.id,
          nodeId: node.nodeId,
          refusal: 'denied-by-person',
          detail: response.note?.trim() ? response.note.trim() : `${descriptor.title} was declined.`,
        };
      }
      if (response.decision === 'always') {
        if (!allowAlwaysOffered) {
          // The prompt never offered it, so an 'always' answer is honoured for
          // this request only — a durable grant is not written behind a policy
          // that says it may not exist.
          authority = 'confirmed-once';
        } else {
          grant = await this.grants.record({
            nodeId: node.nodeId,
            nodeKind: node.nodeKind,
            capabilityId: descriptor.id,
            scope: 'always',
            grantedBy: response.actor,
          });
          authority = 'confirmed-always';
        }
      }
    }

    const dispatched = await this.dispatcher.dispatch({
      nodeId: node.nodeId,
      capabilityId: descriptor.id,
      input: { ...(input.input ?? {}), reason: input.reason },
      timeoutMs: resolveDeviceRequestTimeoutMs(policy, input.timeoutMs),
    });

    if (!dispatched.ok) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'dispatch-failed',
        detail: dispatched.error?.trim() ? dispatched.error.trim() : `${node.label} did not complete ${descriptor.title}.`,
      };
    }

    let artifact: DeviceCaptureArtifact | undefined;
    if (descriptor.producesArtifact && dispatched.bytes && dispatched.bytes.byteLength > 0) {
      artifact = await this.artifacts.retain({
        nodeId: node.nodeId,
        capabilityId: descriptor.id,
        kind: descriptor.artifactKind,
        mediaType: dispatched.mediaType ?? 'application/octet-stream',
        bytes: dispatched.bytes,
        ttlMs: policy.captureRetentionMs,
        ...(dispatched.workId ? { workId: dispatched.workId } : {}),
        reason: input.reason,
      });
    }

    return {
      ok: true,
      capabilityId: descriptor.id,
      nodeId: node.nodeId,
      authority,
      ...(grant ? { grantId: grant.id } : {}),
      ...(dispatched.data === undefined ? {} : { data: dispatched.data }),
      ...(artifact ? { artifact } : {}),
    };
  }
}
