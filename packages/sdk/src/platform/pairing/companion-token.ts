import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * What was done with an operator-token file that could not be read.
 *
 * A token store is a fleet's shared secret: every paired client authenticates
 * with the value in it. When the file was unreadable, truncated by a crash
 * mid-write, half-written, or overwritten with something that is not a token
 * record, the read fell through and MINTED A NEW TOKEN over the top of it.
 * That is a fleet-wide 401 with no record of what happened and no way back:
 * the bytes that every client was holding are gone, and nothing says so.
 *
 * So the unreadable file is moved aside first, under a `.unrecognized`
 * neighbour, and the event is reported. The rotation still happens, a daemon
 * with no readable token cannot serve, but it is now a stated one, with the
 * old file still on disk.
 */
export interface CompanionTokenQuarantine {
  /** The token store that could not be read. */
  readonly from: string;
  /** Where its bytes were moved. Empty when the move itself failed. */
  readonly to: string;
  /** Why it was not usable, in one line. */
  readonly reason: string;
}

export interface CompanionPairingResult {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
  /**
   * Present only when an unreadable token store was moved aside to mint this
   * one. A caller that surfaces anything to an operator must surface this:
   * every paired client has to pair again.
   */
  readonly quarantined?: CompanionTokenQuarantine | undefined;
}

export interface CompanionConnectionInfo {
  readonly url: string;
  readonly token: string;
  readonly username: string;
  readonly version: string;
  readonly surface: string;
  /** Bootstrap password for companion authentication (omitted if not applicable). */
  readonly password?: string | undefined;
}

export interface CompanionTokenRecord {
  readonly token: string;
  readonly peerId: string;
  readonly createdAt: number;
}

export interface CompanionTokenOptions {
  readonly daemonHomeDir: string;
  readonly regenerate?: boolean | undefined;
  /**
   * Where a quarantine is recorded for the next surface that looks, the
   * daemon's own receipt store (platform/daemon/receipts.ts). Omitted ⇒ the
   * event is logged and returned but nothing carries it to a person.
   */
  readonly receipts?: { record(text: string): unknown } | undefined;
}

export interface PruneStaleOperatorTokensOptions {
  readonly daemonHomeDir: string;
  readonly candidatePaths?: readonly string[] | undefined;
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
 * @throws {Error} when daemonHomeDir is not provided, all callers must supply it.
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

  let quarantined: CompanionTokenQuarantine | undefined;
  if (!options.regenerate && existsSync(tokenPath)) {
    const loaded = readTokenRecord(tokenPath);
    if (loaded.record) {
      return { token: loaded.record.token, peerId: loaded.record.peerId, createdAt: loaded.record.createdAt };
    }
    quarantined = quarantineTokenStore(tokenPath, loaded.reason, options.receipts);
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

  return {
    token: record.token,
    peerId: record.peerId,
    createdAt: record.createdAt,
    ...(quarantined === undefined ? {} : { quarantined }),
  };
}

/** Read the stored record, or say in one line why it is not usable. */
function readTokenRecord(tokenPath: string): { record: CompanionTokenRecord | null; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf-8');
  } catch (error) {
    return { record: null, reason: `the file could not be read (${String(error)})` };
  }
  if (!raw.trim()) {
    // The classic torn write: created or truncated, then the process died
    // before the content landed.
    return { record: null, reason: 'the file is empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, reason: 'the file is not valid JSON' };
  }
  const candidate = parsed as Partial<CompanionTokenRecord> | null;
  if (!candidate || typeof candidate !== 'object') return { record: null, reason: 'the file is not a token record' };
  if (typeof candidate.token !== 'string' || !candidate.token) return { record: null, reason: 'the record carries no token' };
  if (typeof candidate.peerId !== 'string' || !candidate.peerId) return { record: null, reason: 'the record carries no peer id' };
  return {
    record: {
      token: candidate.token,
      peerId: candidate.peerId,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    },
    reason: '',
  };
}

/** Move an unreadable token store aside, loudly. Never throws. */
function quarantineTokenStore(
  tokenPath: string,
  reason: string,
  receipts?: { record(text: string): unknown } | undefined,
): CompanionTokenQuarantine {
  let destination = '';
  try {
    destination = nextUnrecognizedPath(tokenPath);
    renameSync(tokenPath, destination);
  } catch (error) {
    destination = '';
    logger.error('The unreadable operator token store could not be moved aside; it is about to be overwritten', {
      path: tokenPath,
      reason,
      error: String(error),
    });
  }
  logger.error('The operator token store was unreadable, a new token was issued and every paired client must pair again', {
    path: tokenPath,
    reason,
    ...(destination ? { movedTo: destination } : {}),
  });
  try {
    receipts?.record(
      `the operator token store was unreadable (${reason}), a new token was issued, so every paired client must pair again`
      + (destination ? `; the old file is at ${destination}` : ''),
    );
  } catch (error) {
    logger.error('The operator token quarantine could not be recorded as a receipt', {
      path: tokenPath,
      error: String(error),
    });
  }
  return { from: tokenPath, to: destination, reason };
}

/** `<path>.unrecognized`, or the first numbered neighbour that is free. */
function nextUnrecognizedPath(tokenPath: string): string {
  const base = `${tokenPath}.unrecognized`;
  if (!existsSync(base)) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}.${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}.${Date.now()}`;
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
  username?: string | undefined;
  password?: string | undefined;
  version?: string | undefined;
  surface?: string | undefined;
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
