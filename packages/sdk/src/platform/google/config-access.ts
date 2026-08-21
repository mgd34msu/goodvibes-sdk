/**
 * Reading connector config without turning "not set up" into a crash.
 *
 * `ConfigManager.resolvePath()` walks the live config object and THROWS
 * `Invalid config path` for a section that does not exist. Every path this
 * connector reads is app-layer, `email.*`, `calendar.google.*`, `google.*`,
 * and none of them is in the base schema, so on a machine where nobody has run
 * setup the sections are simply absent and the very first read throws.
 *
 * That is the wrong failure. "No Google account is connected" is a normal,
 * expected state with a clear next step; an `Invalid config path` exception
 * turns it into a broken status command, a broken capability probe, and a
 * daemon route that answers 500 where it should answer "not configured". The
 * defect showed up exactly that way: handlers raised `Invalid config path` on
 * an unconfigured machine instead of reporting nothing was configured.
 *
 * `ensureGoogleConfigDefaults` seeds the sections and is the right thing to
 * call where a real `ConfigManager` is in hand, but it cannot be the only
 * defence: it is a step a caller must remember, on a code path that only fails
 * on machines where the feature was never used, which is precisely where
 * nobody is looking. So every read in this module goes through here instead,
 * and an absent section reads as absent.
 *
 * This is a read guard only. Writes still surface their errors: failing to
 * STORE a credential must be loud, because the alternative is telling someone
 * their account is connected when nothing was saved.
 */

import type { GoogleConfigPort } from './types.js';

/**
 * Read one config value, treating an unreachable path as unset.
 *
 * Returns `undefined` both when the value is genuinely absent and when reading
 * it threw, the two are the same fact to every caller here, and neither is an
 * error worth propagating.
 */
export function safeConfigGet(config: Pick<GoogleConfigPort, 'get'>, key: string): unknown {
  try {
    return config.get(key);
  } catch {
    return undefined;
  }
}

/** A trimmed non-empty string from config, or null. Never throws. */
export function safeConfigString(config: Pick<GoogleConfigPort, 'get'>, key: string): string | null {
  const value = safeConfigGet(config, key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
