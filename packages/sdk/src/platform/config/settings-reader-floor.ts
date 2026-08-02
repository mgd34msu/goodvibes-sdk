/**
 * settings-reader-floor.ts — the minimum reader version a settings file needs.
 *
 * ── The failure this closes ────────────────────────────────────────────────
 *
 * `~/.goodvibes/daemon/settings.json` is SHARED state. Several components read
 * it and several write it, and they are not all the same version at the same
 * moment: a machine can have a newly-installed surface next to a daemon that
 * has not been swapped yet. When the credential sweep rewrote a literal
 * password into a `goodvibes://secrets/…` reference under `calendar.google.
 * clientSecretRef`, it wrote a form the daemon of the day could not walk, and
 * that daemon failed while CONSTRUCTING its ConfigManager. What the operator
 * saw was a daemon that would not start; what had actually happened was a newer
 * component migrating shared state under an older reader.
 *
 * The symptom is never the story. A reader that is simply too old to understand
 * a file should say exactly that, instead of failing on whichever key happened
 * to be shaped in a way it could not parse.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────
 *
 * A migration that rewrites shared state records the minimum reader version its
 * rewrite requires, in a `$goodvibes` object at the top of the file:
 *
 *   { "$goodvibes": { "minReaderVersion": "1.20.0", "setBy": "credential-sweep",
 *                     "at": "2026-07-30T11:00:00.000Z" }, … }
 *
 * The key is `$`-prefixed because no config domain is: `$goodvibes` can never
 * collide with a settings section, and it is stripped before the merge so it
 * never becomes a config value.
 *
 * A reader compares its own version against the floor BEFORE it tries to ingest
 * anything. Older than the floor, it refuses with the version sentence. At or
 * above the floor, the marker is removed and reading proceeds normally.
 *
 * Deliberately NOT a version-negotiation framework. There is one number, it
 * only ever goes up, and it is compared once per file.
 */

/** Top-level key holding the reader-floor marker. `$`-prefixed: no domain is. */
export const SETTINGS_FLOOR_MARKER_KEY = '$goodvibes';

/** What a migration recorded about the rewrite it just made. */
export interface SettingsReaderFloor {
  /** Lowest reader version that can ingest this file, as `major.minor.patch`. */
  readonly minReaderVersion: string;
  /** Which migration raised the floor, so a refusal can name a cause. */
  readonly setBy: string;
  /** ISO timestamp of the rewrite. */
  readonly at: string;
}

/**
 * The floor for a settings file the credential sweep has rewritten.
 *
 * 1.20.0 is the first release whose settings reader walks a `…Ref` key under an
 * app-layer section (`calendar.*`, `email.*`, `google.*`) without failing
 * ConfigManager construction. A reader older than that cannot ingest what the
 * sweep writes, which is precisely the state this floor exists to announce.
 */
export const SWEPT_CREDENTIAL_READER_FLOOR = '1.20.0';

/**
 * The floor for a settings file whose payments budget amounts have been renamed.
 *
 * 2.0.5 is the first release whose reader knows `payments.budget.dailyItem`,
 * `dailyOverage`, `perPurchaseCeiling` and `overageToleranceDailyAllowance`.
 * An older reader knows only the `…Cents` names, so once the rename is on disk
 * it finds four keys it cannot place and skips them — and a skipped spending
 * limit is a limit that stops being enforced.
 *
 * That is not a hypothetical: a client on this runtime renamed the keys under a
 * running 1.28.6 daemon, which then said "payments.budget.perPurchaseCeiling is
 * not a setting this build knows" and stopped resolving a configured ceiling.
 * Ownership now stops the client from writing at all; this floor covers the
 * remaining half, where the DAEMON is the newer component. With it recorded,
 * an older reader of the migrated file names the version and says to update,
 * instead of reporting four unrelated keys it does not recognize.
 */
export const PAYMENTS_BUDGET_AMOUNTS_READER_FLOOR = '2.0.5';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `major.minor.patch` as three numbers; anything unparseable reads as 0.0.0. */
function versionParts(version: string): readonly [number, number, number] {
  const core = version.trim().split(/[-+]/)[0] ?? '';
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  return [
    Number.isFinite(parts[0]) ? (parts[0] as number) : 0,
    Number.isFinite(parts[1]) ? (parts[1] as number) : 0,
    Number.isFinite(parts[2]) ? (parts[2] as number) : 0,
  ];
}

/**
 * Compare two `major.minor.patch` versions: negative when `a` is older.
 *
 * Prerelease and build metadata are ignored — a floor is a release-line
 * statement, and `1.21.0-rc.1` is treated as 1.21.0 rather than refused for
 * being unparseable. Ignoring a suffix can only ever make a reader MORE
 * willing to read a file, never less, which is the safe direction for a check
 * whose failure mode is refusing to start.
 */
export function compareReaderVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] as number) - (right[index] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The floor a settings object declares, or null when it declares none. */
export function readSettingsReaderFloor(raw: unknown): SettingsReaderFloor | null {
  if (!isPlainObject(raw)) return null;
  const marker = raw[SETTINGS_FLOOR_MARKER_KEY];
  if (!isPlainObject(marker)) return null;
  const minReaderVersion = marker['minReaderVersion'];
  if (typeof minReaderVersion !== 'string' || minReaderVersion.trim().length === 0) return null;
  const setBy = typeof marker['setBy'] === 'string' ? marker['setBy'] : 'an unnamed migration';
  const at = typeof marker['at'] === 'string' ? marker['at'] : '';
  return { minReaderVersion: minReaderVersion.trim(), setBy, at };
}

/**
 * Remove the marker so it never reaches the merged config.
 *
 * Mutates in place and returns the same object: the callers already own the
 * parsed result and copying a settings tree per file for one deleted key is
 * waste.
 */
export function stripSettingsReaderFloor(raw: Record<string, unknown>): Record<string, unknown> {
  delete raw[SETTINGS_FLOOR_MARKER_KEY];
  return raw;
}

/** True when a reader at `readerVersion` is too old for `floor`. */
export function readerIsBelowFloor(readerVersion: string, floor: SettingsReaderFloor): boolean {
  return compareReaderVersions(readerVersion, floor.minReaderVersion) < 0;
}

/**
 * The sentence an under-floor reader says. Names the file, both versions, and
 * the one action that fixes it — never the key it happened to trip over,
 * because the key is the symptom and the version is the cause.
 */
export function describeFloorRefusal(
  file: string,
  floor: SettingsReaderFloor,
  readerVersion: string,
): string {
  const when = floor.at ? ` on ${floor.at}` : '';
  return (
    `${file} was migrated by a newer component (${floor.setBy}${when}); ` +
    `this daemon (${readerVersion}) is older than the floor (${floor.minReaderVersion}) — update it`
  );
}

/**
 * Raise a settings file's recorded floor, merging with whatever else is stored.
 *
 * Never LOWERS a floor: two migrations can rewrite the same file, and the
 * highest requirement is the one that governs. Never creates a file that does
 * not exist — a floor describes a rewrite that happened, so there is nothing to
 * record where nothing was written.
 */
export function raiseSettingsReaderFloor(
  raw: Record<string, unknown>,
  minReaderVersion: string,
  setBy: string,
  now: () => Date = () => new Date(),
): { readonly raw: Record<string, unknown>; readonly raised: boolean } {
  const existing = readSettingsReaderFloor(raw);
  if (existing && compareReaderVersions(existing.minReaderVersion, minReaderVersion) >= 0) {
    return { raw, raised: false };
  }
  raw[SETTINGS_FLOOR_MARKER_KEY] = {
    minReaderVersion,
    setBy,
    at: now().toISOString(),
  } satisfies SettingsReaderFloor;
  return { raw, raised: true };
}
