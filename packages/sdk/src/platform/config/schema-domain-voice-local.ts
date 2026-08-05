/**
 * schema-domain-voice-local.ts — the free local voice engines (`voice.local.*`).
 *
 * Every key ships EMPTY, and a machine with no engines reports an honest
 * 'unconfigured' status rather than an error. What fills them in is the managed
 * setup: it downloads and checksum-verifies the engines and models, points
 * these keys at them, and proves the result by speaking a phrase and
 * transcribing it back. That is one act by the user, and the platform performs
 * it — nothing here is a checklist for a person to work through.
 *
 * These descriptions used to say "the user downloads this explicitly — nothing
 * auto-downloads", written when setting local voice up by hand was the only
 * path. It is not: the managed installer IS the downloader, and copy telling a
 * user to go and fetch a model themselves describes a product that no longer
 * exists. A hand-built install still wins where it is deliberate, and the
 * managed runtime supersedes a stale one rather than quietly leaving it in
 * place (see voice/provisioning/config-preconfigure.ts).
 *
 * The blessed defaults and their research citations live in
 * docs/voice-local.md: whisper.cpp / faster-whisper for STT, Piper / Kokoro
 * for TTS.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';
import type { VoiceWakeConfig } from './schema-domain-voice-wake.js';

/** Local voice engine configuration (`voice.local.*`). */
export interface VoiceLocalConfig {
  local: {
    sttEngine: string;
    sttBinary: string;
    sttModelPath: string;
    ttsEngine: string;
    ttsBinary: string;
    ttsModelPath: string;
  };
}
/**
 * This file owns the `voice` key. Two domains live under it — the local
 * STT/TTS engine paths declared above, and the wake-word rows in
 * schema-domain-voice-wake.ts — and TypeScript's interface merging requires a
 * single declaration site, so the widened type is assembled here.
 */
declare module './schema-types.js' {
  interface GoodVibesConfig {
    voice: VoiceLocalConfig & VoiceWakeConfig;
  }
}

export const voiceLocalConfigDefaults: { voice: VoiceLocalConfig } = {
  voice: {
    local: {
      sttEngine: '',
      sttBinary: '',
      sttModelPath: '',
      ttsEngine: '',
      ttsBinary: '',
      ttsModelPath: '',
    },
  },
};

export const voiceLocalConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'voice.local.sttEngine',
    type: 'enum',
    default: '',
    enumValues: ['', 'whisper-cpp', 'faster-whisper'],
    description: 'Local speech-to-text engine: whisper-cpp (blessed default — CPU-first, realtime-capable) or faster-whisper (NVIDIA-GPU alternative via a wrapper script). Empty means not configured, and the machine says so honestly rather than erroring. Managed setup installs whisper-cpp and fills this in.',
  },
  {
    key: 'voice.local.sttBinary',
    type: 'string',
    default: '',
    description: 'Absolute path to the local STT engine binary (e.g. whisper.cpp\'s whisper-cli). Managed setup installs the engine and sets this.',
  },
  {
    key: 'voice.local.sttModelPath',
    type: 'string',
    default: '',
    description: 'Absolute path to the local STT model file (e.g. ggml-tiny.en.bin). Managed setup downloads the model, checksum-verifies it and sets this path; a path you set yourself is kept unless it names an install the managed runtime replaces, which is reported when it happens.',
  },
  {
    key: 'voice.local.ttsEngine',
    type: 'enum',
    default: '',
    enumValues: ['', 'piper', 'kokoro'],
    description: 'Local text-to-speech engine: piper (blessed default — sub-50ms first-audio class, MIT) or kokoro (quality alternative, Apache 2.0, via a wrapper script). Empty means not configured. Managed setup installs piper and fills this in.',
  },
  {
    key: 'voice.local.ttsBinary',
    type: 'string',
    default: '',
    description: 'Absolute path to the local TTS engine binary (e.g. piper). Managed setup installs the engine and sets this.',
  },
  {
    key: 'voice.local.ttsModelPath',
    type: 'string',
    default: '',
    description: 'Absolute path to the local TTS voice model (e.g. en_US-lessac-low.onnx with its .json beside it). Managed setup downloads the voice, checksum-verifies it and sets this path; a path you set yourself is kept unless it names an install the managed runtime replaces, which is reported when it happens.',
  },
];
