/**
 * device-phone-tool.ts, the native `phone` tool.
 *
 * Uses a paired phone's camera, screen, location, clipboard, and device commands
 * as agent capabilities. A first-class tool on the agent contract, not an MCP
 * server, per the standing design constraint.
 *
 * It lives here rather than in one product because it is the only path that
 * reaches `DeviceCapabilityService.request`, and therefore the only place the
 * `device.*` posture keys can be observed at all. Written once in a single
 * consumer it made those keys dark everywhere else; written here, every host
 * that composes a device posture runtime (device-posture-runtime.ts) offers the
 * same tool with the same schema, the same refusal wording, and the same
 * retention disclosure.
 *
 * The tool holds no authority and caches no decision: it shapes arguments, calls
 * the service, and renders the outcome. The confirmation gate, the durable-grant
 * lookup, the capture retention, and the housekeeping disclosure all belong to
 * the service.
 */
import type { Tool } from '../types/tools.js';
import {
  DEVICE_CAPABILITY_CATALOG,
  describeDeviceNodeKind,
  getDeviceCapability,
  isDeviceCapabilityId,
  type DeviceCapabilityId,
} from './device-capability-contract.js';
import { validateDeviceCapabilityInput } from './device-peer-work.js';
import type { DeviceCapabilityOutcome } from './device-capability-service.js';
import type { DevicePostureRuntime } from './device-posture-runtime.js';

type PhoneAction =
  | 'nodes'
  | 'capabilities'
  | 'run'
  | 'photo'
  | 'screenshot'
  | 'location'
  | 'clipboard_read'
  | 'clipboard_write'
  | 'notify'
  | 'open_url'
  | 'vibrate'
  | 'grants'
  | 'revoke'
  | 'artifacts'
  | 'housekeeping';

interface PhoneToolArgs {
  readonly action?: unknown;
  readonly nodeId?: unknown;
  readonly capabilityId?: unknown;
  readonly reason?: unknown;
  readonly input?: unknown;
  readonly camera?: unknown;
  readonly precision?: unknown;
  readonly text?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly url?: unknown;
  readonly durationMs?: unknown;
  readonly maxWidth?: unknown;
  readonly maxAgeSeconds?: unknown;
  readonly grantId?: unknown;
  readonly limit?: unknown;
}

/**
 * The tool's own payload shape. `execute` serialises it into the runtime's
 * ToolResult (`success` plus a JSON `output`), so every action returns the same
 * readable structure whether it succeeded or was refused.
 */
type PhonePayload = Record<string, unknown> & { readonly success: boolean };

/** The registry members this registration needs; a real ToolRegistry satisfies it. */
export interface DevicePhoneToolRegistry {
  has(name: string): boolean;
  register(tool: Tool): void;
}

function fail(error: string, hint?: string): PhonePayload {
  return { success: false, error, ...(hint ? { hint } : {}) };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeAction(value: unknown): PhoneAction | null {
  const action = readString(value).toLowerCase().replace(/[- ]/g, '_');
  if (!action) return null;
  if (action === 'nodes' || action === 'devices' || action === 'list' || action === 'status') return 'nodes';
  if (action === 'capabilities' || action === 'catalog') return 'capabilities';
  if (action === 'run' || action === 'request' || action === 'invoke') return 'run';
  if (action === 'photo' || action === 'camera' || action === 'picture' || action === 'take_photo') return 'photo';
  if (action === 'screenshot' || action === 'screen' || action === 'screen_capture') return 'screenshot';
  if (action === 'location' || action === 'where' || action === 'gps') return 'location';
  if (action === 'clipboard_read' || action === 'read_clipboard' || action === 'paste') return 'clipboard_read';
  if (action === 'clipboard_write' || action === 'write_clipboard' || action === 'copy') return 'clipboard_write';
  if (action === 'notify' || action === 'notification' || action === 'alert') return 'notify';
  if (action === 'open_url' || action === 'open' || action === 'open_link') return 'open_url';
  if (action === 'vibrate' || action === 'buzz') return 'vibrate';
  if (action === 'grants' || action === 'grant_list' || action === 'permissions') return 'grants';
  if (action === 'revoke' || action === 'revoke_grant' || action === 'forget') return 'revoke';
  if (action === 'artifacts' || action === 'captures') return 'artifacts';
  if (action === 'housekeeping' || action === 'sweep' || action === 'gc') return 'housekeeping';
  return null;
}

function renderOutcome(outcome: DeviceCapabilityOutcome): PhonePayload {
  if (!outcome.ok) {
    return {
      success: false,
      error: outcome.detail,
      refusal: outcome.refusal,
      nodeId: outcome.nodeId,
      capabilityId: outcome.capabilityId,
    };
  }
  const descriptor = getDeviceCapability(outcome.capabilityId);
  return {
    success: true,
    nodeId: outcome.nodeId,
    capabilityId: outcome.capabilityId,
    capability: descriptor?.title ?? outcome.capabilityId,
    // Stated on every result so a reader can see WHY it was allowed: an
    // existing durable grant, or a fresh confirmation.
    authority: outcome.authority,
    ...(outcome.grantId ? { grantId: outcome.grantId } : {}),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    ...(outcome.artifact
      ? {
        artifact: {
          id: outcome.artifact.id,
          mediaType: outcome.artifact.mediaType,
          byteLength: outcome.artifact.byteLength,
          capturedAt: new Date(outcome.artifact.capturedAt).toISOString(),
          expiresAt: new Date(outcome.artifact.expiresAt).toISOString(),
          retentionNote: 'Deleted automatically at expiry; the removal is recorded in the device housekeeping log.',
        },
      }
      : {}),
  };
}

/** Resolve which node serves a request: the one named, or the only candidate. */
function resolveNodeId(service: DevicePostureRuntime, args: PhoneToolArgs, capabilityId: DeviceCapabilityId): string | PhonePayload {
  const explicit = readString(args.nodeId);
  const nodes = service.listNodes();
  if (explicit) {
    if (!nodes.some((node) => node.nodeId === explicit)) {
      return fail(`No paired phone with id ${JSON.stringify(explicit)}.`, 'Use action:"nodes" to list paired phones.');
    }
    return explicit;
  }
  const candidates = nodes.filter((node) => node.supported.includes(capabilityId));
  if (candidates.length === 1 && candidates[0]) return candidates[0].nodeId;
  if (candidates.length === 0) {
    return fail(
      nodes.length === 0
        ? 'No phone is paired as a device node yet.'
        : `No paired phone offers ${getDeviceCapability(capabilityId)?.title ?? capabilityId}.`,
      'Pair a phone from the web app, then use action:"nodes".',
    );
  }
  return fail(
    `More than one paired phone offers this; name one with nodeId.`,
    `Candidates: ${candidates.map((node) => `${node.nodeId} (${node.label})`).join(', ')}`,
  );
}

async function runCapability(
  service: DevicePostureRuntime,
  args: PhoneToolArgs,
  capabilityId: DeviceCapabilityId,
  capabilityInput: Record<string, unknown>,
): Promise<PhonePayload> {
  const reason = readString(args.reason);
  if (!reason) {
    return fail(
      'A reason is required: it is shown verbatim on the confirmation prompt so the person knows what they are allowing.',
      'Pass reason:"…" describing what the capability is for.',
    );
  }
  const nodeId = resolveNodeId(service, args, capabilityId);
  if (typeof nodeId !== 'string') return nodeId;

  const problems = validateDeviceCapabilityInput(capabilityId, { ...capabilityInput, reason });
  if (problems.length > 0) {
    return fail(
      `Missing or mistyped input for ${capabilityId}: ${problems.map((problem) => `${problem.field} (${problem.problem}, expected ${problem.expected})`).join('; ')}.`,
    );
  }

  const outcome = await service.capabilities.request({
    nodeId,
    capabilityId,
    input: capabilityInput,
    reason,
  });
  return renderOutcome(outcome);
}

export function createDevicePhoneTool(service: DevicePostureRuntime): Tool {
  return {
    definition: {
      name: 'phone',
      // Kept at or below 72 chars: the packaging gate enforces this on every
      // model-visible schema description. The full capability list, the grant
      // model, and the confirmation rule live in the per-field descriptions
      // and the action enum below rather than in one long paragraph here.
      description: 'Use a paired phone: camera, screen, location, clipboard, alerts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'nodes', 'capabilities', 'run', 'photo', 'screenshot', 'location',
              'clipboard_read', 'clipboard_write', 'notify', 'open_url', 'vibrate',
              'grants', 'revoke', 'artifacts', 'housekeeping',
            ],
            description: 'What to do. Defaults to "nodes" (paired phones and abilities).',
          },
          nodeId: { type: 'string', description: 'Which paired phone. Optional when only one offers it.' },
          capabilityId: { type: 'string', description: 'Capability id for action:"run" or the grant to revoke.' },
          reason: { type: 'string', description: 'Why it is needed. Shown verbatim on the confirmation prompt.' },
          input: { type: 'object', description: 'Capability inputs for action:"run".' },
          camera: { type: 'string', enum: ['rear', 'front'], description: 'Which camera action:"photo" uses. Defaults to rear.' },
          precision: { type: 'string', enum: ['coarse', 'precise'], description: 'Location precision for action:"location". Defaults to coarse.' },
          text: { type: 'string', description: 'Text to place on the clipboard for action:"clipboard_write".' },
          title: { type: 'string', description: 'Notification title for action:"notify".' },
          body: { type: 'string', description: 'Notification body for action:"notify".' },
          url: { type: 'string', description: 'Link to open for action:"open_url".' },
          durationMs: { type: 'number', description: 'Buzz length for action:"vibrate".' },
          maxWidth: { type: 'number', description: 'Longest-edge pixel cap applied on the phone before upload.' },
          maxAgeSeconds: { type: 'number', description: 'Accept a cached location fix no older than this.' },
          grantId: { type: 'string', description: 'Grant to revoke for action:"revoke".' },
          limit: { type: 'number', description: 'Maximum rows for list actions.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state', 'network'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const payload = await handleAction(service, readRecord(rawArgs) as PhoneToolArgs);
      const output = JSON.stringify(payload, null, 2);
      return payload.success
        ? { success: true, output }
        : { success: false, error: String(payload.error ?? 'The phone request was refused.'), output };
    },
  };
}

/** Every action, returning the tool's own payload before it is serialised. */
async function handleAction(service: DevicePostureRuntime, args: PhoneToolArgs): Promise<PhonePayload> {
  const action = normalizeAction(args.action) ?? 'nodes';
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50;

  if (action === 'nodes') {
    const nodes = service.listNodes();
    return {
      success: true,
      paired: nodes.length,
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId,
        label: node.label,
        nodeKind: node.nodeKind,
        nodeKindLabel: describeDeviceNodeKind(node.nodeKind),
        platform: node.platform,
        appVersion: node.appVersion,
        contractVersion: node.contractVersion,
        contractCompatible: node.contractCompatible,
        supported: node.supported,
        unavailableBecauseNotSecure: node.gatedBySecureContext,
        notOffered: node.undeclared,
        ...(node.unknownDeclared.length > 0 ? { declaredButUnknownToThisHost: node.unknownDeclared } : {}),
      })),
      ...(nodes.length === 0
        ? { note: 'No phone is paired yet. Pair one from the web app\'s phone page; it appears here once approved.' }
        : {}),
    };
  }

  if (action === 'capabilities') {
    const nodes = service.listNodes();
    const policy = service.capabilities.getPolicy();
    return {
      success: true,
      mode: policy.mode,
      allowAlwaysOffer: policy.allowAlwaysOffer,
      captureRetentionHours: Math.round(policy.captureRetentionMs / 3_600_000),
      capabilities: DEVICE_CAPABILITY_CATALOG.map((descriptor) => ({
        id: descriptor.id,
        family: descriptor.family,
        title: descriptor.title,
        purpose: descriptor.purpose,
        effect: descriptor.effect,
        sensitivity: descriptor.sensitivity,
        retainsCapture: descriptor.producesArtifact,
        confirmation: 'asks every time unless a durable grant exists',
        allowAlwaysOffered: descriptor.allowAlwaysOffered,
        servedBy: nodes.filter((node) => node.supported.includes(descriptor.id)).map((node) => node.nodeId),
      })),
    };
  }

  if (action === 'grants') {
    const grants = await service.grants.list();
    const audit = await service.grants.listAudit(limit);
    return {
      success: true,
      grants: grants.slice(0, limit).map((grant) => ({
        grantId: grant.id,
        nodeId: grant.nodeId,
        nodeKind: grant.nodeKind,
        capabilityId: grant.capabilityId,
        capability: getDeviceCapability(grant.capabilityId)?.title ?? grant.capabilityId,
        scope: grant.scope,
        grantedAt: new Date(grant.grantedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
        useCount: grant.useCount,
        ...(grant.lastUsedAt ? { lastUsedAt: new Date(grant.lastUsedAt).toISOString() } : {}),
        grantedBy: grant.grantedBy,
      })),
      recentActivity: audit.map((entry) => ({
        action: entry.action,
        capabilityId: entry.capabilityId,
        nodeId: entry.nodeId,
        at: new Date(entry.at).toISOString(),
        ...(entry.reason ? { reason: entry.reason } : {}),
      })),
    };
  }

  if (action === 'revoke') {
    const grantId = readString(args.grantId);
    const nodeId = readString(args.nodeId);
    const capabilityId = readString(args.capabilityId);
    if (!grantId && !nodeId && !capabilityId) {
      return fail('Name what to revoke: grantId, or nodeId, or capabilityId (or a combination).');
    }
    if (capabilityId && !isDeviceCapabilityId(capabilityId)) {
      return fail(`${capabilityId} is not a capability this contract defines.`);
    }
    const removed = await service.grants.revoke({
      ...(grantId ? { grantId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(capabilityId && isDeviceCapabilityId(capabilityId) ? { capabilityId } : {}),
      actor: service.actor,
    });
    return {
      success: true,
      revoked: removed.length,
      grants: removed.map((entry) => ({ grantId: entry.grantId, nodeId: entry.nodeId, capabilityId: entry.capabilityId })),
      note: removed.length === 0
        ? 'Nothing matched; no grant was revoked.'
        : 'Revoked grants are deleted, not flagged, the next request for these capabilities asks again.',
    };
  }

  if (action === 'artifacts') {
    const nodeIdFilter = readString(args.nodeId);
    const artifacts = await service.artifacts.list(nodeIdFilter || undefined);
    return {
      success: true,
      retained: artifacts.length,
      retentionHours: Math.round(service.artifacts.getPolicy().retentionMs / 3_600_000),
      artifacts: artifacts.slice(0, limit).map((artifact) => ({
        id: artifact.id,
        nodeId: artifact.nodeId,
        capabilityId: artifact.capabilityId,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        capturedAt: new Date(artifact.capturedAt).toISOString(),
        expiresAt: new Date(artifact.expiresAt).toISOString(),
        path: service.artifacts.pathFor(artifact),
        ...(artifact.reason ? { reason: artifact.reason } : {}),
      })),
    };
  }

  if (action === 'housekeeping') {
    const report = await service.housekeeper.sweep('manual');
    return {
      success: true,
      summary: report.summary,
      grantsRemoved: report.grants.removed,
      grantsRetained: report.grants.retained,
      capturesRemoved: report.artifacts.removed,
      capturesRetained: report.artifacts.retained,
      bytesReclaimed: report.artifacts.bytesReclaimed,
    };
  }

  if (action === 'run') {
    const capabilityId = readString(args.capabilityId);
    if (!isDeviceCapabilityId(capabilityId)) {
      return fail(
        `${capabilityId || '(none)'} is not a capability this contract defines.`,
        `Known capabilities: ${DEVICE_CAPABILITY_CATALOG.map((entry) => entry.id).join(', ')}`,
      );
    }
    return runCapability(service, args, capabilityId, readRecord(args.input));
  }

  if (action === 'photo') {
    const front = readString(args.camera).toLowerCase() === 'front';
    const capabilityId: DeviceCapabilityId = front ? 'device.camera.front.capture' : 'device.camera.rear.capture';
    return runCapability(service, args, capabilityId, {
      ...(typeof args.maxWidth === 'number' ? { maxWidth: args.maxWidth } : {}),
    });
  }

  if (action === 'screenshot') {
    return runCapability(service, args, 'device.screen.capture', {});
  }

  if (action === 'location') {
    const precise = readString(args.precision).toLowerCase() === 'precise';
    const capabilityId: DeviceCapabilityId = precise ? 'device.location.precise' : 'device.location.coarse';
    return runCapability(service, args, capabilityId, {
      ...(typeof args.maxAgeSeconds === 'number' ? { maxAgeSeconds: args.maxAgeSeconds } : {}),
    });
  }

  if (action === 'clipboard_read') {
    return runCapability(service, args, 'device.clipboard.read', {});
  }

  if (action === 'clipboard_write') {
    const text = readString(args.text);
    if (!text) return fail('Pass text:"…", the text to place on the phone\'s clipboard.');
    return runCapability(service, args, 'device.clipboard.write', { text });
  }

  if (action === 'notify') {
    const title = readString(args.title);
    if (!title) return fail('Pass title:"…", the notification title.');
    return runCapability(service, args, 'device.command.notify', {
      title,
      ...(readString(args.body) ? { body: readString(args.body) } : {}),
    });
  }

  if (action === 'open_url') {
    const url = readString(args.url);
    if (!/^https?:\/\//i.test(url)) return fail('Pass url:"https://…", only http and https links are opened on the phone.');
    return runCapability(service, args, 'device.command.open_url', { url });
  }

  if (action === 'vibrate') {
    return runCapability(service, args, 'device.command.vibrate', {
      ...(typeof args.durationMs === 'number' ? { durationMs: args.durationMs } : {}),
    });
  }

  return fail('Unknown phone action.', 'Use action:"nodes" to list paired phones, or action:"capabilities" for the catalog.');
}

/** Register the tool, leaving an existing `phone` registration alone. */
export function registerDevicePhoneTool(registry: DevicePhoneToolRegistry, service: DevicePostureRuntime): void {
  if (!registry.has('phone')) registry.register(createDevicePhoneTool(service));
}
