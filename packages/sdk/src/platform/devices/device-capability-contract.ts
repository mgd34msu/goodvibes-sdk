/**
 * device-capability-contract.ts, the paired-device capability contract.
 *
 * This is the peer-facing contract for using a PAIRED device (today a phone)
 * as an agent tool: its cameras, its screen, its location, its clipboard, and
 * a small set of device commands. It is a NATIVE contract carried over the
 * existing distributed-runtime peer transport, deliberately not an MCP
 * server, per the owner's standing design constraint.
 *
 * Node-kind neutrality is the point of this file. A node announces which
 * capability ids it implements; nothing here enumerates, branches on, or
 * privileges a particular node kind. The first shipping node is the web PWA
 * ('web-pwa'); a native node ('android-native') is a drop-in peer that
 * announces the same ids over the same endpoints and needs no code here.
 * `KNOWN_DEVICE_NODE_KINDS` is a documentation aid for surfaces that want a
 * friendly label, `isDeviceNodeKind()` accepts any well-formed slug, so an
 * unlisted kind pairs and works without a contract change.
 *
 * Confirmation posture (owner ruling 2026-07-25): "default is ask-every-time
 * for every capture/effect, but 'always allow' is OFFERED on every capability
 *, including front camera, screen capture, precise location, and clipboard,
 * as a durable per-capability, per-node grant, visible and revocable in the
 * grants surface." Every descriptor below therefore carries
 * `defaultDecision: 'ask-every-time'` and `allowAlwaysOffered: true`. There is
 * no session-scoped-only or never-offered capability.
 *
 * This module is runtime-neutral (no node: imports) so browser nodes and
 * surfaces can import the catalog directly.
 */

/** Contract revision a node and host negotiate on. Bumped on breaking shape changes. */
export const DEVICE_CAPABILITY_CONTRACT_VERSION = 1;

/** Capability families a paired device exposes. */
export type DeviceCapabilityFamily =
  | 'camera'
  | 'screen'
  | 'location'
  | 'clipboard'
  | 'command';

/** Every capability id in the v1 catalog. */
export type DeviceCapabilityId =
  | 'device.camera.rear.capture'
  | 'device.camera.front.capture'
  | 'device.screen.capture'
  | 'device.location.coarse'
  | 'device.location.precise'
  | 'device.clipboard.read'
  | 'device.clipboard.write'
  | 'device.command.notify'
  | 'device.command.open_url'
  | 'device.command.vibrate';

/**
 * What the capability does to the world:
 *  - 'capture' produces a retained artifact (image/video frames),
 *  - 'read' returns data without retaining a media artifact,
 *  - 'actuate' changes the device's state or shows something to its holder.
 */
export type DeviceCapabilityEffect = 'capture' | 'read' | 'actuate';

/** Artifact class a capability yields, or 'none' when it retains nothing. */
export type DeviceArtifactKind = 'image' | 'video' | 'text' | 'geo' | 'none';

/**
 * How intrusive the capability is for the person holding the device. Purely
 * descriptive, it drives copy and ordering in the grants surface, never
 * whether "always allow" is offered (the ruling offers it on everything).
 */
export type DeviceCapabilitySensitivity = 'standard' | 'elevated';

/** One typed input field a capability accepts. */
export interface DeviceCapabilityField {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly description: string;
}

/** A single capability the contract defines. */
export interface DeviceCapabilityDescriptor {
  readonly id: DeviceCapabilityId;
  readonly family: DeviceCapabilityFamily;
  /** Short human label for surfaces. */
  readonly title: string;
  /** Written purpose: what it does and why a person would allow it. */
  readonly purpose: string;
  readonly effect: DeviceCapabilityEffect;
  readonly artifactKind: DeviceArtifactKind;
  readonly producesArtifact: boolean;
  /** Always 'ask-every-time', the owner-ruled default for every capture/effect. */
  readonly defaultDecision: 'ask-every-time';
  /** Always true, "always allow" is offered on every capability. */
  readonly allowAlwaysOffered: true;
  readonly sensitivity: DeviceCapabilitySensitivity;
  /**
   * Whether a browser requires a secure context (https, or loopback) to serve
   * this capability. Native nodes ignore it; a web node uses it to report an
   * honest "unavailable, and why" instead of a dead button.
   */
  readonly secureContextRequired: boolean;
  readonly inputFields: readonly DeviceCapabilityField[];
}

const CAMERA_FIELDS: readonly DeviceCapabilityField[] = [
  { name: 'reason', type: 'string', required: true, description: 'Why the picture is needed, shown verbatim on the confirmation prompt.' },
  { name: 'maxWidth', type: 'number', required: false, description: 'Longest-edge pixel cap applied on the device before upload.' },
];

const SCREEN_FIELDS: readonly DeviceCapabilityField[] = [
  { name: 'reason', type: 'string', required: true, description: 'Why the screen image is needed, shown verbatim on the confirmation prompt.' },
];

const LOCATION_FIELDS: readonly DeviceCapabilityField[] = [
  { name: 'reason', type: 'string', required: true, description: 'Why the location is needed, shown verbatim on the confirmation prompt.' },
  { name: 'maxAgeSeconds', type: 'number', required: false, description: 'Accept a cached fix no older than this instead of taking a new reading.' },
];

/** The v1 capability catalog. Node-kind neutral by construction. */
export const DEVICE_CAPABILITY_CATALOG: readonly DeviceCapabilityDescriptor[] = [
  {
    id: 'device.camera.rear.capture',
    family: 'camera',
    title: 'Rear camera picture',
    purpose: 'Take one still picture with the phone\'s rear camera and hand it to the agent, for reading a label, a screen, a whiteboard, or a part number in front of you.',
    effect: 'capture',
    artifactKind: 'image',
    producesArtifact: true,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: true,
    inputFields: CAMERA_FIELDS,
  },
  {
    id: 'device.camera.front.capture',
    family: 'camera',
    title: 'Front camera picture',
    purpose: 'Take one still picture with the phone\'s front (selfie) camera. Points at whoever is holding the phone, so it is treated as elevated, but "always allow" is offered here exactly as it is everywhere else.',
    effect: 'capture',
    artifactKind: 'image',
    producesArtifact: true,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'elevated',
    secureContextRequired: true,
    inputFields: CAMERA_FIELDS,
  },
  {
    id: 'device.screen.capture',
    family: 'screen',
    title: 'Screen picture',
    purpose: 'Capture what is currently on the phone\'s screen so the agent can read an app, an error, or a message you are looking at.',
    effect: 'capture',
    artifactKind: 'image',
    producesArtifact: true,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'elevated',
    secureContextRequired: true,
    inputFields: SCREEN_FIELDS,
  },
  {
    id: 'device.location.coarse',
    family: 'location',
    title: 'Approximate location',
    purpose: 'Report roughly where the phone is (city/neighbourhood scale) so the agent can answer "near me" questions without a street-level fix.',
    effect: 'read',
    artifactKind: 'geo',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: true,
    inputFields: LOCATION_FIELDS,
  },
  {
    id: 'device.location.precise',
    family: 'location',
    title: 'Precise location',
    purpose: 'Report the phone\'s exact position with accuracy, for navigation, arrival checks, and anything that needs a street-level fix.',
    effect: 'read',
    artifactKind: 'geo',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'elevated',
    secureContextRequired: true,
    inputFields: LOCATION_FIELDS,
  },
  {
    id: 'device.clipboard.read',
    family: 'clipboard',
    title: 'Read the clipboard',
    purpose: 'Read whatever text is on the phone\'s clipboard, so you can copy something on the phone and have the agent work with it without retyping it.',
    effect: 'read',
    artifactKind: 'text',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'elevated',
    secureContextRequired: true,
    inputFields: [
      { name: 'reason', type: 'string', required: true, description: 'Why the clipboard text is needed, shown verbatim on the confirmation prompt.' },
    ],
  },
  {
    id: 'device.clipboard.write',
    family: 'clipboard',
    title: 'Put text on the clipboard',
    purpose: 'Place text on the phone\'s clipboard so you can paste it into another app immediately.',
    effect: 'actuate',
    artifactKind: 'none',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: true,
    inputFields: [
      { name: 'text', type: 'string', required: true, description: 'The text to place on the clipboard.' },
      { name: 'reason', type: 'string', required: true, description: 'Why the text is being placed, shown verbatim on the confirmation prompt.' },
    ],
  },
  {
    id: 'device.command.notify',
    family: 'command',
    title: 'Show a notification',
    purpose: 'Show a notification on the phone, how the agent gets your attention on the device you are actually holding.',
    effect: 'actuate',
    artifactKind: 'none',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: true,
    inputFields: [
      { name: 'title', type: 'string', required: true, description: 'Notification title.' },
      { name: 'body', type: 'string', required: false, description: 'Notification body text.' },
      { name: 'reason', type: 'string', required: true, description: 'Why the notification is being sent, shown verbatim on the confirmation prompt.' },
    ],
  },
  {
    id: 'device.command.open_url',
    family: 'command',
    title: 'Open a link on the phone',
    purpose: 'Open a URL on the phone so a page, map, or ticket lands on the screen in your hand instead of on the desktop.',
    effect: 'actuate',
    artifactKind: 'none',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: false,
    inputFields: [
      { name: 'url', type: 'string', required: true, description: 'The http(s) URL to open.' },
      { name: 'reason', type: 'string', required: true, description: 'Why the link is being opened, shown verbatim on the confirmation prompt.' },
    ],
  },
  {
    id: 'device.command.vibrate',
    family: 'command',
    title: 'Vibrate the phone',
    purpose: 'Buzz the phone, a silent nudge when a run finishes or an approval is waiting.',
    effect: 'actuate',
    artifactKind: 'none',
    producesArtifact: false,
    defaultDecision: 'ask-every-time',
    allowAlwaysOffered: true,
    sensitivity: 'standard',
    secureContextRequired: false,
    inputFields: [
      { name: 'durationMs', type: 'number', required: false, description: 'Buzz length in milliseconds (device may clamp it).' },
      { name: 'reason', type: 'string', required: true, description: 'Why the phone is being buzzed, shown verbatim on the confirmation prompt.' },
    ],
  },
];

const CATALOG_BY_ID: ReadonlyMap<string, DeviceCapabilityDescriptor> = new Map(
  DEVICE_CAPABILITY_CATALOG.map((descriptor) => [descriptor.id, descriptor]),
);

/** Every capability id the contract defines, in catalog order. */
export const DEVICE_CAPABILITY_IDS: readonly DeviceCapabilityId[] =
  DEVICE_CAPABILITY_CATALOG.map((descriptor) => descriptor.id);

/** Type guard: is this string a capability the catalog defines? */
export function isDeviceCapabilityId(value: unknown): value is DeviceCapabilityId {
  return typeof value === 'string' && CATALOG_BY_ID.has(value);
}

/** Look up a capability descriptor, or null when the id is not in the catalog. */
export function getDeviceCapability(id: string): DeviceCapabilityDescriptor | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

/** Capabilities in one family, in catalog order. */
export function listDeviceCapabilitiesByFamily(
  family: DeviceCapabilityFamily,
): readonly DeviceCapabilityDescriptor[] {
  return DEVICE_CAPABILITY_CATALOG.filter((descriptor) => descriptor.family === family);
}

// ---------------------------------------------------------------------------
// Node kinds, open by design so Path B slots in without a contract change.
// ---------------------------------------------------------------------------

/**
 * Node kinds that ship or are planned. This list exists ONLY so surfaces can
 * render a friendly label; it is never used to accept or reject a node.
 */
export const KNOWN_DEVICE_NODE_KINDS: readonly string[] = [
  'web-pwa',
  'android-native',
  'ios-native',
];

/** A node kind slug. Any lowercase slug is valid, the list above is advisory. */
export type DeviceNodeKind = string;

const NODE_KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Accepts any well-formed lowercase slug, listed or not. */
export function isDeviceNodeKind(value: unknown): value is DeviceNodeKind {
  return typeof value === 'string' && value.length <= 40 && NODE_KIND_PATTERN.test(value);
}

/** What a node tells the host about itself when it pairs or heartbeats. */
export interface DeviceNodeAnnouncement {
  readonly nodeId: string;
  readonly nodeKind: DeviceNodeKind;
  readonly label: string;
  readonly platform?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly contractVersion: number;
  /** Capability ids the node implements. Unknown ids are reported, never fatal. */
  readonly capabilities: readonly string[];
  /**
   * Whether the node runs in a context that can serve secure-context-gated
   * capabilities. Native nodes report true; a web node reports its origin's
   * real posture so the host can explain an unavailable capability honestly.
   */
  readonly secureContext?: boolean | undefined;
}

/** The host's resolved view of a node's capability surface. */
export interface DeviceNodeProfile {
  readonly nodeId: string;
  readonly nodeKind: DeviceNodeKind;
  readonly label: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly contractVersion: number;
  readonly contractCompatible: boolean;
  /** Catalog capabilities this node declared AND can currently serve. */
  readonly supported: readonly DeviceCapabilityId[];
  /** Catalog capabilities this node did not declare at all. */
  readonly undeclared: readonly DeviceCapabilityId[];
  /**
   * Declared capabilities the node cannot currently serve because its context
   * is not secure. Reported so a surface labels WHY, never a dead button.
   */
  readonly gatedBySecureContext: readonly DeviceCapabilityId[];
  /** Ids the node declared that this catalog does not define (newer node, older host). */
  readonly unknownDeclared: readonly string[];
}

/** Why a node announcement was rejected. */
export type DeviceNodeRejectionReason =
  | 'missing-node-id'
  | 'invalid-node-kind'
  | 'missing-label'
  | 'unsupported-contract-version';

export type DeviceNodeResolution =
  | { readonly ok: true; readonly profile: DeviceNodeProfile }
  | { readonly ok: false; readonly reason: DeviceNodeRejectionReason; readonly detail: string };

/**
 * Resolve a node announcement into a capability profile.
 *
 * Node-kind neutral: the only thing checked about `nodeKind` is that it is a
 * well-formed slug. A second node type (a native Android node, say) resolves
 * through this exact path with no branch of its own, which is what makes it a
 * peer rather than a special case.
 */
export function resolveDeviceNodeProfile(
  announcement: DeviceNodeAnnouncement,
): DeviceNodeResolution {
  const nodeId = announcement.nodeId?.trim() ?? '';
  if (!nodeId) {
    return { ok: false, reason: 'missing-node-id', detail: 'A device node must announce a stable nodeId.' };
  }
  if (!isDeviceNodeKind(announcement.nodeKind)) {
    return {
      ok: false,
      reason: 'invalid-node-kind',
      detail: `nodeKind must be a lowercase slug (got ${JSON.stringify(announcement.nodeKind)}).`,
    };
  }
  const label = announcement.label?.trim() ?? '';
  if (!label) {
    return { ok: false, reason: 'missing-label', detail: 'A device node must announce a human label.' };
  }
  if (!Number.isInteger(announcement.contractVersion) || announcement.contractVersion < 1) {
    return {
      ok: false,
      reason: 'unsupported-contract-version',
      detail: `contractVersion must be a positive integer (got ${String(announcement.contractVersion)}).`,
    };
  }

  const declared = new Set(announcement.capabilities.filter((id) => typeof id === 'string'));
  const secureContext = announcement.secureContext !== false;
  const supported: DeviceCapabilityId[] = [];
  const undeclared: DeviceCapabilityId[] = [];
  const gatedBySecureContext: DeviceCapabilityId[] = [];

  for (const descriptor of DEVICE_CAPABILITY_CATALOG) {
    if (!declared.has(descriptor.id)) {
      undeclared.push(descriptor.id);
      continue;
    }
    if (descriptor.secureContextRequired && !secureContext) {
      gatedBySecureContext.push(descriptor.id);
      continue;
    }
    supported.push(descriptor.id);
  }

  const unknownDeclared = [...declared].filter((id) => !CATALOG_BY_ID.has(id)).sort();

  return {
    ok: true,
    profile: {
      nodeId,
      nodeKind: announcement.nodeKind,
      label,
      platform: announcement.platform?.trim() ?? '',
      appVersion: announcement.appVersion?.trim() ?? '',
      contractVersion: announcement.contractVersion,
      contractCompatible: announcement.contractVersion <= DEVICE_CAPABILITY_CONTRACT_VERSION,
      supported,
      undeclared,
      gatedBySecureContext,
      unknownDeclared,
    },
  };
}

/** Friendly label for a node kind; unlisted kinds get a title-cased slug. */
export function describeDeviceNodeKind(kind: DeviceNodeKind): string {
  if (kind === 'web-pwa') return 'Web app on the phone';
  if (kind === 'android-native') return 'Android app';
  if (kind === 'ios-native') return 'iOS app';
  return kind.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
