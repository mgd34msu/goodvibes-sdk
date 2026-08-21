/**
 * device-peer-work.ts, the wire shape of one device capability request.
 *
 * A capability request rides the existing distributed-runtime peer transport as
 * work of type `device.capability`: the host enqueues it, the node pulls it,
 * runs it, and completes it. This module is the ONE definition of what goes on
 * the wire in each direction, so a host and a node written independently, in
 * different languages, on different platforms, agree without reading each
 * other's code. That is what makes a native node a drop-in peer rather than a
 * second implementation to keep in sync.
 *
 * Runtime-neutral: importable by a browser node and by the daemon alike.
 */
import { getDeviceCapability, type DeviceCapabilityId } from './device-capability-contract.js';

/** Work type this contract uses on the peer transport. */
export const DEVICE_CAPABILITY_WORK_TYPE = 'device.capability';

/** The request payload the host enqueues. */
export interface DeviceCapabilityWorkRequest {
  readonly contractVersion: number;
  readonly capabilityId: DeviceCapabilityId;
  /** Free-form per-capability inputs, validated against the descriptor's fields. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Stated reason, shown to the person on the device when it prompts. */
  readonly reason: string;
  /** Host-side deadline in ms; a node that cannot finish in time should fail fast. */
  readonly timeoutMs: number;
}

/** The result payload the node returns on completion. */
export interface DeviceCapabilityWorkResult {
  readonly contractVersion: number;
  readonly capabilityId: DeviceCapabilityId;
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** Structured result (a location fix, clipboard text, a command ack). */
  readonly data?: unknown | undefined;
  /** Base64 payload for a capture. Kept out of `data` so a host can stream it. */
  readonly mediaBase64?: string | undefined;
  readonly mediaType?: string | undefined;
}

/** Why a request payload was rejected before it reached the device. */
export interface DeviceCapabilityInputProblem {
  readonly field: string;
  readonly problem: 'missing' | 'wrong-type';
  readonly expected: string;
}

/**
 * Validate a request's inputs against the capability descriptor's declared
 * fields. Runs on the host before dispatch AND on the node before it acts, so
 * neither side has to trust the other's validation.
 */
export function validateDeviceCapabilityInput(
  capabilityId: string,
  input: Readonly<Record<string, unknown>>,
): readonly DeviceCapabilityInputProblem[] {
  const descriptor = getDeviceCapability(capabilityId);
  if (!descriptor) return [{ field: 'capabilityId', problem: 'wrong-type', expected: 'a capability id this contract defines' }];
  const problems: DeviceCapabilityInputProblem[] = [];
  for (const field of descriptor.inputFields) {
    const value = input[field.name];
    if (value === undefined || value === null || (field.type === 'string' && typeof value === 'string' && !value.trim())) {
      if (field.required) problems.push({ field: field.name, problem: 'missing', expected: field.type });
      continue;
    }
    if (typeof value !== field.type) {
      problems.push({ field: field.name, problem: 'wrong-type', expected: field.type });
    }
  }
  return problems;
}

/** Build the request payload for the peer work queue. */
export function buildDeviceCapabilityWorkRequest(input: {
  readonly capabilityId: DeviceCapabilityId;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly timeoutMs: number;
  readonly contractVersion: number;
}): DeviceCapabilityWorkRequest {
  return {
    contractVersion: input.contractVersion,
    capabilityId: input.capabilityId,
    input: input.input,
    reason: input.reason,
    timeoutMs: input.timeoutMs,
  };
}

/** Parse a work payload a node pulled, or null when it is not a device request. */
export function parseDeviceCapabilityWorkRequest(payload: unknown): DeviceCapabilityWorkRequest | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const capabilityId = record.capabilityId;
  if (typeof capabilityId !== 'string' || !getDeviceCapability(capabilityId)) return null;
  const contractVersion = typeof record.contractVersion === 'number' ? record.contractVersion : 1;
  const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? record.timeoutMs : 60_000;
  const rawInput = record.input;
  return {
    contractVersion,
    capabilityId: capabilityId as DeviceCapabilityId,
    input: rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {},
    reason: typeof record.reason === 'string' ? record.reason : '',
    timeoutMs,
  };
}

/** Parse a node's completion payload, or null when it is not one. */
export function parseDeviceCapabilityWorkResult(payload: unknown): DeviceCapabilityWorkResult | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const capabilityId = record.capabilityId;
  if (typeof capabilityId !== 'string' || !getDeviceCapability(capabilityId)) return null;
  return {
    contractVersion: typeof record.contractVersion === 'number' ? record.contractVersion : 1,
    capabilityId: capabilityId as DeviceCapabilityId,
    ok: record.ok === true,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(record.data === undefined ? {} : { data: record.data }),
    ...(typeof record.mediaBase64 === 'string' ? { mediaBase64: record.mediaBase64 } : {}),
    ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
  };
}

/**
 * Encode capture bytes the way this contract carries them, the exact inverse
 * of `decodeDeviceCapabilityMedia`.
 *
 * The node encodes a capture to reach the host; the host encodes the same bytes
 * again to reach a surface that is not on its disk (devices.artifacts.read).
 * One definition of "base64 of a capture" means those two directions cannot
 * drift apart, and it stays runtime-neutral: `btoa` exists in a browser node
 * and in the daemon alike, where `Buffer` does not.
 */
export function encodeDeviceCapabilityMedia(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a multi-megabyte screenshot does not blow the argument limit
  // that spreading the whole array into String.fromCharCode would hit.
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** Decode a completion's media payload into bytes, or null when there is none. */
export function decodeDeviceCapabilityMedia(result: DeviceCapabilityWorkResult): Uint8Array | null {
  if (!result.mediaBase64) return null;
  try {
    const binary = atob(result.mediaBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
