/**
 * schema-domain-voice-wake.ts — wake-word detection settings (`voice.wake.*`).
 *
 * A domain of its own rather than another block inside schema-domain-voice-local.ts
 * because the two configure unrelated things: `voice.local.*` points at local STT/TTS
 * binaries a user installed, while these rows govern an always-listening capture
 * loop. They share only the `voice` namespace.
 *
 * EVERY ROW IS A REAL FEATURE, NOT A SWITCH. Each key below changes behaviour that
 * exists and is reachable, and each carries a written description of what it does and
 * why its default is what it is. `voice.wake.enabled` defaults to `false`: an
 * always-on microphone must be an explicit act.
 *
 * The MODEL is not that act. It ships with the installation — the installer and the
 * npm postinstall provision it, and a daemon retries at boot — so the row above is
 * the only thing between an installed machine and a working wake word. What still
 * never happens is a download triggered by a switch: enabling detection on a host
 * whose artifacts are absent reports which are missing and names the recovery
 * command, exactly as it did when provisioning was the user's job.
 *
 * THESE ROWS ARE LIVE, AND SAY WHERE
 *
 * Capture is wired: the terminal opens a recorder subprocess (voice.wake.captureCommand)
 * and a browser tab opens getUserMedia, both feeding the same engine and both handing
 * the utterance after a wake to the same speech-to-text call. `notOperable` is gone from
 * the `wake-word-detection` registry entry, removed in the change that wired capture up
 * rather than before it.
 *
 * Where a row cannot take effect it says so IN ITS OWN DESCRIPTION rather than behind a
 * blanket declaration, because the remaining gaps are per-row and per-surface, not
 * whole-feature: `voice.wake.surfaces.agent` has no capture host, `voice.wake.vadThreshold`
 * has no VAD model pinned to run, and a browser tab has no filesystem for
 * `voice.wake.retainAudio` or a local `voice.wake.activationSoundPath`. Those three are
 * refused or reported by resolveWakeRuntimeSettings, which reads every row here and is
 * the one place they become behaviour — a row it does not read is a row that configures
 * nothing, and a test asserts that set against this one.
 *
 * THE 26 ROWS AND THE ONE DELIBERATE DEVIATION
 *
 * These are the rows accepted in the 2026-07-25 wake-word design rulings. Two
 * deliberate differences from that accepted list, both recorded here rather than
 * buried:
 *
 *  - Row 26, `voice.wake.wyomingServer`, is ABSENT. The ruling was that the Wyoming
 *    wake-server is Tier B and "NOT built; needs its own explicit owner go", which
 *    has not been given. Shipping the key without the server behind it would be a
 *    bare toggle wired to nothing, so the key waits for the feature.
 *  - `voice.wake.threshold` defaults to **0.9, not the accepted 0.5** — see that
 *    row's description for the measurement that overrode it.
 *
 * `voice.wake.models` is a comma-separated list rather than the design's `string[]`.
 * Array-valued config (`conversationGate.gatedSurfaces`, `wrfc.gates`) is not a
 * scalar ConfigKey in this schema and so cannot appear in a settings workspace; a
 * model list the user cannot edit from settings would not be a configurable feature.
 * {@link parseWakeModelList} is the one place the scalar is split.
 */
import { type ConfigSettingDefinition, intRange, numRange } from './schema-shared.js';

/** Wake-word detection configuration (`voice.wake.*`). */
export interface VoiceWakeConfig {
  wake: {
    enabled: boolean;
    models: string;
    threshold: number;
    patienceFrames: number;
    cooldownMs: number;
    vadThreshold: number;
    noiseSuppression: 'none' | 'speex';
    inputDevice: string;
    captureCommand: 'auto' | 'pw-record' | 'parecord' | 'arecord' | 'ffmpeg' | 'sox';
    surfaces: { tui: boolean; agent: boolean; webui: boolean };
    activationSound: 'none' | 'chime' | 'custom';
    activationSoundPath: string;
    indicator: 'off' | 'statusline' | 'banner';
    preRollMs: number;
    captureMaxSeconds: number;
    silenceStopMs: number;
    autoSubmit: boolean;
    retainAudio: 'none' | 'session-temp';
    customModelDir: string;
    maxRestarts: number;
    restartBackoffMs: number;
    crashWindowSeconds: number;
    browserBackend: 'wasm' | 'webgpu';
  };
}

/*
 * No `declare module './schema-types.js'` block here on purpose. TypeScript's
 * interface merging requires every declaration of a property to give it the
 * SAME type, and schema-domain-voice-local.ts already declares `voice`. That
 * file owns the `voice` key and widens it to `VoiceLocalConfig & VoiceWakeConfig`;
 * this module contributes the type, the defaults, and the rows.
 */

/** The wake model id shipped and pinned by the SDK. */
export const DEFAULT_WAKE_MODEL_ID = 'hey_goodvibes';

export const voiceWakeConfigDefaults: { voice: VoiceWakeConfig } = {
  voice: {
    wake: {
      enabled: false,
      models: DEFAULT_WAKE_MODEL_ID,
      threshold: 0.9,
      patienceFrames: 2,
      cooldownMs: 2000,
      vadThreshold: 0,
      noiseSuppression: 'none',
      inputDevice: '',
      captureCommand: 'auto',
      surfaces: { tui: true, agent: false, webui: false },
      activationSound: 'chime',
      activationSoundPath: '',
      indicator: 'statusline',
      preRollMs: 500,
      captureMaxSeconds: 10,
      silenceStopMs: 1200,
      autoSubmit: false,
      retainAudio: 'none',
      customModelDir: '',
      maxRestarts: 3,
      restartBackoffMs: 2000,
      crashWindowSeconds: 60,
      browserBackend: 'wasm',
    },
  },
};

/**
 * Split `voice.wake.models` into model ids, dropping blanks and duplicates while
 * preserving order. The single place the scalar setting becomes a list.
 */
export function parseWakeModelList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const id = part.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const voiceWakeConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'voice.wake.enabled',
    type: 'boolean',
    default: false,
    description:
      'Run the wake-word detector, listening continuously for the wake phrase on the configured input device. '
      + 'Turning it on starts a supervised capture process and a persistent listening indicator; turning it off stops '
      + 'it and releases the device immediately. '
      + 'WHERE IT LISTENS depends on the voice.wake.surfaces.* rows: the terminal captures through a recorder '
      + 'subprocess and is on by default, a browser tab captures through getUserMedia and is opted in per origin, and '
      + 'the agent surface has no capture host yet. '
      + 'Off by default because an always-on microphone must be an explicit act, not something a user discovers after '
      + 'the fact. '
      + 'THE MODEL IS ALREADY THERE: installing goodvibes downloads and checksum-verifies the pinned classifier, and a '
      + 'daemon retries at boot if the install could not reach the network — so turning this on normally needs no setup '
      + 'step at all. Turning it on never downloads anything itself: on a host whose artifacts are missing or fail '
      + 'verification it says exactly which, and names the command that fetches them, rather than silently pulling '
      + '6.1 MB the moment a switch moves.',
  },
  {
    key: 'voice.wake.models',
    type: 'string',
    default: DEFAULT_WAKE_MODEL_ID,
    description:
      'Comma-separated wake-word models to run concurrently, by id. Default "hey_goodvibes" is the model the SDK pins, hosts, '
      + 'and verifies by checksum. Additional ids resolve against voice.wake.customModelDir. Each model costs one classifier '
      + 'inference per 80 ms frame — the shared melspectrogram and speech-embedding front end is computed once regardless of how '
      + 'many models are listed, so a second model is far cheaper than a second detector. An empty list disables detection '
      + 'without stopping the service.',
  },
  {
    key: 'voice.wake.threshold',
    type: 'number',
    default: 0.9,
    ...numRange(0, 1),
    description:
      'Score, 0 to 1, a frame must reach for the wake phrase to count as heard. '
      + 'DELIBERATELY 0.9, NOT openWakeWord\'s upstream default of 0.5 and not the 0.5 originally accepted for this row: measurement on '
      + 'the shipped hey_goodvibes model showed 0.5 fires on 34.5% of never-trained minimal-pair phrases ("hey good vibe check", '
      + '"hey goodbye vibes" — ordinary English a user will actually say) at 99.2% recall, while 0.9 cuts that to 24.7% for 96.8% recall. '
      + 'Trading 2.4 points of recall to remove roughly a third of the wrong wakes is the better default for a microphone that is always on. '
      + 'Lower it toward 0.5 if the detector misses you; raise it above 0.9 if it fires when you did not speak to it. '
      + 'Recall figures here are synthetic-only — no human has recorded the phrase.',
  },
  {
    key: 'voice.wake.patienceFrames',
    type: 'number',
    default: 2,
    ...intRange(1, 10),
    description:
      'Consecutive 80 ms frames that must all score above voice.wake.threshold before the wake fires. '
      + 'Two frames is about 160 ms of agreement, which removes most single-frame false accepts for one extra frame of latency. '
      + 'Set to 1 for the fastest possible trigger at the cost of more spurious wakes.',
  },
  {
    key: 'voice.wake.cooldownMs',
    type: 'number',
    default: 2000,
    ...intRange(0, 60_000),
    description:
      'Milliseconds after a confirmed wake during which further detections are ignored, so one spoken phrase cannot fire twice '
      + 'as it passes through the detector\'s rolling window. Applied after patience confirms a hit. '
      + '0 disables the cooldown and lets every confirmed frame fire.',
  },
  {
    key: 'voice.wake.vadThreshold',
    type: 'number',
    default: 0,
    ...numRange(0, 1),
    description:
      'Speech-probability floor, 0 to 1, from a voice-activity detector run ahead of the wake classifier; frames below it are '
      + 'discarded before scoring. 0 means the VAD stage is off, which is the shipped default: it costs an extra model download '
      + 'and per-frame inference, and there is no measured false-accept evidence yet that justifies it. '
      + 'NO VAD MODEL IS PINNED TODAY, so any value above 0 REFUSES TO START the detector with that reason stated, rather '
      + 'than running unscreened frames through a stage you have configured — the same posture as noiseSuppression below. '
      + 'It becomes usable when a VAD model joins the pinned manifest; until then 0 is the only value that runs.',
  },
  {
    key: 'voice.wake.noiseSuppression',
    type: 'enum',
    default: 'none',
    enumValues: ['none', 'speex'],
    description:
      'Noise suppression applied to captured audio before detection. "none" ships by default because "speex" requires libspeexdsp '
      + 'on the host, which the platform does not install or manage; when it is selected and the library is absent the service '
      + 'reports honestly unavailable rather than silently running unfiltered.',
  },
  {
    key: 'voice.wake.inputDevice',
    type: 'string',
    default: '',
    description:
      'Capture device to listen on. Empty means the operating system default source. '
      + 'Shared by BOTH microphone consumers: wake detection and push-to-talk voice input open the same device through the '
      + 'same path, so this row moves both rather than only the always-on one. '
      + 'Device identifiers are host-specific — list real ones with `pactl list short sources` or `arecord -L`, or use a '
      + 'navigator.mediaDevices deviceId in a browser tab. Note pw-record takes a PipeWire node serial or node name here, '
      + 'not a PulseAudio device name, and sox cannot target a device at all (it reads AUDIODEV from the environment), which '
      + 'the surface reports rather than silently ignoring.',
  },
  {
    key: 'voice.wake.captureCommand',
    type: 'enum',
    default: 'auto',
    enumValues: ['auto', 'pw-record', 'parecord', 'arecord', 'ffmpeg', 'sox'],
    description:
      'Which recorder feeds capture on a HOST surface — the terminal and the daemon child process. A browser tab ignores this '
      + 'row and uses getUserMedia. Feeds both consumers: wake detection and push-to-talk voice input. '
      + '"auto" probes for pw-record, parecord, arecord, ffmpeg, then sox and uses the first present, mirroring how local audio '
      + 'playback discovers its player. Name one explicitly to pin the choice on a host where the probe picks a device-starved '
      + 'backend; a named recorder that is not installed reports that instead of quietly falling back, because pinning it was '
      + 'the point.',
  },
  {
    key: 'voice.wake.surfaces.tui',
    type: 'boolean',
    default: true,
    description:
      'Listen for the wake phrase on the terminal, through a recorder subprocess on the host. On by default: once wake detection '
      + 'is enabled the terminal is the primary surface, and a wake that reaches no surface is a detector that appears broken. '
      + 'A confirmed wake plays the activation sound, shows the listening indicator, captures the utterance that follows and '
      + 'sends it to speech-to-text, then places the transcript in the composer — or submits it when voice.wake.autoSubmit is on.',
  },
  {
    key: 'voice.wake.surfaces.agent',
    type: 'boolean',
    default: false,
    description:
      'Listen for the wake phrase on the agent surface. Off by default because two terminal surfaces both acting on one spoken '
      + 'utterance is a confusing default. '
      + 'THE AGENT HAS NO CAPTURE HOST YET: the shared capture path is built and the agent surface does not open it, so turning '
      + 'this on records the choice and starts nothing there. It takes effect when the agent wires the same recorder path the '
      + 'terminal uses; the terminal and browser rows are unaffected.',
  },
  {
    key: 'voice.wake.surfaces.webui',
    type: 'boolean',
    default: false,
    description:
      'Listen for the wake phrase in the web UI, which runs the detector inside the browser tab on a WASM backend and downloads the '
      + 'pinned model through the daemon. Off by default because browser capture is a separate stack with its own per-origin '
      + 'microphone permission prompt — it is opted into per browser, not inherited from the host. While it is off the tab never '
      + 'calls getUserMedia at all, so no permission prompt appears. A plain-http origin cannot capture and says so instead of '
      + 'failing silently.',
  },
  {
    key: 'voice.wake.activationSound',
    type: 'enum',
    default: 'chime',
    enumValues: ['none', 'chime', 'custom'],
    description:
      'Sound played the moment a wake is confirmed. "chime" by default because audible confirmation is how a user knows the '
      + 'microphone acted — a silent wake is the behaviour people distrust. "custom" plays voice.wake.activationSoundPath; '
      + '"none" is silent and leaves voice.wake.indicator as the only feedback.',
  },
  {
    key: 'voice.wake.activationSoundPath',
    type: 'string',
    default: '',
    description:
      'Absolute path to the audio file played on wake. Read only when voice.wake.activationSound is "custom"; ignored otherwise. '
      + 'A host surface plays the file through the same player local voice output uses. A browser tab cannot read a path on your '
      + 'machine, so it plays the built-in chime instead and reports that this row is not in force there — a wake stays audible '
      + 'either way.',
  },
  {
    key: 'voice.wake.indicator',
    type: 'enum',
    default: 'statusline',
    enumValues: ['off', 'statusline', 'banner'],
    description:
      'How the surface shows that the microphone is live. "statusline" keeps a persistent listening marker for as long as the '
      + 'detector runs — not only at the moment of a wake — so an always-on microphone is never invisible: a footer row in the '
      + 'terminal, a status-strip chip in the web UI. "banner" is more prominent; "off" removes the marker entirely and is not '
      + 'the default for that reason.',
  },
  {
    key: 'voice.wake.preRollMs',
    type: 'number',
    default: 500,
    ...intRange(0, 2000),
    description:
      'Milliseconds of audio kept from BEFORE the wake fired and prepended to the speech-to-text request, so a phrase run '
      + 'straight into the command ("hey goodvibes, what\'s—") is not clipped at the front. 500 ms covers the detector\'s own '
      + 'confirmation latency plus a fast speaker. 0 starts capture at the moment of detection.',
  },
  {
    key: 'voice.wake.captureMaxSeconds',
    type: 'number',
    default: 10,
    ...intRange(1, 120),
    description:
      'Hard ceiling on how long capture runs before it stops on its own. Bounds memory and guarantees a stuck or silent stream '
      + 'cannot hold the microphone open indefinitely. Applies to post-wake capture AND to push-to-talk, where a key-release '
      + 'event that never arrives would otherwise leave the device open.',
  },
  {
    key: 'voice.wake.silenceStopMs',
    type: 'number',
    default: 1200,
    ...intRange(100, 10_000),
    description:
      'Milliseconds of silence that end post-wake capture, so the request is sent when the user stops talking rather than at '
      + 'the voice.wake.captureMaxSeconds ceiling. Raise it if capture cuts off mid-sentence during natural pauses. '
      + 'Post-wake only: push-to-talk ends when the key is released, because someone holding it through a pause has not '
      + 'finished talking.',
  },
  {
    key: 'voice.wake.autoSubmit',
    type: 'boolean',
    default: false,
    description:
      'Submit the transcribed text as a turn automatically instead of placing it in the input for review. Applies to the '
      + 'utterance captured after a WAKE; push-to-talk always places its transcript in the composer, because a person who pressed '
      + 'a key is already looking at the screen. '
      + 'Off by default, matching the never-auto-send posture of the existing voice input: a misheard transcript must not become '
      + 'a submitted turn without a human seeing it first.',
  },
  {
    key: 'voice.wake.retainAudio',
    type: 'enum',
    default: 'none',
    enumValues: ['none', 'session-temp'],
    description:
      'Whether captured audio is written to disk. "none" by default — nothing is stored, which is the only setting under which '
      + 'the microphone leaves no recording behind. "session-temp" keeps clips in a session-scoped directory that is deleted when '
      + 'the session ends and swept on recovery, and exists to debug a bad transcript, not as a recording feature. '
      + 'A browser tab has no filesystem to retain into: it reports that this row is not in force rather than appearing to store '
      + 'clips it is not storing.',
  },
  {
    key: 'voice.wake.customModelDir',
    type: 'string',
    default: '',
    description:
      'Directory searched for wake models whose ids are not the pinned default. Empty uses the managed wake model directory '
      + 'under the surface storage root. Set it to keep your own models outside the managed tree; files there are loaded as-is '
      + 'and are not checksum-pinned, unlike the managed download.',
  },
  {
    key: 'voice.wake.maxRestarts',
    type: 'number',
    default: 3,
    ...intRange(0, 20),
    description:
      'How many times the supervisor restarts a crashed detector process inside voice.wake.crashWindowSeconds before it stops '
      + 'trying and reports the failure. Matches the restart ceiling used for MCP clients. 0 disables restarts, so any crash is '
      + 'terminal and immediately visible.',
  },
  {
    key: 'voice.wake.restartBackoffMs',
    type: 'number',
    default: 2000,
    ...intRange(0, 60_000),
    description:
      'Base delay before restarting a crashed detector, multiplied by the attempt number for linear backoff (2 s, 4 s, 6 s). '
      + 'Stops a process that fails instantly from becoming a restart storm.',
  },
  {
    key: 'voice.wake.crashWindowSeconds',
    type: 'number',
    default: 60,
    ...intRange(1, 3600),
    description:
      'Rolling window in which repeated crashes count toward voice.wake.maxRestarts. Exceeding the ceiling inside this window '
      + 'latches the supervisor off so a detector that cannot stay up stops consuming the device; a clean run past the window '
      + 'resets the count.',
  },
  {
    key: 'voice.wake.browserBackend',
    type: 'enum',
    default: 'wasm',
    enumValues: ['wasm', 'webgpu'],
    description:
      'Execution backend for the detector inside a browser tab. "wasm" is the default and the measured configuration: the '
      + 'per-frame cost already beats real time by a wide margin, and WebGPU cannot run the front end without splitting the graph '
      + 'across devices, which costs more in transfers than it saves. "webgpu" is available for hosts that measure otherwise. '
      + 'Read by the browser tab when it creates its inference sessions; a host surface always runs WASM and ignores this row.',
  },
];
