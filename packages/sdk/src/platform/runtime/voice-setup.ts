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
}

export function createVoiceSetupService(deps: VoiceSetupServiceDeps): VoiceSetupService {
  const provision = deps.provision ?? provisionLocalVoiceRuntime;
  const readStatus = deps.readStatus ?? localVoiceRuntimeStatus;
  const progress = createVoiceInstallProgressTracker();

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
  };
}
