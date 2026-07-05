/**
 * daemon-version-compat.ts
 *
 * The adopt-or-start path (bootstrap-services.ts) verifies that a daemon found
 * on the configured port is a GoodVibes daemon via its `/status` identity probe,
 * which reports the daemon's SDK `version`. Verifying identity is NOT the same as
 * verifying that the daemon speaks the SAME wire shape this surface expects:
 * adopting a daemon built from an incompatible SDK band produces silent
 * wire-shape failures (a session method the surface calls that the daemon does
 * not serve, a payload field that moved). This module answers the one question
 * the probe leaves open — "may this surface safely adopt a daemon reporting
 * version X?" — so the adopt path can refuse an incompatible occupant honestly
 * instead of adopting it and failing later, and without ever starting a second
 * competing daemon on an occupied port.
 *
 * Compatibility band policy (semver, https://semver.org/#spec-item-4):
 *   - `0.y.z` releases treat the MINOR position as the breaking axis, so two
 *     `0.y` versions are compatible only when `y` matches (0.38.x adopts 0.38.*
 *     but not 0.37.*).
 *   - `>=1.0.0` releases treat MAJOR as the breaking axis, so major must match
 *     (1.4.x adopts any 1.*.* but not 2.*.*).
 *   - A version string that cannot be parsed is treated as INCOMPATIBLE — the
 *     conservative, honest default. An empty/absent remote version is likewise
 *     incompatible: the surface must not adopt something it cannot band-check.
 * Prerelease and build metadata (`-rc.1`, `+sha`) are ignored for banding.
 */

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Parse the leading `major.minor` of a semver string, ignoring patch,
 * prerelease, and build metadata. Returns null when the leading two numeric
 * positions cannot be read.
 */
function parseVersionBand(version: string | undefined | null): ParsedVersion | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  // Strip a leading `v`, then take the core before any `-` (prerelease) or `+` (build).
  const core = trimmed.replace(/^v/i, '').split(/[-+]/, 1)[0] ?? '';
  const parts = core.split('.');
  if (parts.length < 2) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) return null;
  return { major, minor };
}

/**
 * True when a surface reporting `localVersion` may safely adopt a daemon
 * reporting `remoteVersion` — see the band policy in the file header.
 * Unparseable or absent versions are never compatible.
 */
export function isDaemonVersionCompatible(
  localVersion: string | undefined | null,
  remoteVersion: string | undefined | null,
): boolean {
  const local = parseVersionBand(localVersion);
  const remote = parseVersionBand(remoteVersion);
  if (local === null || remote === null) return false;
  if (local.major !== remote.major) return false;
  // For the 0.y band the minor position is the breaking axis; for >=1 it is not.
  if (local.major === 0) return local.minor === remote.minor;
  return true;
}

/**
 * Human-readable reason string for an incompatible adoption refusal, naming
 * both the occupied endpoint's version and this surface's version so the
 * operator can see the skew without guessing.
 */
export function describeVersionIncompatibility(
  host: string,
  port: number,
  localVersion: string | undefined | null,
  remoteVersion: string | undefined | null,
): string {
  const found = (typeof remoteVersion === 'string' && remoteVersion.trim()) ? remoteVersion.trim() : 'unknown';
  const mine = (typeof localVersion === 'string' && localVersion.trim()) ? localVersion.trim() : 'unknown';
  return `A GoodVibes daemon (version ${found}) is running on ${host}:${port}, but this surface (version ${mine}) speaks an incompatible wire version — not adopting, and not starting a second daemon on the occupied port.`;
}
