/**
 * recorder-command.ts — which recorder to run, and the exact argv for it.
 *
 * `voice.wake.captureCommand` names five recorders and an `auto` probe. Turning
 * that setting into a working command line is neither obvious nor uniform, and
 * every one of these arguments was checked against the real tool rather than
 * recalled:
 *
 *  - **pw-record needs `--container raw`.** Without it, writing to `-` emits a
 *    CONTAINER HEADER before the samples. Those leading bytes shift the whole
 *    stream by a partial sample, so the detector runs on audio that is
 *    byte-misaligned and simply never fires. Verified by inspecting the first
 *    bytes of a live stream: `dns.` and a length field without the flag, pure
 *    PCM with it.
 *  - **pw-record's `--target` is a PipeWire node serial or node name**, not a
 *    PulseAudio device name — passing the latter fails with "no target node
 *    available" rather than falling back to the default.
 *  - **parecord writes to stdout only with `--raw`**; without it the stream is
 *    wrapped in a file format.
 *  - **arecord's raw type must be spelled `-t raw`** and it writes to stdout
 *    when given no filename.
 *  - **ffmpeg's input format is per-platform** (`pulse`, `avfoundation`,
 *    `dshow`), so a single argv cannot serve all three.
 *  - **sox cannot select a device from its arguments at all.** It reads
 *    `AUDIODEV` from the environment. Rather than pretend, the resolved command
 *    reports {@link ResolvedRecorderCommand.deviceSelectable} false so a surface
 *    can say the device setting is being ignored.
 *
 * Pure: it probes through an injected predicate and returns argv. Nothing here
 * spawns anything or imports `node:`.
 */
import type { AudioCaptureBackend } from './types.js';
import { CAPTURE_CHANNELS, CAPTURE_SAMPLE_RATE } from './types.js';

/** A concrete recorder, `auto` already resolved. */
export type RecorderBackend = Exclude<AudioCaptureBackend, 'auto'>;

/**
 * Probe order for `auto`, matching the row's written description and mirroring
 * how local audio PLAYBACK discovers its player: prefer the native PipeWire and
 * PulseAudio clients, then ALSA, then the two general-purpose tools.
 */
export const RECORDER_PROBE_ORDER: readonly RecorderBackend[] = [
  'pw-record',
  'parecord',
  'arecord',
  'ffmpeg',
  'sox',
];

/** A recorder resolved to an executable command line. */
export interface ResolvedRecorderCommand {
  readonly backend: RecorderBackend;
  readonly command: string;
  readonly args: readonly string[];
  /** Human-readable label for an indicator, e.g. `parecord`. */
  readonly label: string;
  /** False when this recorder ignores the configured device (sox). */
  readonly deviceSelectable: boolean;
}

export interface RecorderCommandOptions {
  /** Device identifier from `voice.wake.inputDevice`; empty means OS default. */
  readonly device?: string | undefined;
  /** Sample rate to request. Defaults to the capture rate the models need. */
  readonly sampleRate?: number | undefined;
  /** `process.platform`, which decides ffmpeg's input format. */
  readonly platform?: string | undefined;
}

/** ffmpeg's capture input format and default input name for a platform. */
function ffmpegInput(platform: string, device: string): readonly string[] {
  if (platform === 'darwin') return ['-f', 'avfoundation', '-i', device.length > 0 ? device : ':0'];
  if (platform === 'win32') {
    return ['-f', 'dshow', '-i', device.length > 0 ? `audio=${device}` : 'audio=default'];
  }
  return ['-f', 'pulse', '-i', device.length > 0 ? device : 'default'];
}

/**
 * Build the argv for one recorder. Every backend is asked for the same thing:
 * signed 16-bit little-endian mono PCM at the capture rate, raw, on stdout.
 */
export function buildRecorderCommand(
  backend: RecorderBackend,
  options: RecorderCommandOptions = {},
): ResolvedRecorderCommand {
  const device = (options.device ?? '').trim();
  const rate = String(options.sampleRate ?? CAPTURE_SAMPLE_RATE);
  const channels = String(CAPTURE_CHANNELS);
  const platform = options.platform ?? 'linux';
  const base = { backend, label: backend, deviceSelectable: true } as const;

  switch (backend) {
    case 'pw-record':
      return {
        ...base,
        command: 'pw-record',
        args: [
          '--rate', rate,
          '--channels', channels,
          '--format', 's16',
          // Without this the stream carries a container header. See the header note.
          '--container', 'raw',
          ...(device.length > 0 ? ['--target', device] : []),
          '-',
        ],
      };
    case 'parecord':
      return {
        ...base,
        command: 'parecord',
        args: [
          '--raw',
          `--rate=${rate}`,
          `--channels=${channels}`,
          '--format=s16le',
          ...(device.length > 0 ? [`--device=${device}`] : []),
        ],
      };
    case 'arecord':
      return {
        ...base,
        command: 'arecord',
        args: [
          '-q',
          '-t', 'raw',
          '-f', 'S16_LE',
          '-r', rate,
          '-c', channels,
          ...(device.length > 0 ? ['-D', device] : []),
        ],
      };
    case 'ffmpeg':
      return {
        ...base,
        command: 'ffmpeg',
        args: [
          '-hide_banner',
          '-loglevel', 'error',
          ...ffmpegInput(platform, device),
          '-ac', channels,
          '-ar', rate,
          '-f', 's16le',
          '-',
        ],
      };
    case 'sox':
      return {
        ...base,
        // sox reads the default input with -d and takes no device argument.
        deviceSelectable: false,
        command: 'sox',
        args: [
          '-q',
          '-d',
          '-t', 'raw',
          '-b', '16',
          '-e', 'signed-integer',
          '-r', rate,
          '-c', channels,
          '-',
        ],
      };
  }
}

export interface RecorderResolutionOptions extends RecorderCommandOptions {
  /** True when the named executable is on PATH. Injected, so this stays pure. */
  readonly isInstalled: (command: string) => boolean;
}

/**
 * Resolve `voice.wake.captureCommand` to a command line, or null when nothing
 * usable is installed.
 *
 * A named backend that is not installed resolves to null rather than silently
 * falling back to another one: the row exists to PIN the choice on a host where
 * the probe picks a device-starved backend, and quietly overriding that pin
 * would defeat the reason someone set it.
 */
export function resolveRecorderCommand(
  backend: AudioCaptureBackend,
  options: RecorderResolutionOptions,
): ResolvedRecorderCommand | null {
  if (backend !== 'auto') {
    const built = buildRecorderCommand(backend, options);
    return options.isInstalled(built.command) ? built : null;
  }
  for (const candidate of RECORDER_PROBE_ORDER) {
    const built = buildRecorderCommand(candidate, options);
    if (options.isInstalled(built.command)) return { ...built, label: `${built.label} (auto)` };
  }
  return null;
}
