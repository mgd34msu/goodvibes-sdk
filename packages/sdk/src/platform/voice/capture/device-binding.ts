/**
 * device-binding.ts — a configured input device is a HINT, not a guarantee.
 *
 * `voice.wake.inputDevice` was believed. It named a PipeWire node on the owner's
 * Bluetooth headset; the headset was away; the recorder was handed a target that
 * does not exist and the listener captured NOTHING — no error, no status, no
 * frames. Wake detection appeared to be running and was deaf, for as long as the
 * headset stayed off. A pinned device that is absent must never again equal
 * silence.
 *
 * The platform already has the rule for this: a persisted binding is validated
 * at every resolve and rebound the moment its target is unusable, for any reason
 * (see the routing bindings this mirrors). Applied to audio:
 *
 *   - the pin is CHECKED against what the host can actually see, at listener
 *     start and again whenever capture fails;
 *   - an absent pin FALLS BACK to the operating system default source and keeps
 *     listening, saying so loudly rather than dying quietly;
 *   - while running on the fallback, the pin is re-checked periodically, and
 *     when the device comes back capture moves to it with one status line;
 *   - a host with no real microphone at all is reported AS THAT, rather than
 *     showing a listening indicator over a device that cannot hear.
 *
 * That last case is not hypothetical either: a machine whose only input sources
 * are output MONITORS (HDMI, a loopback of what the speakers are playing) has no
 * microphone. Capture from a monitor "works" perfectly and records the system's
 * own audio, which is the most convincing way possible to look like it is
 * listening while never hearing a word anyone says.
 *
 * Enumeration itself is the HOST's job — it is `pactl` on one surface and
 * `navigator.mediaDevices` in a browser tab — so it arrives injected, exactly as
 * the capture opener does. Nothing here imports `node:` anything. The parsers
 * for the two common Linux tools live here anyway ({@link parsePactlSources},
 * {@link parseArecordCaptureDevices}) so every host does not reinvent them, and
 * so the monitor rule is pinned by tests against real command output.
 */

/** One capture device the host can see. */
export interface AudioInputDevice {
  /** The identifier that goes in `voice.wake.inputDevice`. */
  readonly id: string;
  /** Human-readable name, for status text. */
  readonly label: string;
  /**
   * True when this source is an output MONITOR rather than a microphone.
   *
   * Load-bearing: a monitor captures what the machine is playing. It satisfies
   * every check that a real device does and hears nobody.
   */
  readonly isMonitor: boolean;
  /** True when the OS reports this as the default source. */
  readonly isDefault?: boolean | undefined;
}

/**
 * Lists the input devices this host can see. Host-supplied.
 *
 * Absent — or throwing — means "this host cannot tell", which is treated as
 * unverifiable rather than as absence: refusing to listen because enumeration
 * is unavailable would break every surface that never had it.
 */
export type AudioInputDeviceEnumerator = () => Promise<readonly AudioInputDevice[]>;

/** What a resolved device pin actually became. */
export type AudioInputBindingState =
  /** The pinned device is present; capture targets it. */
  | 'pinned'
  /** No pin is set; capture follows the operating system default source. */
  | 'default'
  /** A pin is set and ABSENT; capture follows the default and says so. */
  | 'fallback'
  /** No real microphone exists on this host — only monitors, or nothing. */
  | 'no-microphone'
  /** No enumerator, or enumeration failed: the pin is used as given, unchecked. */
  | 'unverified';

/** A resolved audio input binding, with the plain words that explain it. */
export interface AudioInputBinding {
  readonly state: AudioInputBindingState;
  /** What to actually pass to the capture opener. Empty means the OS default. */
  readonly device: string;
  /** What `voice.wake.inputDevice` says, verbatim. */
  readonly pinned: string;
  /** True when capture should be attempted at all. */
  readonly usable: boolean;
  /** One line for a status surface and the diagnostics log. */
  readonly message: string;
}

/** Devices that can actually hear a person. */
function microphones(devices: readonly AudioInputDevice[]): readonly AudioInputDevice[] {
  return devices.filter((device) => !device.isMonitor);
}

/** Does this pin name one of the devices the host can see? */
function findPinned(devices: readonly AudioInputDevice[], pinned: string): AudioInputDevice | null {
  const wanted = pinned.trim();
  if (wanted.length === 0) return null;
  return devices.find((device) => device.id === wanted || device.label === wanted) ?? null;
}

/** The "there is nothing to listen with" line, naming which of the two it is. */
function noMicrophoneMessage(devices: readonly AudioInputDevice[], pinned: string): string {
  const monitors = devices.filter((device) => device.isMonitor);
  const head = pinned.trim().length > 0
    ? `Wake has no microphone — the pinned input device ${pinned} is not connected, and `
    : 'Wake has no microphone — ';
  if (monitors.length > 0) {
    return `${head}the only input sources on this machine are output monitors `
      + `(${monitors.map((device) => device.label || device.id).join(', ')}), which record what the machine is `
      + 'playing rather than anything spoken. Nothing is listening.';
  }
  return `${head}this machine reports no input sources at all. Nothing is listening.`;
}

/**
 * Resolve `voice.wake.inputDevice` against what the host can see.
 *
 * Never throws: an enumerator that fails leaves the pin unverified and the
 * listener behaves exactly as it did before this existed.
 */
export async function resolveAudioInputBinding(
  pinned: string,
  enumerate?: AudioInputDeviceEnumerator | undefined,
): Promise<AudioInputBinding> {
  const pin = pinned.trim();
  if (enumerate === undefined) {
    return {
      state: 'unverified',
      device: pin,
      pinned: pin,
      usable: true,
      message: pin.length > 0
        ? `Listening on the pinned input device ${pin}. This surface cannot list devices, so whether it is actually connected is unknown.`
        : 'Listening on the system default input.',
    };
  }

  let devices: readonly AudioInputDevice[];
  try {
    devices = await enumerate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: 'unverified',
      device: pin,
      pinned: pin,
      usable: true,
      message: `The input devices on this machine could not be listed (${detail}), so the device setting is used as written.`,
    };
  }

  const mics = microphones(devices);
  if (mics.length === 0) {
    return {
      state: 'no-microphone',
      device: '',
      pinned: pin,
      usable: false,
      message: noMicrophoneMessage(devices, pin),
    };
  }

  if (pin.length === 0) {
    const preferred = mics.find((device) => device.isDefault) ?? mics[0];
    return {
      state: 'default',
      device: '',
      pinned: pin,
      usable: true,
      message: `Listening on the system default input${preferred ? ` (currently ${preferred.label || preferred.id})` : ''}.`,
    };
  }

  const match = findPinned(devices, pin);
  if (match !== null && !match.isMonitor) {
    return {
      state: 'pinned',
      device: match.id,
      pinned: pin,
      usable: true,
      message: `Listening on the pinned input device ${match.label || match.id}.`,
    };
  }
  if (match !== null && match.isMonitor) {
    // Pinned at a monitor: present, selectable, and deaf to people. Falling back
    // to a real microphone beats honouring a pin that cannot hear.
    return {
      state: 'fallback',
      device: '',
      pinned: pin,
      usable: true,
      message: `The pinned input device ${pin} is an output monitor — it records what this machine is playing, not `
        + 'what anyone says. Listening on the system default input instead.',
    };
  }
  return {
    state: 'fallback',
    device: '',
    pinned: pin,
    usable: true,
    message: `The pinned input device ${pin} is not connected; listening on the system default input instead. `
      + 'Capture moves back to it automatically when it returns.',
  };
}

/**
 * Parse `pactl list short sources` output into devices.
 *
 * Columns are tab-separated: index, name, driver, sample spec, state. A name
 * ending in `.monitor` is PulseAudio/PipeWire's convention for an output
 * monitor, which is the whole reason this function distinguishes them.
 */
export function parsePactlSources(stdout: string, defaultSourceName?: string | undefined): readonly AudioInputDevice[] {
  const devices: AudioInputDevice[] = [];
  for (const line of stdout.split('\n')) {
    const columns = line.split('\t').map((column) => column.trim()).filter((column) => column.length > 0);
    if (columns.length < 2) continue;
    const name = columns[1];
    if (name === undefined || name.length === 0) continue;
    devices.push({
      id: name,
      label: name,
      isMonitor: name.endsWith('.monitor'),
      ...(defaultSourceName !== undefined ? { isDefault: name === defaultSourceName } : {}),
    });
  }
  return devices;
}

/**
 * Parse `arecord -L` output into devices.
 *
 * Device names start at column 0 and their descriptions are indented beneath.
 * ALSA exposes no monitors here, so everything listed is treated as a real
 * capture device — `null` excepted, which discards audio.
 */
export function parseArecordCaptureDevices(stdout: string): readonly AudioInputDevice[] {
  const devices: AudioInputDevice[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0 || /^\s/.test(line)) continue;
    const name = line.trim();
    if (name.length === 0 || name === 'null') continue;
    devices.push({ id: name, label: name, isMonitor: false });
  }
  return devices;
}
