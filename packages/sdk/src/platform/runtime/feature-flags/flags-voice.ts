/**
 * Voice capability registry entries, spread into FEATURE_FLAGS by flags.ts.
 *
 * Split into its own module because flags.ts sits at the 800-line source cap
 * and a capability declaration is not something to compress to fit, the
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
      + 'Live on all three surfaces: the terminal and the agent through a recorder subprocess, the web UI '
      + 'in a browser tab. Each is opted in by its own voice.wake.surfaces.* row. '
      + 'Tuned through voice.wake.*, whose threshold, patience and cooldown rows govern how '
      + 'readily it fires, and whose supervisor rows bound how a crashing detector is retried. '
      + 'The model\'s published recall figures are measured on synthesised speech only, no human '
      + 'recording of the phrase exists, while its false-accept figures are measured on real speech.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: true,
    // `notOperable` is GONE, in the same change that wired capture up, which is
    // the rule this field carried in writing. The terminal and the agent open a
    // recorder subprocess and the browser tab opens getUserMedia; all three feed
    // the engine frames and all three hand the utterance after a wake to the same
    // speech-to-text call. What remains limited is per-ROW, not per-surface
    // (voice.wake.vadThreshold has no pinned VAD model; a browser tab has no
    // filesystem), and each of those rows says so itself.
  },
];
