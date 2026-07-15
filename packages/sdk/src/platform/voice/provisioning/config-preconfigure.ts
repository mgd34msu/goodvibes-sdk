/**
 * config-preconfigure.ts — after provisioning, point the voice.local.* config
 * keys at the managed install so local voice works immediately — WITHOUT ever
 * overwriting a key the user already set to a custom value. User-set values win;
 * skipped keys are recorded in the receipt.
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
}

export interface VoicePreconfigDeps {
  readonly getConfig: (key: string) => string;
  readonly setConfig: (key: string, value: string) => void;
  readonly ttsEngine: string;
  readonly ttsBinary: string;
  readonly ttsModelPath: string;
}

/**
 * Set the three voice.local.tts* keys to the managed install, skipping any the
 * user already configured. Returns a receipt of what was set vs preserved.
 */
export function preconfigureLocalVoiceKeys(deps: VoicePreconfigDeps): VoicePreconfigReceipt {
  const set: VoiceKeyPreconfig[] = [];
  const skipped: VoiceKeySkip[] = [];
  const apply = (key: string, value: string): void => {
    const current = (deps.getConfig(key) ?? '').trim();
    if (current.length > 0) {
      skipped.push({ key, reason: `already set to a user value (${current})` });
      return;
    }
    deps.setConfig(key, value);
    set.push({ key, value });
  };
  apply('voice.local.ttsEngine', deps.ttsEngine);
  apply('voice.local.ttsBinary', deps.ttsBinary);
  apply('voice.local.ttsModelPath', deps.ttsModelPath);
  return { set, skipped };
}
