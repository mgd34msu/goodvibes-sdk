/**
 * config-preconfigure.ts — after provisioning, point the voice.local.* config
 * keys at the managed install so local voice works immediately.
 *
 * Ownership is tracked via the install stamp: the exact values a previous
 * install wrote are passed back in as `priorInstallWrites`. Provenance rules:
 *  - current value empty AND no prior install write  -> unset: installer sets it
 *  - current value equals the prior install write    -> installer-owned: update
 *    to the new managed value (a manifest layout/voice change must apply)
 *  - current value empty BUT a prior write existed   -> the user deliberately
 *    CLEARED an installer-written value: respect the disable, skip
 *  - a path pointing at some OTHER install           -> SUPERSEDED (see below)
 *  - anything else                                   -> user-set: skip
 * Every decision is reported in the receipt (set / superseded / skipped).
 *
 * A MANAGED INSTALL SUPERSEDES A MANUAL ONE.
 *
 * "Never overwrite a user value" was the wrong rule for a PATH. Running the
 * managed installer is itself the user's act, and its whole promise is that
 * voice works afterwards. On the owner's machine the installer downloaded and
 * verified a complete managed runtime, then skipped every config key because
 * they still pointed at a hand-built install under ~/.local/opt — so setup
 * reported "provisioned" while the product went on using an install the new one
 * had just replaced. Nothing said so.
 *
 * So a path key that names a location OUTSIDE the managed root is repointed at
 * the managed runtime, and the receipt names the exact path that was replaced.
 * Superseding loudly beats a green message over a stale install. Non-path keys
 * (the engine enums) follow the path they belong to, so an engine and its
 * binary can never be left describing two different installs.
 */
export interface VoiceKeyPreconfig {
  readonly key: string;
  readonly value: string;
}
export interface VoiceKeySkip {
  readonly key: string;
  readonly reason: string;
}
/** A key repointed from a different install at the managed one. */
export interface VoiceKeySupersede {
  readonly key: string;
  /** What the key pointed at before — named so the change is auditable. */
  readonly previousValue: string;
  readonly value: string;
}
export interface VoicePreconfigReceipt {
  readonly set: readonly VoiceKeyPreconfig[];
  readonly skipped: readonly VoiceKeySkip[];
  /** Keys taken over from an install this one replaces. */
  readonly superseded: readonly VoiceKeySupersede[];
  /** The full ownership map after this pass (persist into the install stamp). */
  readonly installWrites: Record<string, string>;
}

export interface VoicePreconfigDeps {
  readonly getConfig: (key: string) => string;
  readonly setConfig: (key: string, value: string) => void;
  readonly ttsEngine: string;
  readonly ttsBinary: string;
  readonly ttsModelPath: string;
  /** STT values, present only when STT provisioned (same ownership rules). */
  readonly sttEngine?: string | undefined;
  readonly sttBinary?: string | undefined;
  readonly sttModelPath?: string | undefined;
  /** The values a previous install wrote (from the install stamp). */
  readonly priorInstallWrites?: Record<string, string> | undefined;
  /**
   * The managed voice root. A path key already inside it is this installer's
   * own; one outside it belongs to another install and is superseded.
   *
   * Omitted, NOTHING is superseded: without a root there is no way to tell this
   * install's paths from a user's, and treating every configured path as
   * foreign would repoint all of them. A caller that wants the supersede rule
   * has to say where its install lives.
   */
  readonly managedRoot?: string | undefined;
}

/**
 * Set the three voice.local.tts* keys to the managed install, honoring the
 * ownership rules above. Returns a receipt of what was set vs preserved plus
 * the updated ownership map for the install stamp.
 */
export function preconfigureLocalVoiceKeys(deps: VoicePreconfigDeps): VoicePreconfigReceipt {
  const set: VoiceKeyPreconfig[] = [];
  const skipped: VoiceKeySkip[] = [];
  const superseded: VoiceKeySupersede[] = [];
  const prior = deps.priorInstallWrites ?? {};
  const installWrites: Record<string, string> = {};
  const managedRoot = deps.managedRoot?.trim();

  /**
   * Whether this call can tell its OWN install from anyone else's.
   *
   * Superseding means "that path belongs to an install this one replaces", and
   * that judgement is only possible against a known managed root. Without one,
   * every configured path looks foreign — which would supersede the lot, the
   * exact opposite of the careful rule. So no root means no superseding.
   */
  const canSupersede = managedRoot !== undefined && managedRoot.length > 0;

  /**
   * A path already inside the managed root belongs to this installer.
   *
   * Compared on a path BOUNDARY, not as a bare string prefix: a managed root of
   * `/m` is not a prefix of `/my/whisper`, and `/opt/voice` is not a prefix of
   * `/opt/voice-old`. Getting that wrong silently classifies someone else's
   * install as ours and declines to supersede it — the exact failure this rule
   * exists to end, hidden behind a `startsWith`.
   */
  const insideManagedRoot = (value: string): boolean => {
    if (!canSupersede) return false;
    const root = (managedRoot as string).replace(/\/+$/, '');
    return value === root || value.startsWith(`${root}/`);
  };

  const apply = (key: string, value: string, kind: 'path' | 'engine', supersedeGroup: boolean): void => {
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
    if (current === value) {
      // Already pointing at exactly what this install provides, whoever set it.
      skipped.push({ key, reason: 'already at the managed value' });
      installWrites[key] = value;
      return;
    }
    // A path naming another install: the managed runtime replaces it, and the
    // receipt says which path it replaced. An engine row moves with the path it
    // belongs to, so the pair can never describe two different installs.
    const isForeignPath = kind === 'path' && !insideManagedRoot(current);
    if (supersedeGroup && (isForeignPath || kind === 'engine')) {
      deps.setConfig(key, value);
      superseded.push({ key, previousValue: current, value });
      installWrites[key] = value;
      return;
    }
    skipped.push({ key, reason: `already set to a user value (${current})` });
  };

  /**
   * Decide ONCE per engine family whether this install supersedes what is
   * configured, then apply that decision to the engine row and both paths
   * together. Deciding per key is how an engine could end up naming piper while
   * the binary named a whisper wrapper.
   */
  const applyFamily = (
    prefix: 'tts' | 'stt',
    engine: string,
    binary: string,
    modelPath: string,
  ): void => {
    const engineKey = `voice.local.${prefix}Engine`;
    const binaryKey = `voice.local.${prefix}Binary`;
    const modelKey = `voice.local.${prefix}ModelPath`;
    const currentBinary = (deps.getConfig(binaryKey) ?? '').trim();
    const currentModel = (deps.getConfig(modelKey) ?? '').trim();
    // Supersede when a configured path names an install that is not this one
    // and was not written by a previous run of this installer.
    const foreign = (key: string, current: string): boolean =>
      canSupersede
      && current.length > 0
      && current !== prior[key]
      && !insideManagedRoot(current);
    const supersedes = foreign(binaryKey, currentBinary) || foreign(modelKey, currentModel);
    apply(engineKey, engine, 'engine', supersedes);
    apply(binaryKey, binary, 'path', supersedes);
    apply(modelKey, modelPath, 'path', supersedes);
  };

  applyFamily('tts', deps.ttsEngine, deps.ttsBinary, deps.ttsModelPath);
  if (deps.sttEngine && deps.sttBinary && deps.sttModelPath) {
    applyFamily('stt', deps.sttEngine, deps.sttBinary, deps.sttModelPath);
  }
  return { set, skipped, superseded, installWrites };
}

/** Plain-language lines naming each install this run replaced, for the reply. */
export function describeSupersededVoiceKeys(receipt: VoicePreconfigReceipt): readonly string[] {
  return receipt.superseded.map((entry) =>
    `${entry.key} pointed at ${entry.previousValue}, which this managed runtime replaces; it now points at ${entry.value}.`);
}
