/**
 * The wake-word settings surface and the detector's restart policy.
 *
 * Two owner rulings are load-bearing here and are asserted rather than trusted:
 * every row is a real configurable feature with a written description (never a
 * bare toggle), and the feature ships disabled — an always-on microphone is an
 * explicit act.
 */
import { describe, expect, test } from 'bun:test';
import {
  voiceWakeConfigDefaults,
  voiceWakeConfigSettings,
  parseWakeModelList,
  DEFAULT_WAKE_MODEL_ID,
} from '../packages/sdk/src/platform/config/schema-domain-voice-wake.js';
import { DEFAULT_CONFIG, CONFIG_SCHEMA, CONFIG_KEYS } from '../packages/sdk/src/platform/config/schema.js';
import { FEATURE_FLAGS } from '../packages/sdk/src/platform/runtime/feature-flags/flags.js';
import { FEATURE_SETTINGS } from '../packages/sdk/src/platform/runtime/feature-flags/feature-settings.js';
import { getFeatureFlagConfig } from '../packages/sdk/src/platform/runtime/feature-flags/flag-config-map.js';
import {
  WakeSupervisor,
  WAKE_SUPERVISOR_DEFAULTS,
} from '../packages/sdk/src/platform/voice/wake/supervisor.js';
import {
  featureInoperability,
  isFeatureGateEnabled,
  requireFeatureGate,
} from '../packages/sdk/src/platform/runtime/feature-flags/gates.js';
import {
  WAKE_SETTING_KEYS,
  resolveWakeRuntimeSettings,
  wakeSurfaceKey,
  type WakeSurface,
} from '../packages/sdk/src/platform/voice/wake/settings.js';
import { deriveFeatureState, FEATURE_SETTINGS_BINDINGS } from '../packages/sdk/src/platform/runtime/feature-flags/feature-settings.js';

const WAKE = voiceWakeConfigDefaults.voice.wake;

describe('the wake-word settings rows', () => {
  test('all 27 built rows are present, and the unbuilt Wyoming row is not', () => {
    // The design listed 26 rows. Row 26, voice.wake.wyomingServer, is the
    // Tier-B Wyoming wake-server, ruled "NOT built; needs its own explicit
    // owner go". Shipping its key would be a switch wired to nothing.
    // 27 built rows now: the 25 from that design, plus voice.wake.silenceFloorRms
    // (what makes silenceStopMs work in a room that is not quiet) and
    // voice.wake.speechRetriggerMs (what makes it work on a close-worn
    // microphone, where a breath is loud enough to restart the wait).
    expect(voiceWakeConfigSettings.length).toBe(27);
    expect(voiceWakeConfigSettings.some((s) => s.key === 'voice.wake.wyomingServer')).toBe(false);
  });

  test('every row has a real written description, not a restated key name', () => {
    for (const setting of voiceWakeConfigSettings) {
      expect(setting.key.startsWith('voice.wake.')).toBe(true);
      // Long enough to say what it does and why the default is what it is.
      expect(setting.description.length).toBeGreaterThan(80);
      expect(setting.description.trim()).not.toBe(setting.key);
      if (setting.type === 'enum') {
        expect(Array.isArray(setting.enumValues)).toBe(true);
        expect((setting.enumValues ?? []).length).toBeGreaterThan(1);
        expect(setting.enumValues).toContain(setting.default as string);
      }
    }
  });

  test('every row is reachable as a config key and carries the shipped default', () => {
    for (const setting of voiceWakeConfigSettings) {
      expect(CONFIG_KEYS.has(setting.key)).toBe(true);
      const schemaRow = CONFIG_SCHEMA.find((row) => row.key === setting.key);
      expect(schemaRow?.default).toEqual(setting.default);
    }
  });

  test('the feature ships disabled', () => {
    expect(WAKE.enabled).toBe(false);
    expect(DEFAULT_CONFIG.voice.wake.enabled).toBe(false);
  });

  test('the threshold default is 0.9, overriding the accepted 0.5', () => {
    expect(WAKE.threshold).toBe(0.9);
    const row = voiceWakeConfigSettings.find((s) => s.key === 'voice.wake.threshold');
    // The measurement that justified the override has to travel with the row,
    // or the next person to read it sees an unexplained deviation.
    expect(row?.description).toContain('34.5%');
    expect(row?.description).toContain('24.7%');
    expect(row?.description).toContain('96.8%');
    expect(row?.description).toContain('synthetic-only');
  });

  test('the accepted defaults are what shipped', () => {
    expect(WAKE.patienceFrames).toBe(2);
    expect(WAKE.cooldownMs).toBe(2000);
    expect(WAKE.vadThreshold).toBe(0);
    expect(WAKE.activationSound).toBe('chime');
    expect(WAKE.indicator).toBe('statusline');
    expect(WAKE.preRollMs).toBe(500);
    expect(WAKE.autoSubmit).toBe(false);
    expect(WAKE.retainAudio).toBe('none');
    expect(WAKE.browserBackend).toBe('wasm');
    expect(WAKE.noiseSuppression).toBe('none');
    expect(WAKE.captureCommand).toBe('auto');
    expect(WAKE.captureMaxSeconds).toBe(10);
    expect(WAKE.silenceStopMs).toBe(1200);
    expect(WAKE.inputDevice).toBe('');
    expect(WAKE.activationSoundPath).toBe('');
    expect(WAKE.customModelDir).toBe('');
  });

  test('surfaces default to tui on, agent off, webui off', () => {
    expect(WAKE.surfaces).toEqual({ tui: true, agent: false, webui: false });
  });

  test('the supervisor defaults are 3 restarts / 2000 ms / 60 s', () => {
    expect(WAKE.maxRestarts).toBe(3);
    expect(WAKE.restartBackoffMs).toBe(2000);
    expect(WAKE.crashWindowSeconds).toBe(60);
    // The engine's own defaults must not drift from the settings that drive it.
    expect(WAKE_SUPERVISOR_DEFAULTS.maxRestarts).toBe(WAKE.maxRestarts);
    expect(WAKE_SUPERVISOR_DEFAULTS.restartBackoffMs).toBe(WAKE.restartBackoffMs);
    expect(WAKE_SUPERVISOR_DEFAULTS.crashWindowSeconds).toBe(WAKE.crashWindowSeconds);
  });

  test('the model list defaults to the pinned hey_goodvibes model', () => {
    expect(WAKE.models).toBe(DEFAULT_WAKE_MODEL_ID);
    expect(parseWakeModelList(WAKE.models)).toEqual(['hey_goodvibes']);
  });

  test('the model list tolerates spacing, blanks and duplicates', () => {
    expect(parseWakeModelList(' hey_goodvibes , alexa ,, hey_goodvibes ')).toEqual(['hey_goodvibes', 'alexa']);
    expect(parseWakeModelList('')).toEqual([]);
    expect(parseWakeModelList('   ')).toEqual([]);
  });
});

describe('the wake-word feature registry row', () => {
  const flag = FEATURE_FLAGS.find((entry) => entry.id === 'wake-word-detection');

  test('is registered, disabled, tier 3 and runtime-toggleable', () => {
    expect(flag).toBeDefined();
    expect(flag?.defaultState).toBe('disabled');
    expect(flag?.tier).toBe(3);
    expect(flag?.runtimeToggleable).toBe(true);
  });

  test('is bound to voice.wake.enabled and lists its tuning keys', () => {
    const setting = FEATURE_SETTINGS.find((entry) => entry.id === 'wake-word-detection');
    expect(setting?.enablement.key).toBe('voice.wake.enabled');
    expect(setting?.enablement.kind).toBe('boolean');
    expect(setting?.domain).toBe('voice');
    expect(setting?.defaultEnabled).toBe(false);
    // Runtime-toggleable, so no restart is demanded of the user.
    expect(setting?.restartRequired).toBe(false);
    const association = getFeatureFlagConfig('wake-word-detection');
    expect(association.configCategories).toContain('voice');
    expect(association.configKeys).toContain('voice.wake.threshold');
    expect(association.configKeys).toContain('voice.wake.silenceFloorRms');
    expect(association.configKeys).toContain('voice.wake.speechRetriggerMs');
    expect(association.configKeys.length).toBe(26);
  });
});

describe('the feature is wired up, and the mechanism that said otherwise is retired', () => {
  // The failure this block used to guard against — a settings row that looks
  // like a working switch, flips cleanly, and silently does nothing — is fixed
  // rather than declared, so the assertions are inverted: the gate now follows
  // the user's setting, and the copy describes what happens on each surface.
  test('nothing declares this feature inoperable any more', () => {
    expect(featureInoperability('wake-word-detection')).toBeNull();
    const flag = FEATURE_FLAGS.find((entry) => entry.id === 'wake-word-detection');
    expect(flag?.notOperable).toBeUndefined();
  });

  test('the gate follows the setting, on and off', () => {
    expect(isFeatureGateEnabled({ isEnabled: () => true }, 'wake-word-detection')).toBe(true);
    expect(isFeatureGateEnabled({ isEnabled: () => false }, 'wake-word-detection')).toBe(false);
    // With no manager wired the gate is permissive, as it is for every other
    // feature that has no inoperability declared.
    expect(isFeatureGateEnabled(null, 'wake-word-detection')).toBe(true);
    expect(isFeatureGateEnabled(null, 'hitl-ux-modes')).toBe(true);
  });

  test('requireFeatureGate now points at the setting instead of a build limitation', () => {
    expect(() => requireFeatureGate({ isEnabled: () => true }, 'wake-word-detection', 'start listening')).not.toThrow();
    let message = '';
    try {
      requireFeatureGate({ isEnabled: () => false }, 'wake-word-detection', 'start listening');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('is turned off');
    expect(message).toContain('voice.wake.enabled');
    expect(message).not.toContain('not available in this build');
  });

  test('turning the setting on now derives an ENABLED gate state', () => {
    const binding = FEATURE_SETTINGS_BINDINGS.find((entry) => entry.featureId === 'wake-word-detection');
    expect(binding).toBeDefined();
    expect(deriveFeatureState(binding!, true)).toBe('enabled');
    expect(deriveFeatureState(binding!, false)).toBe('disabled');
  });

  test('the settings surface reports it operable, with no reason to render instead of a switch', () => {
    const setting = FEATURE_SETTINGS.find((entry) => entry.id === 'wake-word-detection');
    expect(setting?.operable).toBe(true);
    expect(setting?.inoperableDetail).toBeNull();
  });

  test('the enablement row leads with what it does, not with a warning that it does not', () => {
    const row = voiceWakeConfigSettings.find((entry) => entry.key === 'voice.wake.enabled');
    expect(row?.description.startsWith('Run the wake-word detector')).toBe(true);
    expect(row?.description).toContain('releases the device');
    // And it says WHERE it listens, because that differs per surface.
    expect(row?.description).toContain('voice.wake.surfaces');
  });
});

describe('the detector supervisor', () => {
  test('restarts with linear backoff up to the ceiling, then latches', () => {
    const supervisor = new WakeSupervisor();
    supervisor.noteStarted();
    const first = supervisor.noteCrashed(1000);
    expect(first).toEqual({ kind: 'restart', delayMs: 2000, attempt: 1 });
    expect(supervisor.noteCrashed(2000)).toEqual({ kind: 'restart', delayMs: 4000, attempt: 2 });
    expect(supervisor.noteCrashed(3000)).toEqual({ kind: 'restart', delayMs: 6000, attempt: 3 });
    // The fourth crash inside the window is one too many.
    const latched = supervisor.noteCrashed(4000);
    expect(latched.kind).toBe('latched');
    if (latched.kind === 'latched') {
      expect(latched.crashes).toBe(4);
      // The reason is written for a user to read, not only for a log line.
      expect(latched.reason).toContain('crashed 4 times within 60s');
    }
    expect(supervisor.latched).toBe(true);
  });

  test('the latch is sticky until it is explicitly cleared', () => {
    const supervisor = new WakeSupervisor({ maxRestarts: 1 });
    supervisor.noteCrashed(0);
    expect(supervisor.noteCrashed(100).kind).toBe('latched');
    // Even much later, a latched supervisor stays latched.
    expect(supervisor.noteCrashed(10_000_000).kind).toBe('latched');
    supervisor.clearLatch();
    expect(supervisor.latched).toBe(false);
    expect(supervisor.noteCrashed(10_000_100).kind).toBe('restart');
  });

  test('crashes older than the window are forgotten', () => {
    const supervisor = new WakeSupervisor({ maxRestarts: 2, crashWindowSeconds: 60 });
    expect(supervisor.noteCrashed(0).kind).toBe('restart');
    expect(supervisor.noteCrashed(1000).kind).toBe('restart');
    // A process that then ran for five minutes gets its full budget back.
    const later = 5 * 60_000;
    expect(supervisor.noteCrashed(later).kind).toBe('restart');
    expect(supervisor.state(later).recentCrashes).toBe(1);
  });

  test('a deliberate stop is not a crash and consumes no budget', () => {
    const supervisor = new WakeSupervisor({ maxRestarts: 1 });
    supervisor.noteStarted();
    supervisor.noteStopped();
    supervisor.noteStopped();
    const state = supervisor.state(1000);
    expect(state.running).toBe(false);
    expect(state.recentCrashes).toBe(0);
    expect(state.totalCrashes).toBe(0);
    expect(supervisor.noteCrashed(1000).kind).toBe('restart');
  });

  test('maxRestarts of 0 makes any crash terminal', () => {
    const supervisor = new WakeSupervisor({ maxRestarts: 0 });
    const decision = supervisor.noteCrashed(0);
    expect(decision.kind).toBe('latched');
  });

  test('a restart-storm start does not reset its own budget', () => {
    // A process that starts and dies instantly would otherwise loop forever.
    const supervisor = new WakeSupervisor({ maxRestarts: 2 });
    for (let i = 0; i < 2; i += 1) {
      supervisor.noteStarted();
      expect(supervisor.noteCrashed(i * 10).kind).toBe('restart');
    }
    supervisor.noteStarted();
    expect(supervisor.noteCrashed(30).kind).toBe('latched');
  });

  test('state reports totals for a status surface', () => {
    const supervisor = new WakeSupervisor();
    supervisor.noteStarted();
    supervisor.noteCrashed(0);
    supervisor.noteStarted();
    supervisor.noteCrashed(500);
    const state = supervisor.state(500);
    expect(state.totalCrashes).toBe(2);
    expect(state.totalRestarts).toBe(2);
    expect(state.latched).toBe(false);
    expect(state.latchReason).toBeNull();
  });

  test('rejects a policy that cannot mean anything', () => {
    expect(() => new WakeSupervisor({ maxRestarts: -1 })).toThrow(/maxRestarts/);
    expect(() => new WakeSupervisor({ crashWindowSeconds: 0 })).toThrow(/crashWindowSeconds/);
  });
});

/**
 * Reads the shipped defaults, with an override layer, so a resolver test states
 * only the row it is about.
 */
function wakeReader(overrides: Readonly<Record<string, unknown>> = {}): (key: string) => unknown {
  const wake = WAKE as unknown as Record<string, unknown>;
  return (key: string) => {
    if (key in overrides) return overrides[key];
    const leaf = key.replace('voice.wake.', '');
    if (leaf.startsWith('surfaces.')) {
      return (wake['surfaces'] as Record<string, boolean>)[leaf.slice('surfaces.'.length)];
    }
    return wake[leaf];
  };
}

describe('every row reaches the runtime — no row configures nothing', () => {
  test('the resolver reads exactly the schema rows, in both directions', () => {
    // This is the check that would have caught the shipped state this change
    // fixed: 25 rows in the schema and nothing reading any of them. A row added
    // to the schema without being read here fails; a key read here that is not a
    // real schema row fails too.
    const schemaKeys = voiceWakeConfigSettings.map((row) => row.key).sort();
    expect([...WAKE_SETTING_KEYS].sort()).toEqual(schemaKeys);
    for (const key of WAKE_SETTING_KEYS) expect(CONFIG_KEYS.has(key)).toBe(true);
  });

  test('every row it reads actually lands somewhere in the resolved settings', () => {
    // Non-default values for every row, so a row that is read but dropped on the
    // floor shows up as a resolved value that did not move.
    const resolved = resolveWakeRuntimeSettings(wakeReader({
      'voice.wake.enabled': true,
      'voice.wake.models': 'hey_goodvibes, my_own_word ,,hey_goodvibes',
      'voice.wake.threshold': 0.75,
      'voice.wake.patienceFrames': 4,
      'voice.wake.cooldownMs': 1234,
      'voice.wake.noiseSuppression': 'speex',
      'voice.wake.inputDevice': 'mymic',
      'voice.wake.captureCommand': 'arecord',
      'voice.wake.activationSound': 'custom',
      'voice.wake.activationSoundPath': '/sounds/ping.wav',
      'voice.wake.indicator': 'banner',
      'voice.wake.preRollMs': 250,
      'voice.wake.captureMaxSeconds': 7,
      'voice.wake.silenceStopMs': 900,
      'voice.wake.autoSubmit': true,
      'voice.wake.retainAudio': 'session-temp',
      'voice.wake.customModelDir': '/models/wake',
      'voice.wake.maxRestarts': 5,
      'voice.wake.restartBackoffMs': 500,
      'voice.wake.crashWindowSeconds': 120,
      'voice.wake.browserBackend': 'webgpu',
    }), 'tui', { speexAvailable: true, canRetainAudio: true, canPlayLocalFile: true });

    expect(resolved.enabled).toBe(true);
    expect(resolved.surfaceEnabled).toBe(true);
    expect(resolved.active).toBe(true);
    // The comma list is split, trimmed, de-duplicated, order preserved.
    expect(resolved.modelIds).toEqual(['hey_goodvibes', 'my_own_word']);
    expect(resolved.tuning).toEqual({ threshold: 0.75, patienceFrames: 4, cooldownMs: 1234 });
    expect(resolved.capture.noiseSuppression).toBe('speex');
    expect(resolved.capture.device).toBe('mymic');
    expect(resolved.capture.backend).toBe('arecord');
    expect(resolved.capture.frameSamples).toBe(1280);
    expect(resolved.activationSound).toEqual({ kind: 'custom', path: '/sounds/ping.wav' });
    expect(resolved.indicator).toBe('banner');
    expect(resolved.preRollMs).toBe(250);
    expect(resolved.captureMaxSeconds).toBe(7);
    expect(resolved.silenceStopMs).toBe(900);
    expect(resolved.autoSubmit).toBe(true);
    expect(resolved.retainAudio).toBe('session-temp');
    expect(resolved.customModelDir).toBe('/models/wake');
    expect(resolved.supervisor).toEqual({ maxRestarts: 5, restartBackoffMs: 500, crashWindowSeconds: 120 });
    expect(resolved.browserBackend).toBe('webgpu');
    expect(resolved.vadThreshold).toBe(0);
    expect(resolved.blockers).toEqual([]);
  });

  test('the shipped defaults resolve to the shipped behaviour: off, and off everywhere but the terminal', () => {
    for (const surface of ['tui', 'agent', 'webui'] as WakeSurface[]) {
      const resolved = resolveWakeRuntimeSettings(wakeReader(), surface);
      expect(resolved.enabled).toBe(false);
      expect(resolved.active).toBe(false);
      expect(resolved.surfaceEnabled).toBe(WAKE.surfaces[surface]);
      expect(wakeSurfaceKey(surface)).toBe(`voice.wake.surfaces.${surface}`);
    }
    expect(WAKE.surfaces.tui).toBe(true);
    expect(WAKE.surfaces.agent).toBe(false);
    expect(WAKE.surfaces.webui).toBe(false);
  });

  test('a partial config source falls back to the shipped defaults rather than to zeroes', () => {
    // A browser tab holding only part of the tree must not resolve threshold 0.
    const resolved = resolveWakeRuntimeSettings(() => undefined, 'webui');
    expect(resolved.tuning.threshold).toBe(0.9);
    expect(resolved.captureMaxSeconds).toBe(10);
    expect(resolved.supervisor.maxRestarts).toBe(3);
    expect(resolved.modelIds).toEqual([DEFAULT_WAKE_MODEL_ID]);
  });
});

describe('a row that cannot take effect says so — blocker or limitation, never silence', () => {
  test('vadThreshold above 0 BLOCKS on a surface that has not loaded the speech gate', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.vadThreshold': 0.4 }), 'tui',
    );
    expect(resolved.active).toBe(false);
    expect(resolved.blockers.map((b) => b.key)).toEqual(['voice.wake.vadThreshold']);
    expect(resolved.blockers[0]?.detail).toContain('has not loaded the speech gate');
    // And it names what the gate would do at the configured value, measured.
    expect(resolved.blockers[0]?.detail).toContain('95.3% of speech frames');
    // And 0 — the shipped default — is the value that runs.
    expect(resolveWakeRuntimeSettings(wakeReader({ 'voice.wake.enabled': true }), 'tui').active).toBe(true);
  });

  test('speex RUNS by default now that the platform carries the filter', () => {
    // The row used to refuse everywhere. The stage is a WebAssembly module in the
    // package, so on a runtime with WebAssembly — which every surface here is —
    // asking for it starts the detector with it applied.
    const running = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.noiseSuppression': 'speex' }), 'tui',
    );
    expect(running.active).toBe(true);
    expect(running.blockers).toEqual([]);
    expect(running.capture.noiseSuppression).toBe('speex');
  });

  test('a surface that does NOT apply the stage still BLOCKS, with that reason', () => {
    const blocked = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.noiseSuppression': 'speex' }),
      'tui',
      { speexAvailable: false },
    );
    expect(blocked.active).toBe(false);
    expect(blocked.blockers[0]?.key).toBe('voice.wake.noiseSuppression');
    expect(blocked.blockers[0]?.detail).toContain('does not apply the speexdsp stage');
    // And that refusal is specific to speex: "none" runs on the same surface.
    const none = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.noiseSuppression': 'none' }),
      'tui',
      { speexAvailable: false },
    );
    expect(none.active).toBe(true);
  });

  test('retaining audio in a browser tab is a LIMITATION: it keeps listening and reports it', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.surfaces.webui': true, 'voice.wake.retainAudio': 'session-temp' }),
      'webui',
    );
    expect(resolved.active).toBe(true);
    expect(resolved.retainAudio).toBe('none');
    expect(resolved.limitations.map((l) => l.key)).toContain('voice.wake.retainAudio');
  });

  test('a custom sound a browser cannot read falls back to the chime, stated', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.surfaces.webui': true, 'voice.wake.activationSound': 'custom', 'voice.wake.activationSoundPath': '/x.wav' }),
      'webui',
    );
    expect(resolved.activationSound.kind).toBe('chime');
    expect(resolved.limitations.map((l) => l.key)).toContain('voice.wake.activationSoundPath');
    expect(resolved.active).toBe(true);
  });

  test('an empty model list disables detection WITHOUT stopping the service, as its row promises', () => {
    const resolved = resolveWakeRuntimeSettings(
      wakeReader({ 'voice.wake.enabled': true, 'voice.wake.models': '  ,, ' }), 'tui',
    );
    expect(resolved.modelIds).toEqual([]);
    expect(resolved.active).toBe(true);
    expect(resolved.blockers).toEqual([]);
    expect(resolved.limitations.map((l) => l.key)).toContain('voice.wake.models');
  });
});

describe('the feature is operable now, and the copy no longer says otherwise', () => {
  test('notOperable is gone, so the gate follows the setting instead of refusing outright', () => {
    expect(featureInoperability('wake-word-detection')).toBeNull();
    expect(isFeatureGateEnabled({ isEnabled: () => true }, 'wake-word-detection')).toBe(true);
    expect(isFeatureGateEnabled({ isEnabled: () => false }, 'wake-word-detection')).toBe(false);
    expect(() => requireFeatureGate({ isEnabled: () => true }, 'wake-word-detection', 'listen')).not.toThrow();
  });

  test('no wake row still claims that turning it on does nothing', () => {
    for (const row of voiceWakeConfigSettings) {
      expect(row.description).not.toContain('NOT AVAILABLE IN THIS BUILD');
      expect(row.description).not.toContain('does nothing yet');
      expect(row.description).not.toContain('nothing is listening');
    }
    const flag = FEATURE_FLAGS.find((f) => f.id === 'wake-word-detection');
    expect(flag?.notOperable).toBeUndefined();
    expect(flag?.description).not.toContain('not available');
  });

  test('the rows that are still limited name their own limit, rather than a blanket claim', () => {
    const rowFor = (key: string) => voiceWakeConfigSettings.find((r) => r.key === key)?.description ?? '';
    // Every delivery surface captures now, and each row says how: the agent
    // through the same recorder subprocess the terminal uses.
    expect(rowFor('voice.wake.surfaces.agent')).toContain('recorder subprocess');
    expect(rowFor('voice.wake.surfaces.agent')).toContain('agent conversation input');
    // Off by default for a stated reason, not because it does not work.
    expect(rowFor('voice.wake.surfaces.agent')).toContain('not because it does not work');
    // And no row anywhere still claims a surface has nothing behind it.
    for (const row of voiceWakeConfigSettings) {
      expect(row.description).not.toContain('no capture host');
      expect(row.description).not.toContain('NO CAPTURE HOST');
    }
    // The VAD row says no model is pinned and that a non-zero value refuses.
    expect(rowFor('voice.wake.vadThreshold')).toContain('REFUSES TO START');
    // The browser cannot read a local sound path or retain audio; both say so.
    expect(rowFor('voice.wake.activationSoundPath')).toContain('browser tab cannot read a path');
    expect(rowFor('voice.wake.retainAudio')).toContain('no filesystem to retain into');
    // The terminal and browser rows describe what they now actually do.
    expect(rowFor('voice.wake.surfaces.tui')).toContain('recorder subprocess');
    expect(rowFor('voice.wake.surfaces.webui')).toContain('browser tab');
  });
});
