/**
 * Voice capability registry entries, spread into FEATURE_FLAGS by flags.ts.
 *
 * Split into its own module because flags.ts sits at the 800-line source cap
 * and a capability declaration is not something to compress to fit — the
 * description is what a settings surface renders, so it has to say what the
 * feature does and why its default is what it is.
 *
 * Every entry here still needs its binding in feature-settings.ts and its
 * config association in flag-config-map.ts; the lockstep tests enforce both.
 */
import type { FeatureFlag } from './types.js';

export const VOICE_FEATURE_FLAGS: FeatureFlag[] = [
  {
    id: 'wake-word-detection',
    name: 'Wake-Word Detection',
    description:
      'Listens continuously on a capture device for a spoken wake phrase and hands the '
      + 'utterance that follows to speech-to-text. Detection runs the pinned "hey goodvibes" '
      + 'classifier behind a melspectrogram computed in code and Google\'s Apache-2.0 '
      + 'speech-embedding model, both on a WASM backend, so the same detector runs in a daemon '
      + 'child process and in a browser tab. '
      + 'Disabled by default because holding a microphone open must be an explicit act; enabling '
      + 'it starts a supervised capture process and shows a persistent listening indicator for as '
      + 'long as it runs. '
      + 'Tuned through voice.wake.*, whose threshold, patience and cooldown rows govern how '
      + 'readily it fires, and whose supervisor rows bound how a crashing detector is retried. '
      + 'The model\'s published recall figures are measured on synthesised speech only — no human '
      + 'recording of the phrase exists — while its false-accept figures are measured on real speech.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: true,
    // The platform half is complete and tested — front end, engine, detection
    // rules, checksum-pinned provisioning, recovery housekeeping, supervisor.
    // What does not exist yet is the per-surface half: nothing captures audio,
    // supplies an inference session, plays the chime, draws the indicator, or
    // hands a transcript anywhere. Consumers pin a published SDK version and
    // cannot compile against this one until it publishes, so the wiring lands
    // in the release after it.
    //
    // Declared rather than left implicit because the alternative already
    // shipped and reached a user: a settings switch that flips cleanly and
    // silently does nothing. REMOVE THIS FIELD in the same change that wires
    // capture and a session loader up — not before, and not separately.
    notOperable: {
      reason: 'no-runtime-wiring',
      detail:
        'Wake-word detection is not available in this build. The detector itself is complete — model, front end, '
        + 'scoring and provisioning all ship here — but no surface captures microphone audio or supplies it an '
        + 'inference runtime yet, so turning this on would do nothing. Your setting is remembered and takes effect '
        + 'in the release that adds capture; nothing is listening until then.',
    },
  },
];
