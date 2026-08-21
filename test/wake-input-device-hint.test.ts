/**
 * A pinned input device was believed rather than checked.
 *
 * `voice.wake.inputDevice` named a PipeWire node on the owner's Bluetooth
 * headset. The headset was away. The recorder was handed a target that does not
 * exist and the listener captured NOTHING, no error, no status line, no
 * frames, while showing every sign of listening. It had to be remediated by
 * hand. A pinned device that is absent must never again equal silence.
 *
 * These pin the four cases the fix owes: an absent pin falls back loudly and
 * keeps listening, a returning pin moves capture back with one line, a host
 * with no real microphone says so instead of pretending, and an empty pin
 * behaves exactly as it always did.
 */
import { describe, expect, test } from 'bun:test';

import {
  parseArecordCaptureDevices,
  parsePactlSources,
  resolveAudioInputBinding,
  type AudioInputDevice,
} from '../packages/sdk/src/platform/voice/capture/device-binding.ts';
import { WakeListener } from '../packages/sdk/src/platform/voice/wake/listener.ts';
import { describeWakeListening } from '../packages/sdk/src/platform/voice/wake/listening-claim.ts';
import {
  resolveRecorderCandidates,
  resolveRecorderCommand,
} from '../packages/sdk/src/platform/voice/capture/recorder-command.ts';
import { createRecorderCaptureOpener } from '../packages/sdk/src/platform/voice/capture/recorder-source.ts';
import type { AudioCaptureHandlers, AudioCaptureRequest } from '../packages/sdk/src/platform/voice/capture/types.ts';
import { resolveWakeRuntimeSettings } from '../packages/sdk/src/platform/voice/wake/settings.ts';

const HEADSET = 'bluez_input.AC:BF:71:00:00:01.headset-head-unit';

function mic(id: string, extra: Partial<AudioInputDevice> = {}): AudioInputDevice {
  return { id, label: id, isMonitor: false, ...extra };
}

function monitor(id: string): AudioInputDevice {
  return { id, label: id, isMonitor: true };
}

/** Settings with one device pin, everything else shipped defaults. */
function settingsWithDevice(device: string) {
  const values: Record<string, unknown> = {
    'voice.wake.enabled': true,
    'voice.wake.surfaces.tui': true,
    'voice.wake.inputDevice': device,
  };
  return resolveWakeRuntimeSettings((key) => values[key], 'tui', {
    speexAvailable: true,
    canRetainAudio: true,
    canPlayLocalFile: true,
  });
}

/** A capture opener that records what device it was asked for. */
function recordingOpener() {
  const opened: string[] = [];
  const streams: Array<{ stopped: boolean }> = [];
  const opener = async (request: AudioCaptureRequest, _handlers: AudioCaptureHandlers) => {
    opened.push(request.device);
    const stream = { stopped: false };
    streams.push(stream);
    return {
      label: 'pw-record',
      deviceSelectable: true,
      stop: async () => { stream.stopped = true; },
    };
  };
  return { opener, opened, streams };
}

/** A listener wired with a scripted device list and an immediate re-check timer. */
function makeListener(options: {
  readonly device: string;
  readonly devices: () => readonly AudioInputDevice[] | Promise<readonly AudioInputDevice[]>;
}) {
  const capture = recordingOpener();
  const bindings: Array<{ state: string; device: string; message: string }> = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const listener = new WakeListener({
    settings: settingsWithDevice(options.device),
    openCapture: capture.opener,
    // No suppression stage: this test is about which device is opened.
    createNoiseSuppression: undefined,
    createEngine: async () => ({
      chunkSamples: 1280,
      modelIds: ['hey-goodvibes'],
      pushFrame: async () => ({ detections: [] }),
      reset: () => {},
      close: async () => {},
    }) as never,
    enumerateInputDevices: async () => options.devices(),
    deviceRecheckMs: 1,
    // Distinct from the re-check interval so a test can tell the timers apart;
    // the watchdogs are exercised in their own describe block below.
    startTimeoutMs: 9_000,
    firstFrameTimeoutMs: 8_000,
    handlers: {
      onDeviceBinding: (binding) => {
        bindings.push({ state: binding.state, device: binding.device, message: binding.message });
      },
    },
    // Timers are captured rather than run, so the re-check fires when the test says.
    setTimeout: (handler: () => void, ms: number) => { timers.push({ run: handler, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  /** The pending device re-check, identified by its interval. */
  const takeRecheck = (): (() => void) | undefined => {
    const index = timers.findIndex((timer) => timer.ms === 1);
    if (index === -1) return undefined;
    return timers.splice(index, 1)[0]?.run;
  };
  return { listener, capture, bindings, timers, takeRecheck };
}

describe('an absent pinned device falls back and keeps listening', () => {
  test('the binding names the missing device and moves to the system default', async () => {
    const binding = await resolveAudioInputBinding(HEADSET, async () => [mic('alsa_input.pci-0000_00_1f.3.analog-stereo')]);
    expect(binding.state).toBe('fallback');
    // Empty means the OS default source, the pin is NOT passed through.
    expect(binding.device).toBe('');
    expect(binding.usable).toBe(true);
    expect(binding.message).toContain(HEADSET);
    expect(binding.message).toContain('not connected');
    expect(binding.message).toContain('system default input');
  });

  test('the listener opens the DEFAULT rather than the absent pin, and says so', async () => {
    const wake = makeListener({ device: HEADSET, devices: () => [mic('alsa_input.analog-stereo')] });
    const outcome = await wake.listener.start();

    expect(outcome.started).toBe(true);
    // The exact defect: the recorder used to be handed the absent node.
    expect(wake.capture.opened).toEqual(['']);
    expect(wake.bindings.map((entry) => entry.state)).toEqual(['fallback']);
    expect(wake.bindings[0]?.message).toContain('not connected');
    // And the state a status surface reads carries it, not the configured value.
    expect(wake.listener.state().deviceBinding?.state).toBe('fallback');
    await wake.listener.stop();
  });
});

describe('when the pinned device returns, capture moves back with one line', () => {
  test('the re-check rebinds to the pin and announces exactly once', async () => {
    let present = false;
    const wake = makeListener({
      device: HEADSET,
      devices: () => (present ? [mic('alsa_input.analog-stereo'), mic(HEADSET)] : [mic('alsa_input.analog-stereo')]),
    });
    await wake.listener.start();
    expect(wake.capture.opened).toEqual(['']);

    // The headset is switched on; the re-check timer fires.
    present = true;
    const recheck = wake.takeRecheck();
    expect(recheck).toBeDefined();
    recheck!();
    // Let the rebind's async reopen settle.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Capture reopened ON THE PIN, and the old stream was released.
    expect(wake.capture.opened).toEqual(['', HEADSET]);
    expect(wake.capture.streams[0]?.stopped).toBe(true);
    // One line per rollover, not one per re-check.
    expect(wake.bindings.map((entry) => entry.state)).toEqual(['fallback', 'pinned']);
    await wake.listener.stop();
  });

  test('a re-check while the device is still absent neither reopens nor repeats itself', async () => {
    const wake = makeListener({ device: HEADSET, devices: () => [mic('alsa_input.analog-stereo')] });
    await wake.listener.start();
    const recheck = wake.takeRecheck();
    expect(recheck).toBeDefined();
    recheck!();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(wake.capture.opened).toEqual(['']);
    // Still one announcement, a timer that repeats "still not connected" every
    // interval is the log spam this codebase has already been bitten by.
    expect(wake.bindings).toHaveLength(1);
    await wake.listener.stop();
  });
});

describe('a host with no real microphone says so instead of pretending to listen', () => {
  test('monitor-only sources are NOT a microphone', async () => {
    // The owner's machine state: only HDMI output monitors exist. Capturing
    // from one works perfectly and records what the machine is playing.
    const binding = await resolveAudioInputBinding('', async () => [
      monitor('alsa_output.pci-0000_01_00.1.hdmi-stereo.monitor'),
      monitor('alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'),
    ]);
    expect(binding.state).toBe('no-microphone');
    expect(binding.usable).toBe(false);
    expect(binding.message).toContain('no microphone');
    expect(binding.message).toContain('output monitors');
    expect(binding.message).toContain('Nothing is listening');
  });

  test('the listener refuses with no-microphone and opens no device at all', async () => {
    const wake = makeListener({
      device: '',
      devices: () => [monitor('alsa_output.pci-0000_01_00.1.hdmi-stereo.monitor')],
    });
    const outcome = await wake.listener.start();

    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.refusal).toBe('no-microphone');
    expect(outcome.detail).toContain('output monitors');
    // No silent idle: nothing was opened, and the state says why.
    expect(wake.capture.opened).toEqual([]);
    expect(wake.listener.state().deviceBinding?.state).toBe('no-microphone');
    expect(wake.listener.state().phase).toBe('idle');
  });

  test('a machine reporting no sources at all is named as that, not as a missing pin', async () => {
    const binding = await resolveAudioInputBinding('', async () => []);
    expect(binding.state).toBe('no-microphone');
    expect(binding.message).toContain('no input sources at all');
  });

  test('a pin that names a monitor falls back to a real microphone', async () => {
    const binding = await resolveAudioInputBinding('alsa_output.hdmi-stereo.monitor', async () => [
      mic('alsa_input.analog-stereo'),
      monitor('alsa_output.hdmi-stereo.monitor'),
    ]);
    // Present and selectable, and deaf to people. Honouring it would be the
    // same silence by another route.
    expect(binding.state).toBe('fallback');
    expect(binding.device).toBe('');
    expect(binding.message).toContain('output monitor');
  });
});

describe('an empty pin is unchanged, and an unlistable host is not punished', () => {
  test('empty pin follows the system default exactly as it always did', async () => {
    const binding = await resolveAudioInputBinding('', async () => [
      mic('alsa_input.analog-stereo', { isDefault: true }),
    ]);
    expect(binding.state).toBe('default');
    expect(binding.device).toBe('');
    expect(binding.usable).toBe(true);
    expect(binding.message).toContain('system default input');
  });

  test('a present pin is used, and reported as the device it is', async () => {
    const binding = await resolveAudioInputBinding(HEADSET, async () => [mic('alsa_input.analog-stereo'), mic(HEADSET)]);
    expect(binding.state).toBe('pinned');
    expect(binding.device).toBe(HEADSET);
  });

  test('no enumerator leaves the pin exactly as written', async () => {
    // Every surface that never had device listing must behave as before,
    // refusing to listen because we cannot enumerate would be a regression.
    const binding = await resolveAudioInputBinding(HEADSET);
    expect(binding.state).toBe('unverified');
    expect(binding.device).toBe(HEADSET);
    expect(binding.usable).toBe(true);
  });

  test('an enumerator that throws does not take capture down with it', async () => {
    const binding = await resolveAudioInputBinding(HEADSET, async () => {
      throw new Error('pactl: command not found');
    });
    expect(binding.state).toBe('unverified');
    expect(binding.device).toBe(HEADSET);
    expect(binding.usable).toBe(true);
    expect(binding.message).toContain('pactl: command not found');
  });

  test('the listener with no enumerator opens the configured pin unchanged', async () => {
    const capture = recordingOpener();
    const listener = new WakeListener({
      settings: settingsWithDevice(HEADSET),
      openCapture: capture.opener,
      createEngine: async () => ({
        chunkSamples: 1280,
        modelIds: ['hey-goodvibes'],
        pushFrame: async () => ({ detections: [] }),
        reset: () => {},
        close: async () => {},
      }) as never,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const outcome = await listener.start();
    expect(outcome.started).toBe(true);
    expect(capture.opened).toEqual([HEADSET]);
    await listener.stop();
  });
});

describe('the device listings hosts actually run are parsed here, once', () => {
  test('pactl short sources: a .monitor name is an output monitor', () => {
    // Real `pactl list short sources` output from the owner's machine shape.
    const stdout = [
      '0\talsa_output.pci-0000_01_00.1.hdmi-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED',
      '1\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tRUNNING',
      '2\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED',
    ].join('\n');
    const devices = parsePactlSources(stdout, 'alsa_input.pci-0000_00_1f.3.analog-stereo');

    expect(devices).toHaveLength(3);
    expect(devices.filter((device) => device.isMonitor).map((device) => device.id)).toEqual([
      'alsa_output.pci-0000_01_00.1.hdmi-stereo.monitor',
      'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor',
    ]);
    expect(devices.find((device) => device.isDefault)?.id).toBe('alsa_input.pci-0000_00_1f.3.analog-stereo');
  });

  test('a monitor-only pactl listing resolves to no-microphone end to end', async () => {
    const stdout = '0\talsa_output.pci-0000_01_00.1.hdmi-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED';
    const binding = await resolveAudioInputBinding('', async () => parsePactlSources(stdout));
    expect(binding.state).toBe('no-microphone');
  });

  test('arecord -L: indented description lines are not devices, and null is dropped', () => {
    const stdout = [
      'default',
      '    Playback/recording through the PulseAudio sound server',
      'null',
      '    Discard all samples (playback) or generate zero samples (capture)',
      'sysdefault:CARD=PCH',
      '    HDA Intel PCH, ALC257 Analog',
    ].join('\n');
    expect(parseArecordCaptureDevices(stdout).map((device) => device.id)).toEqual(['default', 'sysdefault:CARD=PCH']);
  });
});


describe('the listening indicator reflects capture truth, not intent', () => {
  /**
   * The boot this pins, observed on the owner's machine: the headset mic was
   * present and default, wake was enabled, the models verified, and the banner
   * said "listening for the wake phrase" while `pactl source-outputs` was
   * empty, the source was SUSPENDED, no pw-record existed, and not one wake or
   * capture line was written for the whole boot. The listener sat in `starting`
   * and the indicator was driven off that phase.
   */
  function stalledStartListener(openNever: boolean) {
    const timers: Array<{ run: () => void; ms: number }> = [];
    const failures: string[] = [];
    const warnings: Array<{ message: string; meta: unknown }> = [];
    let frame: ((f: Float32Array) => void) | null = null;
    const listener = new WakeListener({
      settings: settingsWithDevice(''),
      openCapture: async (_request, handlers) => {
        if (openNever) return await new Promise(() => { /* never settles */ });
        frame = (f) => handlers.onFrame(f);
        return { label: 'pw-record', deviceSelectable: true, stop: async () => {} };
      },
      createEngine: async () => ({
        chunkSamples: 1280,
        modelIds: ['hey-goodvibes'],
        pushFrame: async () => ({ detections: [] }),
        reset: () => {},
        close: async () => {},
      }) as never,
      enumerateInputDevices: async () => [mic('alsa_input.analog-stereo', { isDefault: true })],
      startTimeoutMs: 100,
      firstFrameTimeoutMs: 250,
      handlers: {
        // Both halves: the reason lives on the error, the disposition in the
        // detail. A surface shows the reason, so the reason is what is asserted.
        onFailure: (error, _restarting, detail) => { failures.push(`${error.message} | ${detail}`); },
      },
      warn: (message, meta) => { warnings.push({ message, meta }); },
      setTimeout: (handler, ms) => { timers.push({ run: handler, ms }); return timers.length; },
      clearTimeout: () => {},
    });
    return { listener, timers, failures, warnings, pushFrame: () => frame?.(new Float32Array(1280)) };
  }

  test('a start that never completes is NOT reported as listening', async () => {
    const wake = stalledStartListener(true);
    void wake.listener.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const state = wake.listener.state();
    expect(state.phase).toBe('starting');
    expect(state.captureOpen).toBe(false);
    expect(state.framesFlowing).toBe(false);
    // The claim a surface is allowed to make. It is NOT "listening".
    const claim = describeWakeListening(state);
    expect(claim.kind).toBe('starting');
    expect(claim.message).toContain('not listening yet');
  });

  test('a start that never completes is reported rather than sitting silent forever', async () => {
    const wake = stalledStartListener(true);
    void wake.listener.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Fire the start watchdog.
    const startTimer = wake.timers.find((timer) => timer.ms === 100);
    expect(startTimer).toBeDefined();
    startTimer!.run();

    expect(wake.failures.join(' ')).toContain('did not finish starting');
    expect(wake.warnings.map((entry) => entry.message)).toContain('wake capture start stalled');
    expect(wake.listener.state().phase).toBe('idle');
    expect(describeWakeListening(wake.listener.state()).kind).toBe('not-listening');
  });

  test('a stream that opens but delivers no audio is a failure, not a listening state', async () => {
    const wake = stalledStartListener(false);
    const outcome = await wake.listener.start();
    expect(outcome.started).toBe(true);

    // Open, but nothing has arrived: it may not claim to be listening.
    const openState = wake.listener.state();
    expect(openState.captureOpen).toBe(true);
    expect(openState.framesFlowing).toBe(false);
    expect(describeWakeListening(openState).kind).toBe('no-audio');
    expect(describeWakeListening(openState).message).toContain('no audio is arriving');

    // The first-frame watchdog turns the silence into a reported failure.
    const frameTimer = wake.timers.find((timer) => timer.ms === 250);
    expect(frameTimer).toBeDefined();
    frameTimer!.run();
    expect(wake.failures.join(' ')).toContain('delivered no audio');
    expect(wake.warnings.map((entry) => entry.message)).toContain('wake capture opened but no audio arrived');
  });

  test('once frames arrive, and only then, the claim becomes listening', async () => {
    const wake = stalledStartListener(false);
    await wake.listener.start();
    expect(describeWakeListening(wake.listener.state()).kind).toBe('no-audio');

    wake.pushFrame();

    const state = wake.listener.state();
    expect(state.framesSeen).toBe(1);
    expect(state.framesFlowing).toBe(true);
    const claim = describeWakeListening(state);
    expect(claim.kind).toBe('listening');
    expect(claim.message).toContain('Listening for the wake phrase');
  });

  test('a capture-start failure is reported to the surface, not only returned', async () => {
    // A boot-time start has no caller reading its return value, which is how a
    // failure reached nobody at all.
    const failures: string[] = [];
    const warnings: string[] = [];
    const listener = new WakeListener({
      settings: settingsWithDevice(''),
      openCapture: async () => { throw new Error('pw-record: command not found'); },
      createEngine: async () => ({
        chunkSamples: 1280,
        modelIds: ['hey-goodvibes'],
        pushFrame: async () => ({ detections: [] }),
        reset: () => {},
        close: async () => {},
      }) as never,
      enumerateInputDevices: async () => [mic('alsa_input.analog-stereo', { isDefault: true })],
      handlers: { onFailure: (error, _r, detail) => { failures.push(`${error.message} | ${detail}`); } },
      warn: (message) => { warnings.push(message); },
      setTimeout: () => 0,
      clearTimeout: () => {},
    });

    const outcome = await listener.start();
    expect(outcome.started).toBe(false);
    expect(failures.join(' ')).toContain('pw-record: command not found');
    expect(warnings).toContain('wake capture could not start');
    expect(describeWakeListening(listener.state()).kind).toBe('not-listening');
  });

  test('a host with no microphone claims not-listening and names why', async () => {
    const wake = makeListener({ device: '', devices: () => [monitor('alsa_output.hdmi-stereo.monitor')] });
    await wake.listener.start();
    const claim = describeWakeListening(wake.listener.state());
    expect(claim.kind).toBe('not-listening');
    expect(claim.message).toContain('output monitors');
  });
});


describe('auto means a recorder that captures, not the first one installed', () => {
  /**
   * Measured on the owner's machine, with the bootstrap TDZ already fixed and
   * pw-record installed:
   *
   *   pw-record --target <a name `pactl list short sources` prints>
   *     -> "no target node available", exit 1, 0 bytes
   *   pw-record  (no target, system default)
   *     -> 0 bytes
   *   parecord --device=<the same name>
   *     -> 448000 bytes
   *
   * `auto` takes pw-record because it is first in the probe order and installed,
   * so capture produced nothing at all, no stream in `pactl list short
   * source-outputs`, no recorder child, and not one line written anywhere.
   */
  const installed = (command: string): boolean => command === 'pw-record' || command === 'parecord';

  test('auto picks pw-record first, exactly as the failing host did', () => {
    const resolved = resolveRecorderCommand('auto', { isInstalled: installed });
    expect(resolved?.backend).toBe('pw-record');
  });

  test('once pw-record is known not to capture, auto moves to the next installed recorder', () => {
    const resolved = resolveRecorderCommand('auto', { isInstalled: installed, exclude: ['pw-record'] });
    expect(resolved?.backend).toBe('parecord');
    // And it still carries the device, which is the combination that works here.
    const withDevice = resolveRecorderCommand('auto', {
      isInstalled: installed,
      exclude: ['pw-record'],
      device: 'alsa_output.pci-0000_0c_00.1.hdmi-stereo.monitor',
    });
    expect(withDevice?.args).toContain('--device=alsa_output.pci-0000_0c_00.1.hdmi-stereo.monitor');
  });

  test('a PINNED backend is never substituted, even when it is known to be silent', () => {
    // The row exists to hold the choice. Quietly swapping it is the thing the
    // pin was set to prevent, so it fails honestly instead.
    const resolved = resolveRecorderCommand('pw-record', { isInstalled: installed, exclude: ['pw-record'] });
    expect(resolved?.backend).toBe('pw-record');
  });

  test('when every installed recorder has proven silent, auto has nothing left', () => {
    expect(resolveRecorderCommand('auto', { isInstalled: installed, exclude: ['pw-record', 'parecord'] })).toBeNull();
    expect(resolveRecorderCandidates({ isInstalled: installed, exclude: ['pw-record'] })).toEqual(['parecord']);
    expect(resolveRecorderCandidates({ isInstalled: installed })).toEqual(['pw-record', 'parecord']);
  });

  test('a recorder that opens and delivers nothing is not chosen again by auto', async () => {
    const requests: Array<{ backend: string; exclude: readonly string[] | undefined }> = [];
    const timers: Array<{ run: () => void; ms: number }> = [];
    const listener = new WakeListener({
      settings: settingsWithDevice(''),
      openCapture: async (request) => {
        requests.push({ backend: request.backend, exclude: request.excludeBackends });
        // Whatever is asked for, this host's first choice yields no audio.
        return {
          label: requests.length === 1 ? 'pw-record (auto)' : 'parecord (auto)',
          deviceSelectable: true,
          stop: async () => {},
        };
      },
      createEngine: async () => ({
        chunkSamples: 1280,
        modelIds: ['hey-goodvibes'],
        pushFrame: async () => ({ detections: [] }),
        reset: () => {},
        close: async () => {},
      }) as never,
      enumerateInputDevices: async () => [mic('alsa_input.analog-stereo', { isDefault: true })],
      firstFrameTimeoutMs: 40,
      startTimeoutMs: 9_000,
      handlers: {},
      setTimeout: (handler, ms) => { timers.push({ run: handler, ms }); return timers.length; },
      clearTimeout: () => {},
    });

    await listener.start();
    expect(requests[0]?.exclude).toBeUndefined();

    // pw-record opened and delivered nothing.
    timers.find((timer) => timer.ms === 40)!.run();
    // The supervisor's restart reopens; drive its timer.
    const restart = timers.find((timer) => timer.ms > 40 && timer.ms < 9_000);
    expect(restart).toBeDefined();
    restart!.run();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The second open EXCLUDES the recorder that produced silence.
    expect(requests).toHaveLength(2);
    expect(requests[1]?.exclude).toEqual(['pw-record']);
    await listener.stop();
  });
});


describe('the exclusion actually reaches the recorder', () => {
  test('an opener honours excludeBackends when resolving auto', async () => {
    // Threading the exclusion from the listener is pointless if the opener
    // drops it: `auto` then re-picks the recorder that was just proven silent,
    // forever. This is the seam where that happened.
    const spawned: string[] = [];
    const opener = createRecorderCaptureOpener({
      isInstalled: (command) => command === 'pw-record' || command === 'parecord',
      platform: 'linux',
      spawn: (command) => {
        spawned.push(command);
        return {
          stdout: { on: () => {} } as never,
          stderr: { on: () => {} } as never,
          on: () => undefined,
          kill: () => {},
        };
      },
    });

    const stream = await opener(
      { frameSamples: 1280, device: '', backend: 'auto', noiseSuppression: 'none', excludeBackends: ['pw-record'] },
      { onFrame: () => {}, onStopped: () => {} },
    );
    expect(spawned).toEqual(['parecord']);
    expect(stream.label).toContain('parecord');
    await stream.stop();
  });
});
