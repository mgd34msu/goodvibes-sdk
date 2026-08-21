/**
 * round-trip-proof.ts, provisioning ends by PROVING the runtime works.
 *
 * "Provisioned" used to mean "the bytes are on disk and the checksums matched".
 * That is not the claim anyone cares about. On the owner's machine every byte
 * was present and verified, the install reported success, and speech-to-text
 * did not work, because the config still pointed at a different install. The
 * install was right about everything it checked and wrong about the only thing
 * that mattered.
 *
 * So the last act of provisioning is a real round trip: SYNTHESIZE a known
 * phrase with the managed TTS, TRANSCRIBE the resulting audio with the managed
 * STT, and compare. What comes back is shown to the user verbatim, the proof
 * is the text, not a green tick. If it fails, provisioning reports NOT
 * provisioned, with the stage that failed and the exception, because a false
 * "ready" costs a whole session and an honest failure costs a retry.
 *
 * The engine invocation contracts are the same ones providers/local.ts uses; a
 * proof that ran the binaries differently would prove something the product
 * does not do.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

/**
 * The phrase the proof speaks. Deliberately plain, common words: the point is
 * to prove the pipeline runs end to end, not to benchmark a small model on
 * vocabulary it was never going to get right.
 */
export const VOICE_PROOF_PHRASE = 'the quick brown fox jumps over the lazy dog';

/** How much of the phrase must survive the round trip to count as proof. */
export const VOICE_PROOF_MIN_WORD_OVERLAP = 0.5;

/** Injectable process seam, matching providers/local.ts. */
export type ProofEngineRunner = (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly stdinText?: string | undefined;
  readonly timeoutMs: number;
}) => Promise<{ stdout: string }>;

const defaultRunner: ProofEngineRunner = (input) =>
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

export interface VoiceRoundTripProofOptions {
  readonly ttsEngine: string;
  readonly ttsBinary: string;
  readonly ttsModelPath: string;
  readonly sttEngine: string;
  readonly sttBinary: string;
  readonly sttModelPath: string;
  readonly phrase?: string | undefined;
  readonly runner?: ProofEngineRunner | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injectable so a test needs no temp directory. */
  readonly scratchDir?: string | undefined;
}

/** What the proof did, in enough detail to report it honestly either way. */
export interface VoiceRoundTripProof {
  readonly proved: boolean;
  /** Which stage ran last: `synthesize`, `transcribe`, or `compare`. */
  readonly stage: 'synthesize' | 'transcribe' | 'compare';
  readonly phrase: string;
  /** What the managed STT actually returned. Shown verbatim. */
  readonly transcript?: string | undefined;
  /** Fraction of the phrase's words that came back. */
  readonly wordOverlap?: number | undefined;
  /** The exception text when a stage failed. */
  readonly error?: string | undefined;
  /** One sentence a surface can print as-is. */
  readonly summary: string;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Fraction of `expected`'s distinct words that appear in `actual`. */
export function transcriptWordOverlap(expected: string, actual: string): number {
  const wanted = new Set(normalizeWords(expected));
  if (wanted.size === 0) return 0;
  const got = new Set(normalizeWords(actual));
  let hits = 0;
  for (const word of wanted) if (got.has(word)) hits += 1;
  return hits / wanted.size;
}

/**
 * Speak a phrase with the managed TTS and read it back with the managed STT.
 *
 * Never throws: a proof that blew up is a failed proof, reported as one. The
 * caller turns this into "provisioned" or "not provisioned".
 */
export async function proveVoiceRoundTrip(options: VoiceRoundTripProofOptions): Promise<VoiceRoundTripProof> {
  const phrase = options.phrase ?? VOICE_PROOF_PHRASE;
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const scratch = options.scratchDir ?? mkdtempSync(join(tmpdir(), 'gv-voice-proof-'));
  const wavPath = join(scratch, 'proof.wav');

  try {
    try {
      await runner({
        binary: options.ttsBinary,
        args: ['--model', options.ttsModelPath, '--output_file', wavPath],
        stdinText: phrase,
        timeoutMs,
      });
      // The engine may exit 0 and still have written nothing; reading it is the
      // check that the audio exists at all.
      const wav = readFileSync(wavPath);
      if (wav.byteLength === 0) throw new Error('the synthesized audio file is empty');
      writeFileSync(wavPath, wav);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        proved: false,
        stage: 'synthesize',
        phrase,
        error: detail,
        summary: `The managed text-to-speech engine (${options.ttsEngine}) could not speak the test phrase: ${detail}`,
      };
    }

    let transcript: string;
    try {
      const args = options.sttEngine === 'whisper-cpp'
        ? ['-m', options.sttModelPath, '-f', wavPath, '--no-timestamps', '--no-prints']
        : [options.sttModelPath, wavPath];
      const { stdout } = await runner({ binary: options.sttBinary, args, timeoutMs });
      transcript = stdout.trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        proved: false,
        stage: 'transcribe',
        phrase,
        error: detail,
        summary: `The managed speech-to-text engine (${options.sttEngine}) could not transcribe the spoken test phrase: ${detail}`,
      };
    }

    const wordOverlap = transcriptWordOverlap(phrase, transcript);
    const proved = wordOverlap >= VOICE_PROOF_MIN_WORD_OVERLAP;
    return {
      proved,
      stage: 'compare',
      phrase,
      transcript,
      wordOverlap,
      summary: proved
        ? `Spoke "${phrase}" with ${options.ttsEngine} and heard it back through ${options.sttEngine} as "${transcript}".`
        : `Spoke "${phrase}" with ${options.ttsEngine}, but ${options.sttEngine} heard "${transcript}", too little of the phrase came back for this to count as working.`,
    };
  } finally {
    if (options.scratchDir === undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
