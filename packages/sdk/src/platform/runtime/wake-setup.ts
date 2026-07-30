/**
 * wake-setup.ts — the daemon's wake-word provisioning and model service.
 *
 * WHY THE DAEMON HAS TO SERVE THE MODEL BYTES
 *
 * A browser tab runs the same detector as a host, and it cannot fetch the pinned
 * artifacts itself: the release assets they are hosted at answer without an
 * `access-control-allow-origin` header, so a cross-origin fetch from the web UI's
 * origin is refused by the browser before it ever sees the bytes. Checked rather
 * than assumed. A tab therefore reads the model from the daemon, same-origin,
 * through {@link WakeSetupService.modelChunk}.
 *
 * CHUNKED, BOUNDED, AND VERIFIABLE
 *
 * The classifier is 2.4 MB and the front end 1.3 MB, which base64 to more than
 * either should be asked to carry in one request/response. So the read is offset
 * based and capped, and every chunk restates `totalBytes` and the artifact's
 * PINNED sha256 — the client reassembles and verifies against the pin with
 * WebCrypto, which means a truncated transfer or a swapped file fails at the
 * consumer instead of loading as a model that silently never detects.
 *
 * WHO ASKS FOR THE DOWNLOAD
 *
 * `provision()` is a request from a surface, and `ensureProvisioned()` is the
 * install/boot path (voice/wake/install-provision.ts) — the model ships with the
 * installation, so a fresh daemon has it without anyone asking. Both go through
 * ONE single-flight: a boot attempt and a user typing the setup command at the
 * same moment join one download rather than racing for the same files.
 *
 * Nothing else here downloads. `status()` and `modelChunk()` only read, so a
 * surface enabling wake detection never triggers a fetch — it gets an honest
 * not-provisioned with the recovery act named.
 */
import { readFileSync, statSync } from 'node:fs';
import {
  provisionWakeWordModels,
  resolveManagedWakePaths,
  wakeProvisionStatus,
  type WakeProvisionResult,
  type WakeProvisionStatus,
} from '../voice/wake/provisioning.js';
import {
  provisionWakeWordModelsAtInstall,
  type WakeInstallProvisionOutcome,
} from '../voice/wake/install-provision.js';
import {
  resolveWakeWordModel,
  WAKE_WORD_FRONT_END,
} from '../voice/provisioning/wake-word-manifest.js';
import { bytesToBase64 } from '../voice/capture/frames.js';
import { singleFlight } from '../utils/single-flight.js';

/**
 * Which pinned artifact a chunk read is asking for.
 *
 * `tflite` is the same classifier in TensorFlow Lite form. It is served because
 * it is provisioned: a surface whose inference runtime cannot load onnx has the
 * same claim on the model as one that can, and it has no more ability to fetch
 * the release asset itself.
 */
export type WakeModelComponent = 'classifier' | 'tflite' | 'embedding' | 'notice';

/** Largest chunk a single read returns, before base64. */
export const WAKE_MODEL_CHUNK_MAX_BYTES = 512 * 1024;

export interface WakeModelChunkRequest {
  readonly component: WakeModelComponent;
  readonly offset?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface WakeModelChunkResult {
  readonly component: WakeModelComponent;
  /** Byte offset this chunk starts at. */
  readonly offset: number;
  /** Bytes in this chunk (before base64). */
  readonly bytes: number;
  /** Size of the whole artifact, so a client knows when it is done. */
  readonly totalBytes: number;
  /** The PINNED sha256 of the whole artifact, for the client to verify against. */
  readonly sha256: string;
  readonly dataBase64: string;
  /** True when this chunk ends the artifact. */
  readonly complete: boolean;
}

export interface WakeSetupServiceDeps {
  /** The managed voice root; wake artifacts live in its `wake` subdirectory. */
  readonly managedVoiceRoot: string;
  /** Provisioner seam, so a test never downloads. */
  readonly provision?: ((options: { managedRoot: string }) => Promise<WakeProvisionResult>) | undefined;
  /** Status-read seam. */
  readonly readStatus?: ((options: { managedRoot: string }) => WakeProvisionStatus) | undefined;
  /** File-read seam, so a test serves bytes without writing 2.4 MB to disk. */
  readonly readArtifact?: ((path: string, offset: number, length: number) => Uint8Array) | undefined;
  /** Artifact size seam, paired with readArtifact. */
  readonly artifactSize?: ((path: string) => number) | undefined;
}

export interface WakeSetupService {
  status(): WakeProvisionStatus;
  provision(): Promise<WakeProvisionResult>;
  /**
   * The install/boot path: provision what is missing, never throw, and report one
   * plain line. Joins the same single-flight as {@link provision}, so a boot
   * attempt and a user-triggered setup are one download.
   */
  ensureProvisioned(options?: { readonly recoveryHint?: string | undefined }): Promise<WakeInstallProvisionOutcome>;
  modelChunk(request: WakeModelChunkRequest): WakeModelChunkResult;
}

/** The pinned path and checksum for one component. */
function resolveComponent(
  managedRoot: string,
  component: WakeModelComponent,
): { readonly path: string; readonly sha256: string } {
  const paths = resolveManagedWakePaths(managedRoot);
  const model = resolveWakeWordModel();
  if (component === 'embedding') {
    return { path: paths.embeddingPath, sha256: WAKE_WORD_FRONT_END.embedding.download.sha256 };
  }
  if (model === null) {
    throw new Error('[wake] no wake-word model is pinned, so no artifact can be served');
  }
  if (component === 'notice') return { path: paths.noticePath, sha256: model.notice.sha256 };
  if (component === 'tflite') return { path: paths.mobileClassifierPath, sha256: model.tflite.sha256 };
  return { path: paths.classifierPath, sha256: model.onnx.sha256 };
}

function readSlice(path: string, offset: number, length: number): Uint8Array {
  // readFileSync then slice: these artifacts are single-digit MB and the read is
  // one-shot per chunk, so a descriptor dance buys nothing over the page cache.
  const whole = readFileSync(path);
  return new Uint8Array(whole.buffer, whole.byteOffset + offset, Math.min(length, whole.length - offset));
}

export function createWakeSetupService(deps: WakeSetupServiceDeps): WakeSetupService {
  const provisionImpl = deps.provision
    ?? ((options: { managedRoot: string }) => provisionWakeWordModels(options));
  const readStatus = deps.readStatus ?? wakeProvisionStatus;
  const readArtifact = deps.readArtifact ?? readSlice;
  const artifactSize = deps.artifactSize ?? ((path: string) => statSync(path).size);

  const runProvision = singleFlight(async (): Promise<WakeProvisionResult> =>
    provisionImpl({ managedRoot: deps.managedVoiceRoot }));

  return {
    status: () => readStatus({ managedRoot: deps.managedVoiceRoot }),
    provision: () => runProvision(),
    ensureProvisioned: (options) => provisionWakeWordModelsAtInstall({
      managedRoot: deps.managedVoiceRoot,
      ...(options?.recoveryHint !== undefined ? { recoveryHint: options.recoveryHint } : {}),
      readStatus,
      // Routed through the single flight rather than calling the provisioner
      // directly, which is the whole reason this lives on the service.
      provision: () => runProvision(),
    }),
    modelChunk: (request) => {
      const { path, sha256 } = resolveComponent(deps.managedVoiceRoot, request.component);
      const offset = Math.max(0, Math.trunc(request.offset ?? 0));
      const cap = Math.min(
        WAKE_MODEL_CHUNK_MAX_BYTES,
        Math.max(1, Math.trunc(request.maxBytes ?? WAKE_MODEL_CHUNK_MAX_BYTES)),
      );
      const totalBytes = artifactSize(path);
      if (offset > totalBytes) {
        throw new Error(`[wake] offset ${offset} is past the end of ${request.component} (${totalBytes} bytes)`);
      }
      const length = Math.min(cap, totalBytes - offset);
      const slice = length > 0 ? readArtifact(path, offset, length) : new Uint8Array(0);
      return {
        component: request.component,
        offset,
        bytes: slice.length,
        totalBytes,
        sha256,
        dataBase64: bytesToBase64(slice),
        complete: offset + slice.length >= totalBytes,
      };
    },
  };
}
