/**
 * recorder-source.ts — a host capture stream built from a recorder subprocess.
 *
 * This is the capture opener for every surface that has a shell: the terminal UI
 * and the daemon child process that hosts the detector. It is the same shape the
 * TUI's audio PLAYBACK already uses in reverse — resolve a command, spawn it,
 * treat "no tool installed" as a real reported state rather than an exception —
 * so a host that already spawns a player has nothing new to learn.
 *
 * `spawn` is INJECTED rather than imported. Two reasons, both load-bearing:
 * this module is part of a bundle a browser tab loads (importing
 * `node:child_process` here would break that bundle outright), and a test must
 * be able to drive the byte path — a partial chunk, a mid-frame exit, a
 * non-zero code — without a real microphone or a real recorder installed.
 */
import { AudioFrameSlicer, pcm16ToFloatSamples } from './frames.js';
import {
  resolveRecorderCommand,
  type ResolvedRecorderCommand,
} from './recorder-command.js';
import {
  AudioCaptureError,
  CAPTURE_SAMPLE_RATE,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureRequest,
  type AudioCaptureStream,
  type AudioCaptureWarn,
} from './types.js';

/** The narrow slice of a child process this needs. Matches Node and Bun spawns. */
export interface CaptureChildProcess {
  readonly stdout: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  } | null;
  readonly stderr?: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  } | null | undefined;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
}

/** Spawns a recorder. A host passes `node:child_process`'s spawn, wrapped. */
export type CaptureSpawn = (command: string, args: readonly string[]) => CaptureChildProcess;

export interface RecorderCaptureOptions {
  readonly spawn: CaptureSpawn;
  /** True when a command is on PATH. A host checks with `X_OK` access. */
  readonly isInstalled: (command: string) => boolean;
  /** `process.platform`; decides ffmpeg's input format. */
  readonly platform?: string | undefined;
  /**
   * True only when this host ACTUALLY APPLIES speex suppression to the captured
   * audio. No shipped host does — the stage needs libspeexdsp bindings the
   * platform does not ship — so `speex` is refused rather than captured
   * unfiltered through a filter the user configured.
   */
  readonly speexAvailable?: boolean | undefined;
  readonly sampleRate?: number | undefined;
  readonly warn?: AudioCaptureWarn | undefined;
}

/** How long a stopped recorder is given to exit before it is killed harder. */
const RECORDER_TERM_GRACE_MS = 750;

/**
 * Recorder stderr worth surfacing. A recorder writes progress and warnings to
 * stderr in normal operation, so it is not treated as failure — but it IS the
 * only place the reason a device did not open is written, so it is kept for the
 * error message rather than discarded.
 */
const STDERR_KEEP_CHARS = 400;

function classifyRecorderFailure(stderrText: string): AudioCaptureError | null {
  const text = stderrText.toLowerCase();
  if (text.includes('permission denied') || text.includes('access denied')) {
    return new AudioCaptureError('permission-denied', `the recorder was denied microphone access: ${stderrText.trim()}`);
  }
  if (
    text.includes('no such device')
    || text.includes('no target node available')
    || text.includes('unknown pcm')
    || text.includes('device or resource busy')
    || text.includes('audio open error')
  ) {
    return new AudioCaptureError('device-unavailable', `the capture device could not be opened: ${stderrText.trim()}`);
  }
  return null;
}

/**
 * Build a capture opener over a recorder subprocess.
 *
 * The returned opener rejects with an {@link AudioCaptureError} when nothing can
 * be opened, and reports a stream that dies later through
 * {@link AudioCaptureHandlers.onStopped} — the distinction matters because the
 * first is "this will never work as configured" and the second is what the
 * detector's restart policy exists to handle.
 */
export function createRecorderCaptureOpener(options: RecorderCaptureOptions): AudioCaptureOpener {
  return async (request: AudioCaptureRequest, handlers: AudioCaptureHandlers): Promise<AudioCaptureStream> => {
    if (request.noiseSuppression === 'speex' && options.speexAvailable !== true) {
      throw new AudioCaptureError(
        'noise-suppression-unavailable',
        'voice.wake.noiseSuppression is set to "speex", but this host applies no speex suppression — the stage '
        + 'needs libspeexdsp bindings the platform does not ship. Refusing rather than capturing unfiltered audio '
        + 'through a filter you configured. Set the row back to "none".',
      );
    }
    const resolved = resolveRecorderCommand(request.backend, {
      isInstalled: options.isInstalled,
      device: request.device,
      sampleRate: options.sampleRate ?? CAPTURE_SAMPLE_RATE,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    if (resolved === null) {
      throw new AudioCaptureError('no-recorder', describeMissingRecorder(request.backend));
    }
    return startRecorderStream(resolved, request, handlers, options);
  };
}

function describeMissingRecorder(backend: string): string {
  return backend === 'auto'
    ? 'no audio recorder is installed: none of pw-record, parecord, arecord, ffmpeg or sox was found on PATH. '
      + 'Install one of them, or name a different recorder in voice.wake.captureCommand.'
    : `voice.wake.captureCommand names "${backend}", which is not installed on this host. `
      + 'Install it, or set the row to "auto" to use whichever recorder is present.';
}

function startRecorderStream(
  resolved: ResolvedRecorderCommand,
  request: AudioCaptureRequest,
  handlers: AudioCaptureHandlers,
  options: RecorderCaptureOptions,
): AudioCaptureStream {
  const slicer = new AudioFrameSlicer(request.frameSamples);
  let stderrText = '';
  let stopped = false;
  let stopRequested = false;
  const exited: Array<() => void> = [];
  const child = options.spawn(resolved.command, resolved.args);

  const finish = (reason: 'requested' | 'stream-ended' | 'failed', error?: AudioCaptureError): void => {
    if (stopped) return;
    stopped = true;
    if (error !== undefined) handlers.onStopped(reason, error);
    else handlers.onStopped(reason);
    for (const resolve of exited.splice(0)) resolve();
  };

  child.stdout?.on('data', (chunk: Uint8Array) => {
    if (stopped) return;
    for (const frame of slicer.push(pcm16ToFloatSamples(chunk))) handlers.onFrame(frame);
  });
  child.stderr?.on('data', (chunk: Uint8Array) => {
    if (stderrText.length >= STDERR_KEEP_CHARS) return;
    stderrText += new TextDecoder().decode(chunk);
  });
  child.on('error', (error: Error) => {
    finish('failed', new AudioCaptureError('device-unavailable', `the recorder could not be started: ${error.message}`));
  });
  child.on('close', (code: number | null) => {
    if (stopRequested) {
      finish('requested');
      return;
    }
    const classified = classifyRecorderFailure(stderrText);
    if (classified !== null) {
      finish('failed', classified);
      return;
    }
    if (code !== null && code !== 0) {
      finish(
        'failed',
        new AudioCaptureError(
          'stream-ended',
          `the recorder ${resolved.command} exited with code ${code}${stderrText.trim().length > 0 ? `: ${stderrText.trim()}` : ''}`,
        ),
      );
      return;
    }
    // A clean exit nobody asked for is still the stream ending underneath the
    // detector — the restart policy, not a silent stop, is what handles it.
    finish('failed', new AudioCaptureError('stream-ended', `the recorder ${resolved.command} exited on its own`));
  });

  if (!resolved.deviceSelectable && request.device.trim().length > 0) {
    options.warn?.('capture backend cannot target a device; using the system default', {
      backend: resolved.backend,
      device: request.device,
    });
  }

  return {
    label: resolved.label,
    deviceSelectable: resolved.deviceSelectable,
    stop: async (): Promise<void> => {
      if (stopRequested) return;
      stopRequested = true;
      if (stopped) return;
      child.kill('SIGTERM');
      // Wait for the process to actually go, but only for a bounded moment: a
      // recorder still holding the microphone blocks the next start, so a
      // process that ignores SIGTERM is escalated rather than waited on.
      await new Promise<void>((resolve) => {
        exited.push(resolve);
        const timer = setTimeout(() => {
          if (!stopped) child.kill('SIGKILL');
          resolve();
        }, RECORDER_TERM_GRACE_MS);
        // Unref where the host supports it, so a pending grace timer never holds
        // a process open at exit.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      finish('requested');
    },
  };
}
