/**
 * schema-domain-voice-local.ts — the free local voice engines (`voice.local.*`).
 *
 * Configurable-not-configured by default: every key ships empty, NOTHING
 * auto-downloads, and a machine without engines reports an honest
 * 'unconfigured' provider status (never an error). Setup is one explicit user
 * action per engine — install it, download a model, set these keys (the
 * worked path lives in docs/voice-local.md, with the research citations that
 * blessed the defaults: whisper.cpp / faster-whisper for STT, Piper / Kokoro
 * for TTS).
 */
import type { ConfigSettingDefinition } from './schema-shared.js';

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
declare module './schema-types.js' {
  interface GoodVibesConfig {
    voice: VoiceLocalConfig;
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
    description: 'Local speech-to-text engine: whisper-cpp (blessed default — CPU-first, realtime-capable) or faster-whisper (NVIDIA-GPU alternative via a wrapper script). Empty = not configured (honest unconfigured status; nothing auto-downloads).',
  },
  {
    key: 'voice.local.sttBinary',
    type: 'string',
    default: '',
    description: 'Absolute path to the local STT engine binary (e.g. whisper.cpp\'s whisper-cli).',
  },
  {
    key: 'voice.local.sttModelPath',
    type: 'string',
    default: '',
    description: 'Absolute path to the local STT model file (e.g. ggml-tiny.en.bin). The user downloads this explicitly — nothing auto-downloads.',
  },
  {
    key: 'voice.local.ttsEngine',
    type: 'enum',
    default: '',
    enumValues: ['', 'piper', 'kokoro'],
    description: 'Local text-to-speech engine: piper (blessed default — sub-50ms first-audio class, MIT) or kokoro (quality alternative, Apache 2.0, via a wrapper script). Empty = not configured.',
  },
  {
    key: 'voice.local.ttsBinary',
    type: 'string',
    default: '',
    description: 'Absolute path to the local TTS engine binary (e.g. piper).',
  },
  {
    key: 'voice.local.ttsModelPath',
    type: 'string',
    default: '',
    description: 'Absolute path to the local TTS voice model (e.g. en_US-lessac-low.onnx with its .json beside it). The user downloads this explicitly — nothing auto-downloads.',
  },
];
