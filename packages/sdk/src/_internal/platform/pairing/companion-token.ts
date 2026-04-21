import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface CompanionPairingResult {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
}

export interface CompanionConnectionInfo {
  readonly url: string;
  readonly token: string;
  readonly username: string;
  readonly version: string;
  readonly surface: string;
  /** Bootstrap password for companion authentication (omitted if not applicable). */
  readonly password?: string;
}

export interface CompanionTokenRecord {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
}

const TOKEN_PREFIX = 'gv_';

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

function generatePeerId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * Resolve the operator token store path.
 *
 * The only valid location is <daemonHomeDir>/operator-tokens.json.
 * Operator tokens are global (daemon-home scoped) since 0.21.28.
 * No workspace-scoped fallback exists.
 *
 * @throws {Error} when daemonHomeDir is not provided — all callers must supply it.
 */
function resolveSharedTokenPath(daemonHomeDir: string): string {
  return join(daemonHomeDir, 'operator-tokens.json');
}

/**
 * Load the stored companion token, or generate and persist a new one.
 * Token is always written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function getOrCreateCompanionToken(
  surface: string,
  options: { daemonHomeDir: string; regenerate?: boolean },
): CompanionPairingResult {
  void surface; // surface parameter retained for API compatibility; token path is global
  const tokenPath = resolveSharedTokenPath(options.daemonHomeDir);

  if (!options.regenerate && existsSync(tokenPath)) {
    try {
      const raw = readFileSync(tokenPath, 'utf-8');
      const record = JSON.parse(raw) as CompanionTokenRecord;
      if (typeof record.token === 'string' && typeof record.peerId === 'string') {
        return { token: record.token, peerId: record.peerId, createdAt: record.createdAt };
      }
    } catch {
      // Fall through to regenerate
    }
  }

  const record: CompanionTokenRecord = {
    token: generateTokenValue(),
    peerId: generatePeerId(),
    createdAt: Date.now(),
  };

  const dir = dirname(tokenPath);
  mkdirSync(dir, { recursive: true });
  // Write with mode 0600 (owner read/write only) and enforce after write
  writeFileSync(tokenPath, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }

  return { token: record.token, peerId: record.peerId, createdAt: record.createdAt };
}

/**
 * Regenerate the companion token, replacing any existing token.
 * Written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function regenerateCompanionToken(
  surface: string,
  options: { daemonHomeDir: string },
): CompanionPairingResult {
  return getOrCreateCompanionToken(surface, { ...options, regenerate: true });
}

/**
 * Result of a `pruneStaleOperatorTokens` invocation.
 */
export interface PruneStaleOperatorTokensResult {
  /** Absolute path of the canonical operator-tokens.json at <daemonHomeDir>. */
  readonly canonicalPath: string;
  /**
   * Token value read from the canonical path, or `null` when the canonical file does
   * not exist yet. Pruning is skipped in the `null` case to avoid orphaning a user
   * mid-setup; callers should ensure `getOrCreateCompanionToken` ran first.
   */
  readonly canonicalToken: string | null;
  /** Candidate paths that existed and were removed because their token did not match the canonical token. */
  readonly prunedPaths: readonly string[];
  /** Candidate paths that existed and were left alone because their token matched the canonical one. */
  readonly matchedPaths: readonly string[];
  /** Candidate paths that did not exist on disk. */
  readonly absentPaths: readonly string[];
  /** Candidate paths that existed and did not match but could not be removed (e.g. EACCES, EBUSY). Best-effort cleanup — callers may want to log these. */
  readonly failedPaths: readonly string[];
}

/**
 * F3 resolution (SDK 0.21.36): prune stale `operator-tokens.json` files at legacy workspace
 * locations so every candidate on disk either matches the live daemon token or is removed.
 *
 * The canonical token lives at `<daemonHomeDir>/operator-tokens.json` (global, 0600). Prior to
 * SDK 0.21.28 operator tokens could be written into workspace-scoped `.goodvibes/` directories;
 * when the canonical store was later regenerated those workspace files became stale but were
 * never cleaned up, producing 401s and inconsistent pairing experiences across UAT runs.
 *
 * This helper is idempotent and safe to call on every daemon startup. It never modifies the
 * canonical file (use `getOrCreateCompanionToken` / `regenerateCompanionToken` for that) — it
 * only removes candidate paths that do not match the canonical token.
 *
 * @param options.daemonHomeDir - Canonical daemon-home directory.
 * @param options.candidatePaths - Absolute paths of legacy `operator-tokens.json` files to inspect.
 *   Non-absolute paths and paths equal to the canonical location are ignored defensively.
 */
export function pruneStaleOperatorTokens(options: {
  daemonHomeDir: string;
  candidatePaths: readonly string[];
}): PruneStaleOperatorTokensResult {
  const canonicalPath = resolveSharedTokenPath(options.daemonHomeDir);
  const canonicalToken = readTokenFromPath(canonicalPath);
  if (canonicalToken === null) {
    // No canonical token yet — nothing to compare against. Skip pruning so we never
    // orphan a user mid-setup. `getOrCreateCompanionToken` should have been called first.
    return {
      canonicalPath,
      canonicalToken: null,
      prunedPaths: [],
      matchedPaths: [],
      absentPaths: [...options.candidatePaths],
      failedPaths: [],
    };
  }

  const pruned: string[] = [];
  const matched: string[] = [];
  const absent: string[] = [];
  const failed: string[] = [];

  for (const candidate of options.candidatePaths) {
    if (!candidate || candidate === canonicalPath) {
      // Defensive: skip empty strings and any candidate that is the canonical path itself.
      continue;
    }
    if (!existsSync(candidate)) {
      absent.push(candidate);
      continue;
    }
    const candidateToken = readTokenFromPath(candidate);
    if (candidateToken === canonicalToken) {
      matched.push(candidate);
      continue;
    }
    // Token present but does not match canonical — prune it.
    try {
      unlinkSync(candidate);
      pruned.push(candidate);
    } catch {
      // Best-effort: if unlink fails (permission, race), record it for the caller to log.
      failed.push(candidate);
    }
  }

  return {
    canonicalPath,
    canonicalToken,
    prunedPaths: pruned,
    matchedPaths: matched,
    absentPaths: absent,
    failedPaths: failed,
  };
}

function readTokenFromPath(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const record = JSON.parse(raw) as Partial<CompanionTokenRecord>;
    return typeof record.token === 'string' ? record.token : null;
  } catch {
    return null;
  }
}

/**
 * Build a CompanionConnectionInfo object from raw parameters.
 */
export function buildCompanionConnectionInfo(options: {
  daemonUrl: string;
  token: string;
  username?: string;
  password?: string;
  version?: string;
  surface?: string;
}): CompanionConnectionInfo {
  return {
    url: options.daemonUrl,
    token: options.token,
    username: options.username ?? 'admin',
    ...(options.password !== undefined ? { password: options.password } : {}),
    version: options.version ?? '0.0.0',
    surface: options.surface ?? 'daemon',
  };
}

/**
 * Encode a CompanionConnectionInfo as a JSON string suitable for QR encoding.
 */
export function encodeConnectionPayload(info: CompanionConnectionInfo): string {
  return JSON.stringify({
    url: info.url,
    token: info.token,
    username: info.username,
    ...(info.password !== undefined ? { password: info.password } : {}),
    version: info.version,
    surface: info.surface,
  });
}
