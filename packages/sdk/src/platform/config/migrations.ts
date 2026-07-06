/**
 * One-shot config migrations applied to raw on-disk JSON before it is
 * deep-merged with defaults in {@link ConfigManager.load}.
 *
 * Wave 6 removes the deprecated `danger.daemon` alias from the schema
 * (see docs/decisions/2026-07-05-daemon-by-default.md). Once the key leaves
 * `CONFIG_SCHEMA`/`ConfigKey`, a stray `danger.daemon` value in an existing
 * settings.json would otherwise be silently ignored by the deep-merge (the
 * default config's `danger` object no longer declares a `daemon` field to
 * merge onto) — which would flip a user's explicit two-year off-switch
 * (`danger.daemon = false`) back to daemon-ON the moment they upgrade. This
 * migration closes that hazard by rewriting the explicit choice onto
 * `daemon.enabled` BEFORE the merge, so the alias is honored exactly once
 * and then retired.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface DangerDaemonMigrationResult {
  /** True if the raw config carried a `danger.daemon` key that this migration touched. */
  readonly migrated: boolean;
  /** The (possibly rewritten) raw config, safe to deep-merge with defaults. */
  readonly config: Record<string, unknown>;
  /**
   * Present only when an explicit `danger.daemon = false` was rewritten onto
   * `daemon.enabled = false` — the one case that changes resolved behavior.
   * Callers can use this to report the migration honestly (e.g. a log line).
   */
  readonly rewroteDaemonEnabledFalse: boolean;
}

/**
 * Migrate a raw parsed settings object: `danger.daemon` (a deprecated alias
 * for `daemon.enabled`, removal scheduled Wave 6) is removed, and if it was
 * explicitly `false`, that choice is preserved onto `daemon.enabled = false`.
 *
 * Precedence mirrors the alias it replaces (see the removed
 * `resolveDaemonEnabled` alias branch): an explicit `danger.daemon` value
 * always wins over whatever `daemon.enabled` currently holds in the same
 * file, because the alias historically took precedence.
 *
 * Idempotent: config that has already been migrated (or never had the alias)
 * comes back unchanged — `migrated: false`, same reference.
 *
 * - `danger.daemon === false` -> `daemon.enabled = false` (rewritten), alias removed.
 * - `danger.daemon === true`  -> alias removed, no rewrite (daemon.enabled
 *   already defaults `true`; nothing to preserve).
 * - non-boolean junk under the key -> alias removed, no rewrite.
 * - absent / not an object -> unchanged.
 */
export function migrateDangerDaemonAlias(parsed: Record<string, unknown>): DangerDaemonMigrationResult {
  const danger = parsed['danger'];
  if (!isPlainObject(danger) || !('daemon' in danger)) {
    return { migrated: false, config: parsed, rewroteDaemonEnabledFalse: false };
  }

  const alias = danger['daemon'];
  const { daemon: _removedAlias, ...restDanger } = danger;
  const nextConfig: Record<string, unknown> = { ...parsed, danger: restDanger };

  if (alias === false) {
    const existingDaemon = isPlainObject(parsed['daemon']) ? parsed['daemon'] : {};
    nextConfig['daemon'] = { ...existingDaemon, enabled: false };
    return { migrated: true, config: nextConfig, rewroteDaemonEnabledFalse: true };
  }

  // alias === true, or non-boolean junk: nothing to preserve — daemon.enabled
  // already defaults true, and a non-boolean value was never a valid override.
  return { migrated: true, config: nextConfig, rewroteDaemonEnabledFalse: false };
}
