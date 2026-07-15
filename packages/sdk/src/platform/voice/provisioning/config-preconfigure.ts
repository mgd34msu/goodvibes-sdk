/**
 * config-preconfigure.ts — after provisioning, point the voice.local.* config
 * keys at the managed install so local voice works immediately — WITHOUT ever
 * overwriting a value the USER set.
 *
 * Ownership is tracked via the install stamp: the exact values a previous
 * install wrote are passed back in as `priorInstallWrites`. Provenance rules:
 *  - current value empty AND no prior install write  -> unset: installer sets it
 *  - current value equals the prior install write    -> installer-owned: update
 *    to the new managed value (a manifest layout/voice change must apply)
 *  - current value empty BUT a prior write existed   -> the user deliberately
 *    CLEARED an installer-written value: respect the disable, skip
 *  - anything else                                   -> user-set: skip
 * Every decision is reported in the receipt (set / skipped with reasons).
 */
export interface VoiceKeyPreconfig {
  readonly key: string;
  readonly value: string;
}
export interface VoiceKeySkip {
  readonly key: string;
  readonly reason: string;
}
export interface VoicePreconfigReceipt {
  readonly set: readonly VoiceKeyPreconfig[];
  readonly skipped: readonly VoiceKeySkip[];
  /** The full ownership map after this pass (persist into the install stamp). */
  readonly installWrites: Record<string, string>;
}

export interface VoicePreconfigDeps {
  readonly getConfig: (key: string) => string;
  readonly setConfig: (key: string, value: string) => void;
  readonly ttsEngine: string;
  readonly ttsBinary: string;
  readonly ttsModelPath: string;
  /** The values a previous install wrote (from the install stamp). */
  readonly priorInstallWrites?: Record<string, string> | undefined;
}

/**
 * Set the three voice.local.tts* keys to the managed install, honoring the
 * ownership rules above. Returns a receipt of what was set vs preserved plus
 * the updated ownership map for the install stamp.
 */
export function preconfigureLocalVoiceKeys(deps: VoicePreconfigDeps): VoicePreconfigReceipt {
  const set: VoiceKeyPreconfig[] = [];
  const skipped: VoiceKeySkip[] = [];
  const prior = deps.priorInstallWrites ?? {};
  const installWrites: Record<string, string> = {};
  const apply = (key: string, value: string): void => {
    const current = (deps.getConfig(key) ?? '').trim();
    const priorWrite = prior[key];
    if (current.length === 0) {
      if (priorWrite !== undefined && priorWrite.length > 0) {
        // The user cleared a value THIS installer wrote — an intentional
        // disable. Never overwrite it back.
        skipped.push({ key, reason: 'previously install-written value was cleared by the user (deliberate disable)' });
        return;
      }
      deps.setConfig(key, value);
      set.push({ key, value });
      installWrites[key] = value;
      return;
    }
    if (priorWrite !== undefined && current === priorWrite) {
      // Installer-owned: this exact value came from a previous install, so a
      // manifest change (new voice id, new layout) must update it.
      if (current !== value) {
        deps.setConfig(key, value);
        set.push({ key, value });
      } else {
        skipped.push({ key, reason: 'already at the managed value' });
      }
      installWrites[key] = value;
      return;
    }
    // Genuinely user-set — user values always win.
    skipped.push({ key, reason: `already set to a user value (${current})` });
  };
  apply('voice.local.ttsEngine', deps.ttsEngine);
  apply('voice.local.ttsBinary', deps.ttsBinary);
  apply('voice.local.ttsModelPath', deps.ttsModelPath);
  return { set, skipped, installWrites };
}
