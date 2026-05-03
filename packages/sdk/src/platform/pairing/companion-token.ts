import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

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

export interface CompanionTokenOptions {
  readonly daemonHomeDir: string;
  readonly regenerate?: boolean;
}

export interface PruneStaleOperatorTokensOptions {
  readonly daemonHomeDir: string;
  readonly candidatePaths?: readonly string[];
}

export interface PruneStaleOperatorTokensResult {
  readonly canonicalPath: string;
  readonly prunedPaths: readonly string[];
  readonly failedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
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
 * Operator tokens are global and daemon-home scoped.
 *
 * @throws {Error} when daemonHomeDir is not provided — all callers must supply it.
 */
function resolveSharedTokenPath(daemonHomeDir: string): string {
  return join(daemonHomeDir, 'operator-tokens.json');
}

function normalizeCompanionTokenOptions(
  first: CompanionTokenOptions | string,
  second?: CompanionTokenOptions,
): CompanionTokenOptions {
  if (typeof first === 'string') {
    if (!second) {
      throw new Error('getOrCreateCompanionToken(surface, options) requires options.daemonHomeDir');
    }
    return second;
  }
  return first;
}

/**
 * Load the stored companion token, or generate and persist a new one.
 * Token is always written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function getOrCreateCompanionToken(
  options: CompanionTokenOptions,
): CompanionPairingResult;
export function getOrCreateCompanionToken(
  surface: string,
  options: CompanionTokenOptions,
): CompanionPairingResult;
export function getOrCreateCompanionToken(
  first: CompanionTokenOptions | string,
  second?: CompanionTokenOptions,
): CompanionPairingResult {
  const options = normalizeCompanionTokenOptions(first, second);
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
  try {
    chmodSync(tokenPath, 0o600);
  } catch (error) {
    logger.warn('Companion token chmod failed after write', {
      path: tokenPath,
      error: String(error),
    });
  }

  return { token: record.token, peerId: record.peerId, createdAt: record.createdAt };
}

/**
 * Regenerate the companion token, replacing any existing token.
 * Written to <daemonHomeDir>/operator-tokens.json at mode 0600.
 */
export function regenerateCompanionToken(
  options: CompanionTokenOptions,
): CompanionPairingResult {
  return getOrCreateCompanionToken({ ...options, regenerate: true });
}

export function pruneStaleOperatorTokens(
  options: PruneStaleOperatorTokensOptions,
): PruneStaleOperatorTokensResult {
  const canonicalPath = resolve(resolveSharedTokenPath(options.daemonHomeDir));
  const prunedPaths: string[] = [];
  const failedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const seen = new Set<string>();

  for (const candidate of options.candidatePaths ?? []) {
    if (!candidate || typeof candidate !== 'string') continue;
    const candidatePath = resolve(candidate);
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    if (candidatePath === canonicalPath) {
      skippedPaths.push(candidatePath);
      continue;
    }
    if (!existsSync(candidatePath)) {
      skippedPaths.push(candidatePath);
      continue;
    }
    try {
      unlinkSync(candidatePath);
      prunedPaths.push(candidatePath);
    } catch {
      failedPaths.push(candidatePath);
    }
  }

  return {
    canonicalPath,
    prunedPaths,
    failedPaths,
    skippedPaths,
  };
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
