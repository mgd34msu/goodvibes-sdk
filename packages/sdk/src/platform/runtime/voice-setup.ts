/**
 * voice-setup.ts — the daemon's managed local-voice setup service, composed
 * once per runtime (extracted from runtime/services.ts).
 *
 * `install()` is SINGLE-FLIGHT: concurrent installs are never meaningful — a
 * second (and every further) concurrent caller joins the in-progress install's
 * promise instead of starting parallel multi-hundred-MB downloads.
 *
 * `status()` carries LIVE INSTALL PROGRESS: the install verb is plain
 * request/response, so during a ~209MB provision a surface would otherwise only
 * render busy→receipt. While an install runs, the provisioner's onProgress
 * stream is folded into a poll-able snapshot and status() returns it as
 * `installInProgress` (absent otherwise) — surfaces poll status during install;
 * no streaming infrastructure involved.
 */
import {
  createVoiceInstallProgressTracker,
  localVoiceRuntimeStatus,
  preconfigureLocalVoiceKeys,
  provisionLocalVoiceRuntime,
  readVoiceInstallStamp,
  writeVoiceInstallStamp,
  type VoiceComponentOutcome,
  type VoiceProvisionOptions,
  type VoiceProvisionResult,
  type VoiceRuntimeStatus,
} from '../voice/provisioning/index.js';
import { singleFlight } from '../utils/single-flight.js';
import {
  createWakeSetupService,
  type WakeModelChunkRequest,
  type WakeModelChunkResult,
  type WakeSetupService,
} from './wake-setup.js';
import type { WakeInstallProvisionOutcome } from '../voice/wake/install-provision.js';

/** What voice.local.install resolves with (the wire receipt). */
export interface VoiceInstallReceipt {
  readonly provisioned: boolean;
  readonly platform: VoiceProvisionResult['platform'];
  readonly tts: VoiceProvisionResult['tts'];
  readonly stt: VoiceProvisionResult['stt'];
  readonly components: readonly VoiceComponentOutcome[];
  readonly configured: {
    readonly set: readonly { key: string; value: string }[];
    readonly skipped: readonly { key: string; reason: string }[];
  };
}

export interface VoiceSetupServiceDeps {
  readonly managedVoiceRoot: string;
  readonly getConfig: (key: string) => string;
  readonly setConfig: (key: string, value: string) => void;
  /** Clear the local engine's tripped circuit breaker after a successful (re-)install. */
  readonly resetLocalEngineFailureState: () => void;
  /** Critical-tier admission gate (MemoryGovernor). */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
  /** Provisioner seam (tests inject fetch/extractor via a wrapper). */
  readonly provision?: ((options: VoiceProvisionOptions) => Promise<VoiceProvisionResult>) | undefined;
  /** Status-read seam (tests). */
  readonly readStatus?: ((options: { managedRoot: string }) => VoiceRuntimeStatus) | undefined;
}

export interface VoiceSetupService {
  status(): VoiceRuntimeStatus;
  install(): Promise<VoiceInstallReceipt>;
  /** Wake-word artifact state, verified by content. See runtime/wake-setup.ts. */
  wakeStatus(): ReturnType<WakeSetupService['status']>;
  wakeProvision(): ReturnType<WakeSetupService['provision']>;
  /**
   * Install/boot provisioning: fetch whatever is missing, never throw, report one
   * line. Not admission-gated, unlike {@link wakeProvision} — a host that refused
   * this under memory pressure would ship an install with no model and no retry
   * until someone noticed, and the 6 MB it buffers is not what puts a daemon under
   * pressure. It joins the same single flight, so it cannot double the work either.
   */
  wakeEnsureProvisioned(options?: { readonly recoveryHint?: string | undefined }): Promise<WakeInstallProvisionOutcome>;
  wakeModelChunk(request: WakeModelChunkRequest): WakeModelChunkResult;
}

export function createVoiceSetupService(deps: VoiceSetupServiceDeps): VoiceSetupService {
  const provision = deps.provision ?? provisionLocalVoiceRuntime;
  const readStatus = deps.readStatus ?? localVoiceRuntimeStatus;
  const progress = createVoiceInstallProgressTracker();
  // Wake artifacts live under the same managed voice root, in its `wake`
  // subdirectory, so they share this service's ownership of that tree.
  const wake = createWakeSetupService({ managedVoiceRoot: deps.managedVoiceRoot });

  const runInstall = singleFlight(async (): Promise<VoiceInstallReceipt> => {
    progress.begin();
    try {
      const result = await provision({
        managedRoot: deps.managedVoiceRoot,
        onProgress: (event) => progress.onProgress(event),
      });
      let configured: VoiceInstallReceipt['configured'] = { set: [], skipped: [] };
      if (result.tts.state === 'provisioned' && result.tts.binaryPath && result.tts.modelPath) {
        // Ownership-aware preconfigure: values THIS installer previously wrote
        // (recorded in the install stamp) update to the new managed paths;
        // genuinely user-set values still win; a user-cleared installer value
        // is a deliberate disable and stays cleared.
        const stamp = readVoiceInstallStamp(deps.managedVoiceRoot);
        const receipt = preconfigureLocalVoiceKeys({
          getConfig: deps.getConfig,
          setConfig: deps.setConfig,
          ttsEngine: result.tts.engine,
          ttsBinary: result.tts.binaryPath,
          ttsModelPath: result.tts.modelPath,
          ...(result.stt.state === 'provisioned' && result.stt.binaryPath && result.stt.modelPath
            ? { sttEngine: result.stt.engine, sttBinary: result.stt.binaryPath, sttModelPath: result.stt.modelPath }
            : {}),
          priorInstallWrites: stamp?.configWrites,
        });
        configured = { set: [...receipt.set], skipped: [...receipt.skipped] };
        if (stamp) {
          writeVoiceInstallStamp(deps.managedVoiceRoot, { ...stamp, configWrites: { ...stamp.configWrites, ...receipt.installWrites } });
        }
        // A successful (re-)install is the recovery act: clear any tripped
        // local-engine circuit breaker so the next call retries the fresh engine.
        deps.resetLocalEngineFailureState();
      }
      return {
        provisioned: result.tts.state === 'provisioned',
        platform: result.platform,
        tts: result.tts,
        stt: result.stt,
        components: result.components,
        configured,
      };
    } finally {
      progress.end();
    }
  });

  return {
    status(): VoiceRuntimeStatus {
      const status = readStatus({ managedRoot: deps.managedVoiceRoot });
      const installInProgress = progress.snapshot();
      return installInProgress ? { ...status, installInProgress } : status;
    },
    async install(): Promise<VoiceInstallReceipt> {
      // Critical-tier admission: a provision run allocates archive + model
      // buffers — refuse honestly instead of piling onto memory pressure.
      const admission = deps.admitExpensiveWork('voice runtime install');
      if (!admission.allowed) {
        throw new Error(admission.reason ?? 'voice runtime install refused: daemon is under critical memory pressure.');
      }
      return runInstall();
    },
    wakeStatus: () => wake.status(),
    async wakeProvision() {
      // Same admission gate as the local runtime install: this one is 3.7 MB
      // rather than 209 MB, but it still buffers artifacts to verify them, and
      // refusing honestly under memory pressure beats adding to it.
      const admission = deps.admitExpensiveWork('wake-word model provision');
      if (!admission.allowed) {
        throw new Error(admission.reason ?? 'wake-word provision refused: daemon is under critical memory pressure.');
      }
      return wake.provision();
    },
    wakeEnsureProvisioned: (options) => wake.ensureProvisioned(options),
    wakeModelChunk: (request) => wake.modelChunk(request),
  };
}
