/**
 * noise-suppression.ts — `voice.wake.noiseSuppression`, as a stage that runs.
 *
 * The row shipped with two values and one of them refused: `speex` named a
 * filter nothing applied, so selecting it stopped the detector rather than
 * pretending. This is the filter. It is SpeexDSP's own preprocessor, compiled to
 * WebAssembly and embedded in the source (see ./vendor/speexdsp-wasm.ts and
 * native/speexdsp-wasm/), which is the same posture the wake engine takes for the
 * same reason: one artifact that a daemon child process under Bun and a browser
 * tab both load, because a native binding cannot run in the tab and a setting
 * that means different things on different surfaces is the problem, not the fix.
 *
 * WHERE THE STAGE SITS
 *
 * {@link createNoiseSuppressingOpener} wraps a host's capture opener, so the
 * filter runs between the device and EVERY consumer: the wake engine scores
 * filtered frames, the utterance recorded after a wake is filtered, the pre-roll
 * carried from before the wake is filtered, and push-to-talk voice input is
 * filtered. There is no path that sees one and not the other, which is what makes
 * one row honest for the whole voice stack.
 *
 * `none` is not a stage that does nothing — it is NO stage. The wrapper hands the
 * inner opener's frames straight through, the same objects, so the byte path with
 * suppression off is exactly the path that shipped.
 *
 * WHAT IT DOES NOT DO
 *
 * The module contains the denoiser and nothing else: no echo canceller, no
 * automatic gain control (which would move the loudness the wake classifier was
 * trained against), no voice-activity gate — `voice.wake.vadThreshold` still has
 * no model behind it and still refuses. Those stages are disabled explicitly in
 * the WebAssembly entry points rather than left at upstream defaults.
 */
import { base64ToBytes } from './frames.js';
import {
  SPEEXDSP_WASM_BASE64,
  SPEEXDSP_WASM_BUILD,
  SPEEXDSP_WASM_BYTES,
  SPEEXDSP_WASM_SHA256,
} from './vendor/speexdsp-wasm.js';
import {
  AudioCaptureError,
  CAPTURE_SAMPLE_RATE,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureRequest,
  type AudioCaptureStream,
  type AudioCaptureWarn,
} from './types.js';

/**
 * Provenance and license of the embedded filter, for a surface that describes
 * what it is running and for anything that redistributes it.
 *
 * SpeexDSP is BSD 3-clause: its copyright notice, condition list and disclaimer
 * must be reproduced with binary redistribution, and the base64 module inside
 * this package IS binary redistribution. {@link noticePath} is that reproduction,
 * carried in the repository beside the build inputs exactly as the wake model's
 * NOTICE is carried beside its artifacts.
 */
export const SPEEXDSP_PREPROCESS = {
  component: 'SpeexDSP',
  version: SPEEXDSP_WASM_BUILD.upstreamVersion,
  license: 'BSD-3-Clause',
  sourceUrl: SPEEXDSP_WASM_BUILD.upstreamUrl,
  upstreamSha256: SPEEXDSP_WASM_BUILD.upstreamSha256,
  noticePath: 'native/speexdsp-wasm/NOTICE.txt',
  licensePath: 'native/speexdsp-wasm/SpeexDSP-1.2.1-COPYING.txt',
  /** Bytes and checksum of the module actually embedded. */
  moduleBytes: SPEEXDSP_WASM_BYTES,
  moduleSha256: SPEEXDSP_WASM_SHA256,
  /** Compiler, linker and sysroot the module was produced with. */
  toolchain: SPEEXDSP_WASM_BUILD,
  /**
   * What the denoiser is asked to do: attenuate the estimated noise floor by this
   * many dB. SpeexDSP's own default, read back from the running state rather than
   * assumed — {@link NoiseSuppressionStage.suppressionDb}.
   */
  defaultSuppressionDb: -15,
} as const;

/**
 * Samples per call into the suppressor: 20 ms at 16 kHz.
 *
 * NOT the 1280-sample (80 ms) frame the wake engine takes. The suppressor
 * estimates a noise floor per block over a window twice the block length, so an
 * 80 ms block would track a room four times more slowly than the 10–20 ms
 * SpeexDSP is designed and tuned around. An 80 ms frame is therefore filtered as
 * four consecutive 20 ms blocks through ONE state, which is a continuous filter
 * over the stream, not four independent ones.
 */
export const SPEEX_BLOCK_SAMPLES = 320;

/** A running suppression filter over one capture stream. */
export interface NoiseSuppressionStage {
  /** What is filtering, for an indicator or a log: e.g. `speexdsp 1.2.1`. */
  readonly label: string;
  /** Samples handed to the filter at a time. */
  readonly blockSamples: number;
  /** The suppression floor in dB, read back from the running filter. */
  readonly suppressionDb: number;
  /**
   * Filter one frame, returning a NEW frame. The input is left untouched, because
   * a caller may hold on to what it handed over (the wake pre-roll buffer does).
   *
   * `frame.length` must be a whole number of {@link blockSamples}. A frame that
   * is not throws: filtering the whole blocks and passing the tail through is the
   * silent half-measure this row exists to prevent.
   */
  process(frame: Float32Array): Float32Array;
  /** Release the filter's memory. Idempotent; `process` after it throws. */
  close(): void;
}

/** Builds a stage. Injected so a test can drive the wiring without WebAssembly. */
export type NoiseSuppressionFactory = (request: {
  readonly frameSamples: number;
  readonly sampleRate: number;
}) => Promise<NoiseSuppressionStage>;

/** Whether this runtime can run the stage at all, and why not when it cannot. */
export interface NoiseSuppressionSupport {
  readonly supported: boolean;
  /** Written reason, for a settings row that must say why rather than just "no". */
  readonly reason: string;
}

/**
 * Can this runtime run the filter?
 *
 * The answer is a WebAssembly check and nothing else: the module is embedded, so
 * there is no library to find, no download to have completed and no host
 * configuration involved. A JavaScript runtime without WebAssembly (a bare
 * Hermes build, for instance) is the one place the answer is no, and it gets a
 * reason a settings row can show.
 */
export function noiseSuppressionSupport(): NoiseSuppressionSupport {
  const available = typeof WebAssembly === 'object'
    && typeof WebAssembly.instantiate === 'function'
    && typeof WebAssembly.compile === 'function';
  return available
    ? { supported: true, reason: 'speexdsp runs here: the filter is a WebAssembly module carried in the package' }
    : {
      supported: false,
      reason: 'this runtime has no WebAssembly implementation, and the speexdsp filter is a WebAssembly module',
    };
}

/** The exports the compiled module provides. Mirrors native/speexdsp-wasm/. */
interface SpeexModuleExports {
  readonly memory: WebAssembly.Memory;
  gv_speex_abi_version(): number;
  gv_speex_create(blockSamples: number, sampleRate: number): number;
  gv_speex_block(handle: number): number;
  gv_speex_block_samples(handle: number): number;
  gv_speex_noise_suppress_db(handle: number): number;
  gv_speex_run(handle: number): number;
  gv_speex_destroy(handle: number): void;
}

/** ABI the exports above are written against. Mismatch is a build mismatch. */
const SPEEX_ABI_VERSION = 1;

let compiled: Promise<WebAssembly.Module> | null = null;

/**
 * Compile the embedded module once per process and share it.
 *
 * Compiling is the expensive part and it is independent of any stream, while an
 * INSTANCE is per stream: each capture stream gets its own linear memory so two
 * of them cannot share a noise estimate.
 */
function compileModule(): Promise<WebAssembly.Module> {
  if (compiled !== null) return compiled;
  compiled = (async (): Promise<WebAssembly.Module> => {
    const bytes = base64ToBytes(SPEEXDSP_WASM_BASE64);
    if (bytes.length !== SPEEXDSP_WASM_BYTES) {
      throw new Error(
        `[capture] the embedded speexdsp module decoded to ${bytes.length} bytes, not the ${SPEEXDSP_WASM_BYTES} `
        + 'recorded for it — the artifact in vendor/speexdsp-wasm.ts has been altered',
      );
    }
    return WebAssembly.compile(bytes);
  })();
  // A failed compile must not be cached as a permanent verdict: a later attempt
  // (a restart, a second surface) should get a real error rather than a rejected
  // promise from minutes ago.
  compiled.catch(() => { compiled = null; });
  return compiled;
}

/** The largest block size that divides a frame, so no frame is left part-filtered. */
function blockSamplesFor(frameSamples: number): number {
  for (const candidate of [SPEEX_BLOCK_SAMPLES, 160, 80, 40, 20, 10, 2]) {
    if (frameSamples % candidate === 0) return candidate;
  }
  return frameSamples;
}

/**
 * Build a speexdsp suppression stage for frames of `frameSamples` samples.
 *
 * Rejects rather than degrading: no WebAssembly, an altered artifact, an ABI
 * mismatch or an out-of-memory instantiation all produce an error the caller
 * turns into a refusal, because the alternative is capturing unfiltered audio
 * while the setting says otherwise.
 */
export async function createSpeexNoiseSuppression(options: {
  readonly frameSamples: number;
  readonly sampleRate?: number | undefined;
}): Promise<NoiseSuppressionStage> {
  const support = noiseSuppressionSupport();
  if (!support.supported) throw new Error(`[capture] ${support.reason}`);
  const frameSamples = options.frameSamples;
  if (!Number.isInteger(frameSamples) || frameSamples <= 0 || frameSamples % 2 !== 0) {
    throw new Error(`[capture] noise suppression needs an even, positive frame size, got ${frameSamples}`);
  }
  const sampleRate = options.sampleRate ?? CAPTURE_SAMPLE_RATE;
  const module = await compileModule();
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as SpeexModuleExports;
  const abi = exports.gv_speex_abi_version();
  if (abi !== SPEEX_ABI_VERSION) {
    throw new Error(`[capture] the embedded speexdsp module reports ABI ${abi}, this code speaks ${SPEEX_ABI_VERSION}`);
  }
  const blockSamples = blockSamplesFor(frameSamples);
  const handle = exports.gv_speex_create(blockSamples, sampleRate);
  if (handle === 0) {
    throw new Error(`[capture] speexdsp refused a ${blockSamples}-sample block at ${sampleRate} Hz`);
  }
  const blockPointer = exports.gv_speex_block(handle);
  const suppressionDb = exports.gv_speex_noise_suppress_db(handle);
  let closed = false;
  let view: Int16Array | null = null;

  /** The int16 block inside the module's memory, re-viewed if that memory moved. */
  const blockView = (): Int16Array => {
    if (view === null || view.buffer !== exports.memory.buffer) {
      view = new Int16Array(exports.memory.buffer, blockPointer, blockSamples);
    }
    return view;
  };

  return {
    label: `speexdsp ${SPEEXDSP_PREPROCESS.version}`,
    blockSamples,
    suppressionDb,
    process(frame: Float32Array): Float32Array {
      if (closed) throw new Error('[capture] the noise-suppression stage is closed');
      if (frame.length === 0 || frame.length % blockSamples !== 0) {
        throw new Error(
          `[capture] noise suppression takes whole ${blockSamples}-sample blocks, got a frame of ${frame.length}`,
        );
      }
      const out = new Float32Array(frame.length);
      for (let offset = 0; offset < frame.length; offset += blockSamples) {
        const block = blockView();
        for (let i = 0; i < blockSamples; i += 1) {
          // Frames carry int16 MAGNITUDES as floats; the filter takes int16, so
          // this is a round and a clamp, not a rescale.
          const sample = frame[offset + i] ?? 0;
          block[i] = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
        }
        if (exports.gv_speex_run(handle) !== 1) {
          throw new Error('[capture] the speexdsp filter refused a block');
        }
        const filtered = blockView();
        for (let i = 0; i < blockSamples; i += 1) out[offset + i] = filtered[i] ?? 0;
      }
      return out;
    },
    close(): void {
      if (closed) return;
      closed = true;
      view = null;
      exports.gv_speex_destroy(handle);
    },
  };
}

/** How a wrapped opener is built. */
export interface NoiseSuppressingOpenerOptions {
  /** Stage builder. Defaults to the embedded speexdsp filter. */
  readonly create?: NoiseSuppressionFactory | undefined;
  /** Capture rate, for the filter's noise model. Defaults to 16 kHz. */
  readonly sampleRate?: number | undefined;
  readonly warn?: AudioCaptureWarn | undefined;
}

/**
 * Wrap a capture opener so `noiseSuppression: 'speex'` is actually applied.
 *
 * The inner opener is asked for the SAME request with `noiseSuppression: 'none'`,
 * because it is now being asked for raw frames that this wrapper filters — which
 * is also what makes wrapping idempotent: a host that wraps its own opener and
 * then hands it to the listener ends up with the outer wrapper filtering and the
 * inner one passing through, never with the audio filtered twice.
 *
 * With `none`, the inner opener is called unchanged and its frames are handed on
 * untouched — the same Float32Array objects, so the path is byte-identical to
 * having no wrapper at all.
 */
export function createNoiseSuppressingOpener(
  inner: AudioCaptureOpener,
  options: NoiseSuppressingOpenerOptions = {},
): AudioCaptureOpener {
  const create = options.create ?? createSpeexNoiseSuppression;
  return async (request: AudioCaptureRequest, handlers: AudioCaptureHandlers): Promise<AudioCaptureStream> => {
    if (request.noiseSuppression !== 'speex') return inner(request, handlers);

    let stage: NoiseSuppressionStage;
    try {
      stage = await create({
        frameSamples: request.frameSamples,
        sampleRate: options.sampleRate ?? CAPTURE_SAMPLE_RATE,
      });
    } catch (error) {
      throw new AudioCaptureError(
        'noise-suppression-unavailable',
        'voice.wake.noiseSuppression is set to "speex" and the filter could not be started: '
        + `${error instanceof Error ? error.message : String(error)}. Refusing rather than capturing unfiltered `
        + 'audio through a filter you configured. "none" captures without one.',
      );
    }

    let stream: AudioCaptureStream | null = null;
    let stopped = false;
    /**
     * A frame the filter cannot handle stops the stream instead of reaching a
     * consumer: half-filtered audio is the failure this row exists to prevent, so
     * it surfaces as a stream failure the supervisor can act on.
     */
    const failed = (message: string): void => {
      if (stopped) return;
      stopped = true;
      options.warn?.('the noise-suppression stage failed; stopping capture', { detail: message });
      stage.close();
      const error = new AudioCaptureError('noise-suppression-unavailable', message);
      void stream?.stop().catch(() => {});
      handlers.onStopped('failed', error);
    };

    try {
      stream = await inner(
        { ...request, noiseSuppression: 'none' },
        {
          onFrame: (frame) => {
            if (stopped) return;
            let filtered: Float32Array;
            try {
              filtered = stage.process(frame);
            } catch (error) {
              failed(error instanceof Error ? error.message : String(error));
              return;
            }
            handlers.onFrame(filtered);
          },
          onStopped: (reason, error) => {
            if (stopped) return;
            stopped = true;
            stage.close();
            if (error !== undefined) handlers.onStopped(reason, error);
            else handlers.onStopped(reason);
          },
        },
      );
    } catch (error) {
      stage.close();
      throw error;
    }

    const opened = stream;
    return {
      label: opened.label,
      deviceSelectable: opened.deviceSelectable,
      stop: async (): Promise<void> => {
        await opened.stop();
        stage.close();
      },
    };
  };
}
