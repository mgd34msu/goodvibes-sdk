/**
 * profile-fallback.ts — the port `ConfigManager.get()` reads an unset key through.
 *
 * This file exists so `platform/config` gains NO import of
 * `platform/owner-profile`. The profile module opens files, watches a directory
 * and pulls in `node:fs`; the config schema and manager are reached from
 * runtime-neutral bundles and from surfaces that have no daemon at all. A port
 * declared here and an implementation injected at the composition root keeps
 * both true, exactly as `attachHookDispatcher` already does for hooks.
 *
 * ## Where the fallback applies, and where it must not
 *
 * `ConfigManager.get()` ONLY. Never `getAll()`, never a category read, never a
 * settings dump or export. `get()` is one keyed read by a consumer that needs
 * that value to do its job. A dump is a different act: it hands the whole
 * settings surface to a caller, and a fallback applied there would put
 * `commerce.shippingAddress` in front of something that never asked for it and
 * never triggered the closed-tier disclosure rule. A bulk read therefore sees
 * the raw stored value — unset — and the profile value reaches only the one
 * consumer that asked for that one key.
 *
 * ## Direction
 *
 * An explicitly configured value always wins. The profile fills a gap; it never
 * overrides a decision the operator made. The reverse direction would be the
 * drift class this whole design exists to remove, running backwards.
 */

/**
 * Reads the profile value for one config key, or `undefined` when there is
 * nothing to fill the gap with.
 *
 * Keyed by the CONFIG path (`checkin.quietHours`), not by the profile field id,
 * so the map that connects the two lives entirely in the owner-profile module
 * and the manager stays ignorant of both.
 */
export type ConfigProfileFallbackReader = (key: string) => unknown;

/**
 * Whether a resolved config value is a gap the profile may fill.
 *
 * Deliberately narrow: `undefined`, `null`, and a string that is empty or all
 * whitespace. A `false` boolean and a `0` number are real configured values and
 * are never treated as unset — the keys this serves are all strings whose
 * schema default is `''`, and widening the predicate to "falsy" would make the
 * profile silently override a boolean an operator turned off.
 *
 * A string an operator explicitly set to empty is indistinguishable from unset,
 * and that is the right answer: clearing a setting is how you say "I have no
 * opinion here", which is exactly when the profile should speak.
 */
export function isUnsetConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * The whole policy, in one place: what `ConfigManager.get()` answers for one
 * key once the stored value has been resolved.
 *
 * `stored` wins whenever it is set. With no reader installed, or with a reader
 * that has nothing for this key, `stored` is returned unchanged — so a build
 * that never installs a profile behaves byte-for-byte as it did before this
 * existed.
 *
 * Called from `get()` and from nowhere else. That is the containment rule, and
 * it is a rule about the CALLER, so it cannot be enforced from inside here —
 * which is why it is written down at the top of this file and asserted by
 * owner-profile-consumers.test.ts against `getAll()`, `getCategory()` and
 * `getRaw()` rather than left as an intention.
 */
export function resolveWithProfileFallback(
  key: string,
  stored: unknown,
  reader: ConfigProfileFallbackReader | null,
): unknown {
  if (reader === null || !isUnsetConfigValue(stored)) return stored;
  const fromProfile = reader(key);
  return fromProfile === undefined ? stored : fromProfile;
}
