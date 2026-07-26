/**
 * types.ts — the wake-word engine's boundary types.
 *
 * The engine is isomorphic: the same code runs in a daemon child process and in
 * a browser tab. That is only possible because it never imports an inference
 * runtime. It declares the shape of one instead ({@link WakeInferenceSession})
 * and the host passes a loader in. A Node host and a browser host both hand it
 * onnxruntime-web sessions; a test hands it a stub with recorded outputs.
 *
 * The engine deliberately does NOT own audio capture. Capture is per-surface
 * (a recorder subprocess on a host, `getUserMedia` in a browser), so the engine
 * takes 16 kHz mono frames and returns detections.
 */

/** A dense float tensor crossing the engine/runtime boundary. */
export interface WakeTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/**
 * One loaded model, as much of an inference session as this engine uses. Any
 * runtime that can satisfy this — onnxruntime-web in either environment, or a
 * stub — can drive the engine.
 */
export interface WakeInferenceSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Readonly<Record<string, WakeTensor>>): Promise<Readonly<Record<string, WakeTensor>>>;
  release?(): Promise<void>;
}

/** Loads a model file into a session. Supplied by the host. */
export type WakeSessionLoader = (modelPath: string) => Promise<WakeInferenceSession>;

/** Detector tuning, mirroring the `voice.wake.*` settings that drive it. */
export interface WakeDetectorTuning {
  /** Score a frame must reach. Defaults to the model's `recommendedThreshold`. */
  readonly threshold: number;
  /** Consecutive frames above threshold before a wake is confirmed. */
  readonly patienceFrames: number;
  /** Milliseconds after a confirmed wake during which detections are ignored. */
  readonly cooldownMs: number;
}

/** A confirmed wake. */
export interface WakeDetection {
  /** Which model fired. */
  readonly modelId: string;
  /** The score of the frame that confirmed it. */
  readonly score: number;
  /** Highest score seen across the frames that confirmed it. */
  readonly peakScore: number;
  /** Frames the run of above-threshold scores lasted when it confirmed. */
  readonly frames: number;
  /** Wall-clock milliseconds when it confirmed. */
  readonly at: number;
  /**
   * Samples of audio from BEFORE the detection, per `voice.wake.preRollMs`, so a
   * phrase run into the command is not clipped. Empty when pre-roll is 0.
   */
  readonly preRoll: Float32Array;
}

/** Per-frame scores, emitted whether or not they confirm anything. */
export interface WakeFrameScores {
  /** Model id to score for this frame. */
  readonly scores: ReadonlyMap<string, number>;
  /** Wall-clock milliseconds the frame was scored at. */
  readonly at: number;
}

/** One model the engine runs, already loaded. */
export interface WakeModelHandle {
  readonly id: string;
  readonly session: WakeInferenceSession;
  /** Per-model threshold override; falls back to the engine tuning. */
  readonly threshold?: number | undefined;
}

/**
 * Why a wake-word component is not usable. Returned rather than thrown, so a
 * surface can render an honest unavailable state instead of an error.
 */
export type WakeUnavailableReason =
  | 'not-provisioned'
  | 'checksum-mismatch'
  | 'model-load-failed'
  | 'no-models-configured'
  | 'capture-unavailable';

/** Honest status of one wake-word artifact on disk. */
export interface WakeArtifactStatus {
  readonly path: string;
  /** Content-verified, not existence-checked: the file's sha256 matched the pin. */
  readonly verified: boolean;
  /** Present but failing verification — torn, truncated, or the wrong asset. */
  readonly corrupt: boolean;
  readonly bytes: number;
}
