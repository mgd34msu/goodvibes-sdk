/**
 * device-posture-config.ts — the mapping from the `device.*` settings to the
 * policy structs the device stores and the capability service enforce.
 *
 * This mapping used to live in one consumer (the agent's phone-device-service),
 * which meant every OTHER daemon host — the terminal app's daemon included —
 * ran the device feature on the struct defaults and silently ignored what the
 * owner had set. The mapping is not surface-specific: the same eleven keys mean
 * the same thing to every host, so it belongs here with the contract, and each
 * surface supplies only its own I/O (a config reader, a peer transport, an
 * approval path).
 *
 * Two rules hold for every reader below:
 *
 *  - A value that is not the shape the key declares (a number that is not
 *    finite or not positive, an enum value outside its list) reads as the STOCK
 *    value rather than being passed through. A broken setting must never turn
 *    into a broken posture — and never into a wider one.
 *
 *  - Nothing is cached. Each function reads through to the reader every time it
 *    is called, so a host that resolves policy per request (see
 *    device-posture-runtime.ts) honours a settings change without a restart.
 *
 * `device.nodes.maxPaired` is deliberately NOT here: pairing enforces it where a
 * device pairs (platform/pairing/pairing-token-store.ts), before any of this is
 * reached.
 */
import type { ConfigKey } from '../config/schema-types.js';
import {
  DEFAULT_DEVICE_CAPABILITY_POLICY,
  type DeviceAllowAlwaysOffer,
  type DeviceCapabilityMode,
  type DeviceCapabilityPolicy,
  type DeviceClipboardReadMode,
  type DeviceLocationPrecision,
} from './device-capability-service.js';
import { DEFAULT_DEVICE_GRANT_POLICY, type DeviceGrantPolicy } from './device-grants.js';
import { DEFAULT_DEVICE_ARTIFACT_POLICY, type DeviceArtifactPolicy } from './device-capture-artifacts.js';

/**
 * Every `device.*` key this mapping reads, in schema order. Exported so a
 * surface's settings-coverage verification can name the exact set that is wired
 * rather than asserting on a hand-copied list.
 */
export const DEVICE_POSTURE_CONFIG_KEYS = [
  'device.capabilities.mode',
  'device.capabilities.allowAlwaysOffer',
  'device.capabilities.requestTimeoutSeconds',
  'device.location.precision',
  'device.clipboard.readMode',
  'device.capture.retentionHours',
  'device.capture.maxArtifacts',
  'device.capture.sweepIntervalMinutes',
  'device.grants.expiryDays',
  'device.grants.maxPerNode',
  'device.grants.auditRetentionDays',
] as const satisfies readonly ConfigKey[];

export type DevicePostureConfigKey = typeof DEVICE_POSTURE_CONFIG_KEYS[number];

/**
 * The slice of a configuration manager this mapping needs. A real
 * `ConfigManager` satisfies it; a test can pass a plain object.
 */
export interface DevicePostureConfigReader {
  get(key: DevicePostureConfigKey): unknown;
}

/** Everything one host's device feature is configured with, resolved together. */
export interface DevicePostureSettings {
  readonly capability: DeviceCapabilityPolicy;
  readonly grants: DeviceGrantPolicy;
  readonly artifacts: DeviceArtifactPolicy;
  /** Period of the housekeeping sweep, from `device.capture.sweepIntervalMinutes`. */
  readonly sweepIntervalMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CAPABILITY_MODES: readonly DeviceCapabilityMode[] = ['off', 'ask-every-time', 'honor-grants'];
const ALLOW_ALWAYS_OFFERS: readonly DeviceAllowAlwaysOffer[] = ['every-capability', 'standard-only', 'never'];
const LOCATION_PRECISIONS: readonly DeviceLocationPrecision[] = ['coarse-only', 'ask-precise', 'precise-grantable'];
const CLIPBOARD_READ_MODES: readonly DeviceClipboardReadMode[] = ['off', 'ask-only', 'grantable'];

/** A positive finite number, or the stock value. */
function readPositiveNumber(reader: DevicePostureConfigReader, key: DevicePostureConfigKey, fallback: number): number {
  const value: unknown = reader.get(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** One of the enum's declared values, or the stock value. */
function readEnum<T extends string>(
  reader: DevicePostureConfigReader,
  key: DevicePostureConfigKey,
  allowed: readonly T[],
  fallback: T,
): T {
  const value: unknown = reader.get(key);
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/**
 * The posture the capability service enforces per request: the mode, what may
 * be granted durably, how exact a location is served, whether the clipboard can
 * be read, how long a device has to answer, and how long a capture is kept.
 */
export function readDeviceCapabilityPolicy(reader: DevicePostureConfigReader): DeviceCapabilityPolicy {
  return {
    mode: readEnum(reader, 'device.capabilities.mode', CAPABILITY_MODES, DEFAULT_DEVICE_CAPABILITY_POLICY.mode),
    allowAlwaysOffer: readEnum(
      reader,
      'device.capabilities.allowAlwaysOffer',
      ALLOW_ALWAYS_OFFERS,
      DEFAULT_DEVICE_CAPABILITY_POLICY.allowAlwaysOffer,
    ),
    locationPrecision: readEnum(
      reader,
      'device.location.precision',
      LOCATION_PRECISIONS,
      DEFAULT_DEVICE_CAPABILITY_POLICY.locationPrecision,
    ),
    clipboardReadMode: readEnum(
      reader,
      'device.clipboard.readMode',
      CLIPBOARD_READ_MODES,
      DEFAULT_DEVICE_CAPABILITY_POLICY.clipboardReadMode,
    ),
    requestTimeoutMs: readDeviceRequestTimeoutMs(reader),
    captureRetentionMs: readPositiveNumber(
      reader,
      'device.capture.retentionHours',
      DEFAULT_DEVICE_ARTIFACT_POLICY.retentionMs / HOUR,
    ) * HOUR,
  };
}

/**
 * How long one capability request may take. Read on its own as well as through
 * the policy, because it is also the deadline on the confirmation prompt — a
 * question nobody answers must not outlive the request it belongs to.
 */
export function readDeviceRequestTimeoutMs(reader: DevicePostureConfigReader): number {
  return readPositiveNumber(
    reader,
    'device.capabilities.requestTimeoutSeconds',
    DEFAULT_DEVICE_CAPABILITY_POLICY.requestTimeoutMs / SECOND,
  ) * SECOND;
}

/**
 * Grant-ledger bounds. `maxGrantsTotal` and `maxAuditRecords` have no settings
 * key — they are absolute safety bounds on persisted state — so the struct
 * defaults stand for them.
 */
export function readDeviceGrantPolicy(reader: DevicePostureConfigReader): DeviceGrantPolicy {
  return {
    ...DEFAULT_DEVICE_GRANT_POLICY,
    grantTtlMs: readPositiveNumber(
      reader,
      'device.grants.expiryDays',
      DEFAULT_DEVICE_GRANT_POLICY.grantTtlMs / DAY,
    ) * DAY,
    maxGrantsPerNode: Math.floor(readPositiveNumber(
      reader,
      'device.grants.maxPerNode',
      DEFAULT_DEVICE_GRANT_POLICY.maxGrantsPerNode,
    )),
    auditRetentionMs: readPositiveNumber(
      reader,
      'device.grants.auditRetentionDays',
      DEFAULT_DEVICE_GRANT_POLICY.auditRetentionMs / DAY,
    ) * DAY,
  };
}

/** Capture retention window and count cap. */
export function readDeviceArtifactPolicy(reader: DevicePostureConfigReader): DeviceArtifactPolicy {
  return {
    retentionMs: readPositiveNumber(
      reader,
      'device.capture.retentionHours',
      DEFAULT_DEVICE_ARTIFACT_POLICY.retentionMs / HOUR,
    ) * HOUR,
    maxArtifacts: Math.floor(readPositiveNumber(
      reader,
      'device.capture.maxArtifacts',
      DEFAULT_DEVICE_ARTIFACT_POLICY.maxArtifacts,
    )),
  };
}

/** Housekeeping cadence. */
export function readDeviceSweepIntervalMs(reader: DevicePostureConfigReader): number {
  return readPositiveNumber(reader, 'device.capture.sweepIntervalMinutes', 30) * MINUTE;
}

/** All four resolved together, for a caller that wants to report the posture. */
export function readDevicePostureSettings(reader: DevicePostureConfigReader): DevicePostureSettings {
  return {
    capability: readDeviceCapabilityPolicy(reader),
    grants: readDeviceGrantPolicy(reader),
    artifacts: readDeviceArtifactPolicy(reader),
    sweepIntervalMs: readDeviceSweepIntervalMs(reader),
  };
}
