/**
 * schema-domain-device.ts — paired-device capabilities (`device.*`).
 *
 * Configuration for using a paired phone's camera, screen, location, clipboard,
 * and device commands as agent tools. Every key here is a real, shaped choice
 * with a written purpose — there is no bare on/off toggle standing in for a
 * feature.
 *
 * The stock values ARE the owner's rulings of 2026-07-25, not a conservative
 * subset of them: ask-every-time is the default decision for every capture and
 * effect, "always allow" is offered on every capability (front camera, screen
 * capture, precise location, and clipboard included), captures are retained for
 * 24 hours, and `device.clipboard.read` ships enabled and grantable. The
 * tightening values exist so an owner can narrow the posture later; nothing has
 * to be turned ON to match the ruling.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';
import { intRange } from './schema-shared.js';

/** Paired-device capability configuration (`device.*`). */
export interface DeviceConfig {
  capabilities: {
    mode: string;
    allowAlwaysOffer: string;
    requestTimeoutSeconds: number;
  };
  location: {
    precision: string;
  };
  clipboard: {
    readMode: string;
  };
  capture: {
    retentionHours: number;
    maxArtifacts: number;
    sweepIntervalMinutes: number;
  };
  grants: {
    expiryDays: number;
    maxPerNode: number;
    auditRetentionDays: number;
  };
  nodes: {
    maxPaired: number;
  };
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    device: DeviceConfig;
  }
}

export const deviceConfigDefaults: { device: DeviceConfig } = {
  device: {
    capabilities: {
      mode: 'honor-grants',
      allowAlwaysOffer: 'every-capability',
      requestTimeoutSeconds: 60,
    },
    location: {
      precision: 'precise-grantable',
    },
    clipboard: {
      readMode: 'grantable',
    },
    capture: {
      retentionHours: 24,
      maxArtifacts: 200,
      sweepIntervalMinutes: 30,
    },
    grants: {
      expiryDays: 90,
      maxPerNode: 64,
      auditRetentionDays: 30,
    },
    nodes: {
      maxPaired: 8,
    },
  },
};

export const deviceConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'device.capabilities.mode',
    type: 'enum',
    default: 'honor-grants',
    enumValues: ['off', 'ask-every-time', 'honor-grants'],
    description: 'How a paired phone\'s camera, screen, location, clipboard, and device commands are reached. honor-grants (stock): every capability asks the first time and every time after, unless you chose "always allow" for that one capability on that one phone. ask-every-time: the prompt appears on every single request and no durable grant is ever consulted or offered — use it when someone else is holding the phone. off: no capability request reaches any paired device at all.',
  },
  {
    key: 'device.capabilities.allowAlwaysOffer',
    type: 'enum',
    default: 'every-capability',
    enumValues: ['every-capability', 'standard-only', 'never'],
    description: 'Which capabilities may offer a durable "always allow" on their confirmation prompt. every-capability (stock): all of them, front camera, screen capture, precise location, and clipboard included. standard-only: the elevated ones (front camera, screen capture, precise location, clipboard read) still ask every time and never offer a grant, while everyday ones can be granted. never: no durable grant is ever offered anywhere; existing grants stop being honoured.',
  },
  {
    key: 'device.capabilities.requestTimeoutSeconds',
    type: 'number',
    default: 60,
    ...intRange(5, 600),
    description: 'How long the agent waits for a phone to answer one capability request before giving up. A phone that is asleep or off the network usually answers within a few seconds of waking; a long timeout keeps a slow wake from failing, a short one keeps the agent from stalling.',
  },
  {
    key: 'device.location.precision',
    type: 'enum',
    default: 'precise-grantable',
    enumValues: ['coarse-only', 'ask-precise', 'precise-grantable'],
    description: 'How exact a location the phone will report. precise-grantable (stock): both approximate and street-level fixes are available, and either may be granted durably. ask-precise: street-level fixes are available but always ask, and never offer "always allow". coarse-only: street-level fixes are refused entirely; only city-scale approximate location is served.',
  },
  {
    key: 'device.clipboard.readMode',
    type: 'enum',
    default: 'grantable',
    enumValues: ['off', 'ask-only', 'grantable'],
    description: 'Whether the agent can read what is on the phone\'s clipboard. grantable (stock): it asks every time and offers "always allow", like every other capability. ask-only: it asks every time and never offers a durable grant. off: clipboard reads are refused; putting text ON the clipboard is unaffected.',
  },
  {
    key: 'device.capture.retentionHours',
    type: 'number',
    default: 24,
    ...intRange(1, 720),
    description: 'How long a picture taken by the phone\'s camera or screen capture is kept before it is deleted and the deletion recorded. Stock is 24 hours: long enough for the work the picture was taken for, short enough that a photo of your desk is not still on disk next week.',
  },
  {
    key: 'device.capture.maxArtifacts',
    type: 'number',
    default: 200,
    ...intRange(1, 5000),
    description: 'How many captures are kept at once across all paired phones. Past this count the oldest are deleted even while inside the retention window, so a burst of captures cannot fill the disk between sweeps.',
  },
  {
    key: 'device.capture.sweepIntervalMinutes',
    type: 'number',
    default: 30,
    ...intRange(1, 1440),
    description: 'How often housekeeping runs over stored captures and grants while the runtime is up. A sweep also runs at every start; this interval is what keeps a long-running daemon from going days without one. Each sweep writes what it removed and why.',
  },
  {
    key: 'device.grants.expiryDays',
    type: 'number',
    default: 90,
    ...intRange(1, 3650),
    description: 'How long an "always allow" grant lasts before it expires and the capability starts asking again. Nothing is granted forever: an expired grant is removed by housekeeping and is never honoured in the meantime.',
  },
  {
    key: 'device.grants.maxPerNode',
    type: 'number',
    default: 64,
    ...intRange(1, 512),
    description: 'How many "always allow" grants one phone may hold at once. Past this count the oldest grants for that phone are removed, so a paired device cannot accumulate authority indefinitely.',
  },
  {
    key: 'device.grants.auditRetentionDays',
    type: 'number',
    default: 30,
    ...intRange(1, 365),
    description: 'How long the grants ledger keeps its record of grants given, used, revoked, and expired. This is what the grants surface shows you when you ask what a phone has been allowed to do and when.',
  },
  {
    key: 'device.nodes.maxPaired',
    type: 'number',
    default: 8,
    ...intRange(1, 64),
    description: 'How many phones may be paired as device nodes at once. Each paired phone is a separate identity with its own grants; this bounds how many can be outstanding before an old one has to be unpaired.',
  },
];
