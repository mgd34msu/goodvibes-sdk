/**
 * voice/provisioning — SDK-owned managed provisioning of the local voice runtime
 * (piper TTS + a default voice), atomic + checksum-verified, resumable, with
 * honest states. Nothing downloads without the user asking.
 */
export {
  downloadVerifiedFile,
  fileMatches,
  fileMatchesCached,
  type VerifiedDownloadSpec,
  type VerifiedDownloadOptions,
  type VerifiedDownloadResult,
} from './download-verified.js';

export {
  currentVoicePlatform,
  piperProvisionBytes,
  PIPER_ENGINES,
  DEFAULT_PIPER_VOICE,
  WHISPER_ENGINES,
  DEFAULT_WHISPER_MODEL,
  WHISPER_UNSUPPORTED_REASON,
  type VoicePlatform,
  type PiperEngineManifest,
  type PiperVoiceManifest,
  type WhisperEngineManifest,
  type WhisperModelManifest,
} from './manifest.js';

export {
  provisionLocalVoiceRuntime,
  localVoiceRuntimeStatus,
  resolveManagedVoicePaths,
  resolveManagedEngine,
  readVoiceInstallStamp,
  writeVoiceInstallStamp,
  type VoiceProvisionOptions,
  type VoiceProvisionResult,
  type VoiceProvisionProgress,
  type VoiceRuntimeStatus,
  type VoiceRuntimeState,
  type ManagedVoicePaths,
  type ArchiveExtractor,
  type TtsProvisionState,
  type SttProvisionState,
  type VoiceComponentOutcome,
  type VoiceInstallStamp,
} from './provisioner.js';

export {
  preconfigureLocalVoiceKeys,
  type VoicePreconfigReceipt,
  type VoicePreconfigDeps,
  type VoiceKeyPreconfig,
  type VoiceKeySkip,
} from './config-preconfigure.js';
