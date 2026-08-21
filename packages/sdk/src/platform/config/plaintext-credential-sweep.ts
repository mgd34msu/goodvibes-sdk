/**
 * plaintext-credential-sweep.ts, getting credentials out of config files.
 *
 * The sibling migration moves a credential that is in the wrong STORE. This one
 * handles the credential that is not in a store at all: a literal password
 * sitting in a settings JSON file, in the clear, because the path that wrote it
 * had no idea the key was a credential.
 *
 * Three routes produced these, all now closed at the write end:
 *
 *   - the settings modal, for any key missing from the secret-key set,
 *     `surfaces.email.password` and `surfaces.calendar.caldavPassword` were
 *     both missing, and both have schema descriptions reading "Stored in the
 *     daemon secret tier, never in config";
 *   - the generic `/config set <key> <value>`, which had no detection at all;
 *   - the web UI's settings editor, which wrote every value through one
 *     untyped `config.set`.
 *
 * Closing the write end leaves every value already written exactly where it is.
 * So this sweeps them: the literal moves into the encrypted store and the
 * config file keeps a `goodvibes://secrets/…` reference, which is what every
 * reader already knows how to resolve.
 *
 * ── The ordering, same as the credential migration ──────────────────────────
 *
 *   1. Read the literal out of config.
 *   2. Write it to the secret store, at whatever scope the ownership rules say.
 *   3. Read it BACK from the store and compare.
 *   4. Only then replace the config value with the reference.
 *
 * If step 3 does not match, the config value is left exactly as it was. A
 * credential that is readable in the clear still works; a credential replaced
 * by a reference that resolves to nothing does not, and that would be this
 * sweep breaking the very thing it exists to protect.
 *
 * Values never appear in a result, a log line or an error.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  isSecretBearingConfigKey,
  isSecretReferenceValue,
  SECRET_BEARING_CONFIG_PATHS,
} from './secret-bearing-config-keys.js';
import { daemonSecretKeyFor } from './daemon-secret-keys.js';
import { SWEPT_CREDENTIAL_READER_FLOOR } from './settings-reader-floor.js';
import type { SecretScope, SecretStorageMedium } from './secrets.js';

/** What happened to one config key. */
export type PlaintextSweepOutcome =
  /** The literal moved into the store and the config now holds a reference. */
  | 'moved'
  /** The store already held it; the config now holds a reference. */
  | 'already-stored'
  /** The store write, or its read-back, failed. The literal was left in place. */
  | 'left-in-place';

export interface PlaintextSweepEntry {
  readonly configKey: string;
  readonly secretKey: string;
  readonly outcome: PlaintextSweepOutcome;
  readonly detail?: string | undefined;
}

export interface PlaintextSweepReport {
  readonly entries: readonly PlaintextSweepEntry[];
  readonly moved: number;
  readonly failed: number;
  readonly noop: boolean;
}

/** The narrow config surface this needs. Structural, so it is testable. */
export interface SweepableConfig {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** The narrow secret surface this needs. */
export interface SweepableSecrets {
  set(key: string, value: string, options?: { scope?: SecretScope; medium?: SecretStorageMedium }): Promise<void>;
  getFromScope(key: string, scope: SecretScope): Promise<string | null>;
  get(key: string): Promise<string | null>;
}

/**
 * The reference a config key holds once its value lives in the store.
 *
 * The provider segment is NOT decoration. `goodvibes://secrets/<KEY>` does not
 * parse, the parser reads the first path segment as the provider name, so a
 * key there resolves to no known provider and `normalizeSecretRef` returns
 * null. Combined with the old passthrough in `resolveSecretInput`, this sweep
 * would have replaced a working plaintext password with a reference that
 * resolved to its own text, and put that text on the wire as the credential.
 *
 * The canonical form is the one channel account setup already emits
 * (channels/builtin/account-actions.ts): provider segment, then the key,
 * percent-encoded so a key containing a slash cannot invent a path segment.
 */
export function secretReferenceFor(secretKey: string): string {
  return `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}`;
}

/** Read a config value without letting a missing section throw. */
function safeRead(config: SweepableConfig, key: string): string | null {
  try {
    const value = config.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  } catch {
    // A section that does not exist means the key is not set, which is the
    // same thing as nothing to sweep.
    return null;
  }
}

async function sweepOne(
  config: SweepableConfig,
  secrets: SweepableSecrets,
  configKey: string,
): Promise<PlaintextSweepEntry | null> {
  const literal = safeRead(config, configKey);
  if (literal === null) return null;
  // Already the correct at-rest shape.
  if (isSecretReferenceValue(literal)) return null;

  const secretKey = daemonSecretKeyFor(configKey);
  const base = { configKey, secretKey } as const;

  const existing = await secrets.get(secretKey);
  if (existing !== null && existing.length > 0) {
    // The store already has a value under this name. Do NOT overwrite it with
    // the config literal: the stored one is what every reader has been
    // resolving, and the literal may be an older copy someone pasted. Point the
    // config at the store and leave the value alone.
    config.set(configKey, secretReferenceFor(secretKey));
    return { ...base, outcome: 'already-stored' };
  }

  try {
    // No scope named: the ownership rules decide, exactly as they do for any
    // other write of this credential.
    await secrets.set(secretKey, literal);
  } catch (error) {
    return { ...base, outcome: 'left-in-place', detail: summarizeError(error) };
  }

  const readBack = await secrets.get(secretKey);
  if (readBack !== literal) {
    return {
      ...base,
      outcome: 'left-in-place',
      detail: 'the secret store did not read back what was just written to it; the config value was left exactly as it was',
    };
  }

  config.set(configKey, secretReferenceFor(secretKey));
  return { ...base, outcome: 'moved' };
}

/**
 * Move every credential still sitting literally in a config file into the
 * secret store.
 *
 * Safe on every start. After the first run every declared key holds a reference
 * or nothing, and the sweep is a handful of config reads.
 */
export async function sweepPlaintextCredentials(
  config: SweepableConfig,
  secrets: SweepableSecrets,
  /** Extra keys a product knows about that the platform set does not name. */
  additionalKeys: readonly string[] = [],
  /**
   * Record the minimum reader version this rewrite requires, in the settings
   * file the rewrite landed in.
   *
   * This sweep rewrites SHARED state, `~/.goodvibes/daemon/settings.json` is
   * read by every component on the machine, and they are not all the same
   * version at the same moment. A `goodvibes://secrets/…` reference written
   * onto `calendar.google.clientSecretRef` is a form an older reader could not
   * walk, and the older reader failed on the KEY rather than reporting the
   * version gap that actually caused it. With a floor recorded, that reader
   * says the one true thing instead: the file was migrated by something newer
   * than it is.
   *
   * Injected rather than done here so the sweep keeps its narrow, testable
   * config surface and no knowledge of where the file lives.
   */
  recordReaderFloor?: ((minReaderVersion: string, setBy: string) => void) | undefined,
): Promise<PlaintextSweepReport> {
  const keys = [...new Set([...SECRET_BEARING_CONFIG_PATHS, ...additionalKeys.filter(isSecretBearingConfigKey)])];
  const entries: PlaintextSweepEntry[] = [];

  for (const configKey of keys) {
    try {
      const entry = await sweepOne(config, secrets, configKey);
      if (entry !== null) entries.push(entry);
    } catch (error) {
      entries.push({
        configKey,
        secretKey: daemonSecretKeyFor(configKey),
        outcome: 'left-in-place',
        detail: summarizeError(error),
      });
    }
  }

  const moved = entries.filter((entry) => entry.outcome === 'moved').length;
  const failed = entries.filter((entry) => entry.outcome === 'left-in-place').length;
  const rewrote = entries.filter((entry) => entry.outcome !== 'left-in-place').length;
  // A config key was replaced by a reference, so the file now needs a reader
  // that understands one. Best-effort: a floor that cannot be recorded must
  // never undo a sweep whose credentials are already safely in the store.
  if (rewrote > 0 && recordReaderFloor) {
    try {
      recordReaderFloor(SWEPT_CREDENTIAL_READER_FLOOR, 'credential-sweep');
    } catch (error) {
      logger.warn('Credential sweep: could not record the reader version this rewrite needs', {
        error: summarizeError(error),
        detail: 'the credentials were still moved; an older reader will report the key rather than the version gap',
      });
    }
  }
  if (moved > 0 || failed > 0) {
    // Disclosed, never silent. Key names and outcomes only.
    logger.info('Credential sweep: credentials stored in the clear were moved into the secret store', {
      moved,
      failed,
      keys: entries.map((entry) => `${entry.configKey}:${entry.outcome}`),
    });
  }

  return { entries, moved, failed, noop: entries.length === 0 };
}

/** A one-line, safe-to-display summary. Never contains a value. */
export function describePlaintextSweep(report: PlaintextSweepReport): string {
  if (report.noop) return 'No credentials were being stored in the clear.';
  const parts: string[] = [];
  if (report.moved > 0) parts.push(`${report.moved} moved out of config into the encrypted store`);
  const already = report.entries.filter((entry) => entry.outcome === 'already-stored').length;
  if (already > 0) parts.push(`${already} config entries now point at the copy already in the store`);
  if (report.failed > 0) parts.push(`${report.failed} could not be verified in the store and were left exactly as they were`);
  return `Credentials in config: ${parts.join('; ')}.`;
}
