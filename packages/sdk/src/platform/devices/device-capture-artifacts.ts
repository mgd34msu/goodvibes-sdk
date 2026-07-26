/**
 * device-capture-artifacts.ts — retained camera/screen captures from a paired device.
 *
 * Retention is 24 hours by default (owner ruling 2026-07-25: "Capture artifact
 * retention: 24 hours"). A capture is evidence for one piece of work, not an
 * archive: past its TTL the bytes are deleted from disk and the record is
 * removed, and the removal is disclosed rather than done silently.
 *
 * Persisted bytes plus a persisted index means two things can rot
 * independently, so this store validates by CONTENT, never by existence:
 *  - a record whose file is missing is reaped ('file-missing'),
 *  - a record whose file no longer hashes to the recorded digest is reaped
 *    ('content-mismatch') — that is exactly the crash-torn / half-written /
 *    zero-filled case that an `if (exists) return cached` check would serve as
 *    if it were real,
 *  - a file with no record is reaped as an orphan ('orphan-file'), which is
 *    what a crash between "write bytes" and "write index" leaves behind.
 *
 * `read()` re-validates the digest before handing bytes back, so a corrupted
 * artifact is never returned to the agent even between sweeps.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { PersistentStore } from '../state/persistent-store.js';
import { isDeviceCapabilityId, type DeviceArtifactKind, type DeviceCapabilityId } from './device-capability-contract.js';

/** Index row for one retained capture. */
export interface DeviceCaptureArtifact {
  readonly id: string;
  readonly nodeId: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly kind: DeviceArtifactKind;
  readonly mediaType: string;
  readonly fileName: string;
  readonly byteLength: number;
  /** Digest written with the record; re-checked on every read and every sweep. */
  readonly sha256: string;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly workId?: string | undefined;
  readonly reason?: string | undefined;
}

export type DeviceArtifactRemovalReason =
  | 'expired'
  | 'file-missing'
  | 'content-mismatch'
  | 'orphan-file'
  | 'malformed'
  | 'count-cap';

export interface DeviceArtifactRemoval {
  readonly artifactId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly fileName: string;
  readonly reason: DeviceArtifactRemovalReason;
  readonly removedAt: number;
  readonly byteLength: number;
}

export interface DeviceArtifactSweepReport {
  readonly sweptAt: number;
  readonly removed: readonly DeviceArtifactRemoval[];
  readonly retained: number;
  readonly bytesReclaimed: number;
}

export interface DeviceArtifactPolicy {
  /** Age TTL for a capture. Default 24h per the owner ruling. */
  readonly retentionMs: number;
  /** Count cap; oldest captures past the cap are reaped even inside the TTL. */
  readonly maxArtifacts: number;
}

export const DEFAULT_DEVICE_ARTIFACT_POLICY: DeviceArtifactPolicy = {
  retentionMs: 24 * 60 * 60 * 1000,
  maxArtifacts: 200,
};

interface DeviceArtifactSnapshot extends Record<string, unknown> {
  readonly version: 1;
  readonly artifacts: readonly DeviceCaptureArtifact[];
}

const ARTIFACT_KINDS: readonly DeviceArtifactKind[] = ['image', 'video', 'text', 'geo', 'none'];

function validateArtifact(value: unknown): DeviceCaptureArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : '';
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim() : '';
  const kind = record.kind;
  if (!id || !nodeId || !fileName || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!isDeviceCapabilityId(record.capabilityId)) return null;
  if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind as DeviceArtifactKind)) return null;
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null;
  const byteLength = record.byteLength;
  const capturedAt = record.capturedAt;
  const expiresAt = record.expiresAt;
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 0) return null;
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return {
    id,
    nodeId,
    capabilityId: record.capabilityId,
    kind: kind as DeviceArtifactKind,
    mediaType: typeof record.mediaType === 'string' && record.mediaType ? record.mediaType : 'application/octet-stream',
    fileName,
    byteLength,
    sha256,
    capturedAt,
    expiresAt,
    ...(typeof record.workId === 'string' && record.workId ? { workId: record.workId } : {}),
    ...(typeof record.reason === 'string' && record.reason ? { reason: record.reason } : {}),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface DeviceCaptureStoreOptions {
  readonly policy?: Partial<DeviceArtifactPolicy> | undefined;
  readonly now?: (() => number) | undefined;
}

/** Read outcome: either verified bytes, or an honest reason they are gone. */
export type DeviceArtifactReadResult =
  | { readonly ok: true; readonly artifact: DeviceCaptureArtifact; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'not-found' | 'expired' | 'file-missing' | 'content-mismatch' };

/** Retained captures: bytes under `directory`, index beside them. */
export class DeviceCaptureArtifactStore {
  private readonly directory: string;
  private readonly index: PersistentStore<DeviceArtifactSnapshot>;
  private readonly policy: DeviceArtifactPolicy;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string, options: DeviceCaptureStoreOptions = {}) {
    this.directory = resolve(directory);
    this.index = new PersistentStore<DeviceArtifactSnapshot>(join(this.directory, 'capture-index.json'));
    this.policy = { ...DEFAULT_DEVICE_ARTIFACT_POLICY, ...(options.policy ?? {}) };
    this.now = options.now ?? (() => Date.now());
  }

  getPolicy(): DeviceArtifactPolicy {
    return this.policy;
  }

  getDirectory(): string {
    return this.directory;
  }

  private async readWithDrops(): Promise<{ artifacts: DeviceCaptureArtifact[]; malformed: number }> {
    const raw = await this.index.load();
    const rawArtifacts = Array.isArray(raw?.artifacts) ? raw.artifacts : [];
    const artifacts = rawArtifacts
      .map(validateArtifact)
      .filter((entry): entry is DeviceCaptureArtifact => entry !== null);
    return { artifacts, malformed: rawArtifacts.length - artifacts.length };
  }

  private async mutate<T>(
    fn: (artifacts: DeviceCaptureArtifact[], malformed: number) => Promise<{ next: DeviceCaptureArtifact[]; result: T }>,
  ): Promise<T> {
    const run = this.writeChain.then(async () => {
      const { artifacts, malformed } = await this.readWithDrops();
      const { next, result } = await fn(artifacts, malformed);
      await this.index.persist({ version: 1, artifacts: next });
      return result;
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Live (unexpired) capture records, newest first. */
  async list(nodeId?: string): Promise<readonly DeviceCaptureArtifact[]> {
    const now = this.now();
    const { artifacts } = await this.readWithDrops();
    return artifacts
      .filter((artifact) => artifact.expiresAt > now && (!nodeId || artifact.nodeId === nodeId))
      .sort((a, b) => b.capturedAt - a.capturedAt);
  }

  /**
   * Retain bytes from a capture.
   *
   * The bytes are written FIRST and the index row second, so a crash between
   * the two leaves an orphan file (reaped as 'orphan-file') rather than an
   * index row pointing at nothing that a later read would trust.
   */
  async retain(input: {
    readonly nodeId: string;
    readonly capabilityId: DeviceCapabilityId;
    readonly kind: DeviceArtifactKind;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly workId?: string | undefined;
    readonly reason?: string | undefined;
    readonly ttlMs?: number | undefined;
  }): Promise<DeviceCaptureArtifact> {
    const now = this.now();
    const id = randomUUID();
    const extension = input.mediaType.includes('png') ? 'png'
      : input.mediaType.includes('webp') ? 'webp'
        : input.mediaType.includes('jpeg') || input.mediaType.includes('jpg') ? 'jpg'
          : input.mediaType.includes('webm') ? 'webm'
            : 'bin';
    const fileName = `${id}.${extension}`;
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(join(this.directory, fileName), input.bytes);
    const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : this.policy.retentionMs;
    const artifact: DeviceCaptureArtifact = {
      id,
      nodeId: input.nodeId,
      capabilityId: input.capabilityId,
      kind: input.kind,
      mediaType: input.mediaType,
      fileName,
      byteLength: input.bytes.byteLength,
      sha256: digest(input.bytes),
      capturedAt: now,
      expiresAt: now + ttl,
      ...(input.workId ? { workId: input.workId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    return this.mutate(async (artifacts) => ({ next: [...artifacts, artifact], result: artifact }));
  }

  /** Absolute path of a retained capture's bytes. */
  pathFor(artifact: DeviceCaptureArtifact): string {
    return join(this.directory, artifact.fileName);
  }

  /**
   * Read a capture back, re-hashing the bytes before returning them. A record
   * that no longer matches its digest is reaped on the spot rather than served.
   */
  async read(artifactId: string): Promise<DeviceArtifactReadResult> {
    const now = this.now();
    const { artifacts } = await this.readWithDrops();
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) return { ok: false, reason: 'not-found' };
    if (artifact.expiresAt <= now) {
      await this.sweep();
      return { ok: false, reason: 'expired' };
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(this.pathFor(artifact));
    } catch {
      await this.sweep();
      return { ok: false, reason: 'file-missing' };
    }
    if (digest(bytes) !== artifact.sha256) {
      await this.sweep();
      return { ok: false, reason: 'content-mismatch' };
    }
    return { ok: true, artifact, bytes };
  }

  /**
   * One housekeeping pass over records AND bytes. Idempotent and concurrency
   * safe: it recomputes every removal from what it just read, and deleting an
   * already-deleted file is tolerated.
   */
  async sweep(): Promise<DeviceArtifactSweepReport> {
    const now = this.now();
    let onDisk: string[] = [];
    try {
      onDisk = (await fs.readdir(this.directory)).filter((name) => name !== 'capture-index.json');
    } catch {
      onDisk = [];
    }

    return this.mutate(async (artifacts, malformed) => {
      const removals: DeviceArtifactRemoval[] = [];
      if (malformed > 0) {
        removals.push({
          artifactId: '(unreadable)',
          nodeId: '(unknown)',
          capabilityId: '(unknown)',
          fileName: '(unknown)',
          reason: 'malformed',
          removedAt: now,
          byteLength: 0,
        });
      }

      const surviving: DeviceCaptureArtifact[] = [];
      const deleteFiles: string[] = [];
      for (const artifact of artifacts) {
        if (artifact.expiresAt <= now) {
          removals.push({ artifactId: artifact.id, nodeId: artifact.nodeId, capabilityId: artifact.capabilityId, fileName: artifact.fileName, reason: 'expired', removedAt: now, byteLength: artifact.byteLength });
          deleteFiles.push(artifact.fileName);
          continue;
        }
        let bytes: Uint8Array | null = null;
        try {
          bytes = await fs.readFile(this.pathFor(artifact));
        } catch {
          bytes = null;
        }
        if (!bytes) {
          removals.push({ artifactId: artifact.id, nodeId: artifact.nodeId, capabilityId: artifact.capabilityId, fileName: artifact.fileName, reason: 'file-missing', removedAt: now, byteLength: artifact.byteLength });
          continue;
        }
        if (digest(bytes) !== artifact.sha256) {
          removals.push({ artifactId: artifact.id, nodeId: artifact.nodeId, capabilityId: artifact.capabilityId, fileName: artifact.fileName, reason: 'content-mismatch', removedAt: now, byteLength: artifact.byteLength });
          deleteFiles.push(artifact.fileName);
          continue;
        }
        surviving.push(artifact);
      }

      surviving.sort((a, b) => a.capturedAt - b.capturedAt);
      const overflow = surviving.length - this.policy.maxArtifacts;
      const kept: DeviceCaptureArtifact[] = [];
      for (let index = 0; index < surviving.length; index += 1) {
        const artifact = surviving[index];
        if (!artifact) continue;
        if (index < overflow) {
          removals.push({ artifactId: artifact.id, nodeId: artifact.nodeId, capabilityId: artifact.capabilityId, fileName: artifact.fileName, reason: 'count-cap', removedAt: now, byteLength: artifact.byteLength });
          deleteFiles.push(artifact.fileName);
          continue;
        }
        kept.push(artifact);
      }

      const keptNames = new Set(kept.map((artifact) => artifact.fileName));
      for (const name of onDisk) {
        if (keptNames.has(name) || deleteFiles.includes(name)) continue;
        let size = 0;
        try {
          size = (await fs.stat(join(this.directory, name))).size;
        } catch {
          continue;
        }
        removals.push({ artifactId: '(orphan)', nodeId: '(unknown)', capabilityId: '(unknown)', fileName: name, reason: 'orphan-file', removedAt: now, byteLength: size });
        deleteFiles.push(name);
      }

      for (const name of deleteFiles) {
        await fs.rm(join(this.directory, name), { force: true }).catch(() => undefined);
      }

      return {
        next: kept,
        result: {
          sweptAt: now,
          removed: removals,
          retained: kept.length,
          bytesReclaimed: removals.reduce((total, removal) => total + removal.byteLength, 0),
        } satisfies DeviceArtifactSweepReport,
      };
    });
  }
}
