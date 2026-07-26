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
import { deriveFeatureState, FEATURE_SETTINGS_BINDINGS } from '../packages/sdk/src/platform/runtime/feature-flags/feature-settings.js';

const WAKE = voiceWakeConfigDefaults.voice.wake;

describe('the wake-word settings rows', () => {
  test('all 25 built rows are present, and the unbuilt 26th is not', () => {
    // The design listed 26 rows. Row 26, voice.wake.wyomingServer, is the
    // Tier-B Wyoming wake-server, ruled "NOT built; needs its own explicit
    // owner go". Shipping its key would be a switch wired to nothing.
    expect(voiceWakeConfigSettings.length).toBe(25);
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
    expect(association.configKeys.length).toBe(24);
  });
});

describe('the feature is honest about not being wired up yet', () => {
  // The failure this guards against has already shipped and reached a user:
  // a settings row that looks like a working switch, flips cleanly, and
  // silently does nothing.
  test('the registry declares it inoperable, with a reason a user can read', () => {
    const inoperable = featureInoperability('wake-word-detection');
    expect(inoperable).not.toBeNull();
    expect(inoperable?.reason).toBe('no-runtime-wiring');
    expect(inoperable?.detail).toContain('not available in this build');
    // It must say what is missing and what happens to the user's setting.
    expect(inoperable?.detail).toContain('captures microphone audio');
    expect(inoperable?.detail).toContain('remembered');
  });

  test('the gate refuses it even with a manager that says enabled', () => {
    // Nothing half-wired can run: this is the enforcement, not the label.
    const sayYes = { isEnabled: () => true };
    expect(isFeatureGateEnabled(sayYes, 'wake-word-detection')).toBe(false);
    // ...and with no manager wired at all, where the gate is normally permissive.
    expect(isFeatureGateEnabled(null, 'wake-word-detection')).toBe(false);
    // A feature with no inoperability declared still behaves exactly as before.
    expect(isFeatureGateEnabled(null, 'hitl-ux-modes')).toBe(true);
  });

  test('requireFeatureGate explains it cannot work, not that it is switched off', () => {
    // Pointing a user at a settings key that will not help is worse than silence.
    let message = '';
    try {
      requireFeatureGate({ isEnabled: () => true }, 'wake-word-detection', 'start listening');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('not available in this build');
    expect(message).toContain('start listening');
    expect(message).not.toContain('is turned off');
  });

  test('turning the setting on does not derive an enabled gate state', () => {
    const binding = FEATURE_SETTINGS_BINDINGS.find((entry) => entry.featureId === 'wake-word-detection');
    expect(binding).toBeDefined();
    // The user's config value is kept — their intent survives to the release
    // that wires capture up — but the gate state stays off, so no surface
    // reading the flag manager can render this as "on" while nothing listens.
    expect(deriveFeatureState(binding!, true)).toBe('disabled');
    expect(deriveFeatureState(binding!, false)).toBe('disabled');
  });

  test('the settings surface carries the reason, so every consumer renders it', () => {
    const setting = FEATURE_SETTINGS.find((entry) => entry.id === 'wake-word-detection');
    expect(setting?.operable).toBe(false);
    expect(setting?.inoperableDetail).toContain('not available in this build');
    // Features that DO work are unaffected and stay operable.
    const working = FEATURE_SETTINGS.find((entry) => entry.id === 'hitl-ux-modes');
    expect(working?.operable).toBe(true);
    expect(working?.inoperableDetail).toBeNull();
  });

  test('the enablement setting itself warns before the user toggles it', () => {
    const row = voiceWakeConfigSettings.find((entry) => entry.key === 'voice.wake.enabled');
    // Leads with it: a user reading the row in settings sees this first.
    expect(row?.description.startsWith('NOT AVAILABLE IN THIS BUILD')).toBe(true);
    expect(row?.description).toContain('does nothing yet');
  });

  test('exactly one feature is inoperable today, and it is this one', () => {
    // A guard on the mechanism itself: if a future change marks something else
    // inoperable, that is a deliberate act someone has to come here and record.
    const inoperableIds = FEATURE_FLAGS.filter((entry) => entry.notOperable !== undefined).map((entry) => entry.id);
    expect(inoperableIds).toEqual(['wake-word-detection']);
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
