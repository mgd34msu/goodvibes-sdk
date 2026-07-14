/**
 * providers/local.ts — the local voice provider: free, offline STT + TTS
 * behind the exact same seams as the cloud providers.
 *
 * Blessed engines (research pass 2026-07-14, citations in docs/voice-local.md):
 * - STT: whisper.cpp (CPU-first, real-time capable, no Python dependency) with
 *   faster-whisper as the NVIDIA-GPU alternative behind a wrapper script.
 * - TTS: Piper (sub-50 ms first-audio class, MIT) with Kokoro-82M as the
 *   quality alternative (Apache 2.0) behind a wrapper script.
 *
 * NOTHING auto-downloads: the provider is configurable-not-configured by
 *  default. A machine without engines reports an honest 'unconfigured' status
 * (never an error); setup is one explicit user action (install the engine +
 * model, set the voice.local.* keys — the doc ships the worked path).
 *
 * Engine invocation contracts (all injectable for the scripted test fixture):
 * - whisper-cpp: `<binary> -m <model> -f <wav> --no-timestamps --no-prints`,
 *   transcript on stdout.
 * - faster-whisper: `<binary> <model> <wav>`, transcript on stdout (a
 *   two-line wrapper script, shown in the doc).
 * - piper: `<binary> --model <onnx> --output_file <wav>`, text on stdin.
 * - kokoro: `<binary> --model <path> --output_file <wav>`, text on stdin (a
 *   wrapper script, shown in the doc).
 *
 * BILLING: 'none' — a local engine has no billing dimension, so it emits no
 * cost-attribution usage at all (honest absence, never a fake $0.00).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  VoiceProvider,
  VoiceProviderStatus,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceSynthesisStreamResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../types.js';

export type LocalSttEngine = 'whisper-cpp' | 'faster-whisper';
export type LocalTtsEngine = 'piper' | 'kokoro';

/** The voice.local.* config surface the provider reads live. */
export interface LocalVoiceConfigReader {
  (key: string): unknown;
}

/** Injectable process seam: run a binary, return stdout (text is fed via stdin when given). */
export type LocalEngineRunner = (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly stdinText?: string | undefined;
  readonly timeoutMs: number;
}) => Promise<{ stdout: string }>;

const defaultRunner: LocalEngineRunner = (input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      input.binary,
      [...input.args],
      { timeout: input.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout });
      },
    );
    if (input.stdinText !== undefined && child.stdin) {
      child.stdin.write(input.stdinText);
      child.stdin.end();
    }
  });

interface LocalEngineConfig {
  readonly engine: string;
  readonly binary: string;
  readonly modelPath: string;
}

function readEngine(read: LocalVoiceConfigReader, prefix: 'stt' | 'tts'): LocalEngineConfig | null {
  const engine = String(read(`voice.local.${prefix}Engine`) ?? '').trim();
  const binary = String(read(`voice.local.${prefix}Binary`) ?? '').trim();
  const modelPath = String(read(`voice.local.${prefix}ModelPath`) ?? '').trim();
  if (!engine || !binary || !modelPath) return null;
  return { engine, binary, modelPath };
}

const RUN_TIMEOUT_MS = 120_000;

export interface LocalVoiceProviderOptions {
  readonly readConfig: LocalVoiceConfigReader;
  /** Injectable engine runner (scripted fixtures in tests). */
  readonly runner?: LocalEngineRunner | undefined;
  /** Injectable existence check (tests). */
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

/** Create the local (free, offline) voice provider. */
export function createLocalVoiceProvider(options: LocalVoiceProviderOptions): VoiceProvider {
  const read = options.readConfig;
  const runner = options.runner ?? defaultRunner;
  const exists = options.fileExists ?? existsSync;

  const capabilities = (): Array<'tts' | 'tts-stream' | 'stt'> => {
    const caps: Array<'tts' | 'tts-stream' | 'stt'> = [];
    if (readEngine(read, 'tts')) caps.push('tts', 'tts-stream');
    if (readEngine(read, 'stt')) caps.push('stt');
    return caps;
  };

  const synthesizeWav = async (request: VoiceSynthesisRequest): Promise<{ wav: Buffer; engine: LocalEngineConfig }> => {
    const tts = readEngine(read, 'tts');
    if (!tts) {
      throw new Error('local TTS is not configured — set voice.local.ttsEngine/ttsBinary/ttsModelPath (see docs/voice-local.md; nothing auto-downloads)');
    }
    const scratch = mkdtempSync(join(tmpdir(), 'gv-local-tts-'));
    const outPath = join(scratch, 'out.wav');
    try {
      // piper and the kokoro wrapper share the same contract: text on stdin,
      // wav to --output_file.
      await runner({
        binary: tts.binary,
        args: ['--model', tts.modelPath, '--output_file', outPath],
        stdinText: request.text,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      return { wav: readFileSync(outPath), engine: tts };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  return {
    id: 'local',
    label: 'Local engines (free, offline)',
    capabilities: ['tts', 'tts-stream', 'stt'],
    billing: 'none',
    status(): VoiceProviderStatus {
      const tts = readEngine(read, 'tts');
      const stt = readEngine(read, 'stt');
      const caps = capabilities();
      const missing: string[] = [];
      for (const [label, engine] of [['TTS', tts], ['STT', stt]] as const) {
        if (engine && (!exists(engine.binary) || !exists(engine.modelPath))) {
          missing.push(`${label} (${engine.engine}): binary or model missing on disk`);
        }
      }
      const configured = caps.length > 0;
      return {
        id: 'local',
        label: 'Local engines (free, offline)',
        state: !configured ? 'unconfigured' : missing.length > 0 ? 'degraded' : 'healthy',
        capabilities: caps,
        configured,
        detail: !configured
          ? 'Not configured — local voice needs an installed engine and model (one explicit setup action; nothing auto-downloads). See docs/voice-local.md.'
          : missing.length > 0
            ? missing.join('; ')
            : `STT: ${stt?.engine ?? 'off'}; TTS: ${tts?.engine ?? 'off'} — offline, no billing dimension.`,
        metadata: { billing: 'none', sttEngine: stt?.engine ?? null, ttsEngine: tts?.engine ?? null },
      };
    },
    async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
      const { wav, engine } = await synthesizeWav(request);
      return {
        providerId: 'local',
        audio: {
          mimeType: 'audio/wav',
          format: 'wav',
          dataBase64: wav.toString('base64'),
          metadata: { engine: engine.engine, billing: 'none' },
        },
        metadata: { engine: engine.engine, modelPath: engine.modelPath, billing: 'none' },
      };
    },
    async synthesizeStream(request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      // Local engines emit whole wav files; the stream contract is satisfied
      // with a single final chunk (the spoken-turn controller already handles
      // single-chunk streams — same shape a short cloud response produces).
      const { wav, engine } = await synthesizeWav(request);
      const chunk = { data: new Uint8Array(wav), sequence: 0, mimeType: 'audio/wav', format: 'wav' as const, final: true };
      return {
        providerId: 'local',
        mimeType: 'audio/wav',
        format: 'wav',
        chunks: (async function* () {
          yield chunk;
        })(),
        metadata: { engine: engine.engine, billing: 'none' },
      };
    },
    async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
      const stt = readEngine(read, 'stt');
      if (!stt) {
        throw new Error('local STT is not configured — set voice.local.sttEngine/sttBinary/sttModelPath (see docs/voice-local.md; nothing auto-downloads)');
      }
      if (!request.audio.dataBase64) {
        throw new Error('local STT needs inline audio (dataBase64)');
      }
      const scratch = mkdtempSync(join(tmpdir(), 'gv-local-stt-'));
      const wavPath = join(scratch, 'in.wav');
      try {
        writeFileSync(wavPath, Buffer.from(request.audio.dataBase64, 'base64'));
        const args = stt.engine === 'whisper-cpp'
          ? ['-m', stt.modelPath, '-f', wavPath, '--no-timestamps', '--no-prints']
          : [stt.modelPath, wavPath];
        const { stdout } = await runner({ binary: stt.binary, args, timeoutMs: RUN_TIMEOUT_MS });
        return {
          providerId: 'local',
          text: stdout.trim(),
          metadata: { engine: stt.engine, modelPath: stt.modelPath, billing: 'none' },
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
