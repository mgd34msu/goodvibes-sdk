import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * Resolve the token store path.
 *
 * Resolution order (first match wins):
 *   1. daemonHomeDir — daemon-identity-scoped path (0.21.19+, recommended)
 *   2. basePath — workspace-scoped path (0.21.17–0.21.18 layout, legacy fallback)
 *   3. process.cwd() — absolute fallback
 *
 * Storing tokens under daemonHomeDir means workspace swaps never invalidate
 * paired companions — a token paired once works regardless of which working
 * directory the daemon is currently serving.
 */
function resolveSharedTokenPath(basePath?: string, daemonHomeDir?: string): string {
  if (daemonHomeDir) {
    return join(daemonHomeDir, 'operator-tokens.json');
  }
  const base = basePath ?? process.cwd();
  return join(base, '.goodvibes', 'operator-tokens.json');
}

/**
 * Resolve the path to the companion token file.
 *
 * Always resolves to the shared workspace-level path regardless of surface,
 * so that tokens are portable across TUI-embedded and standalone daemon postures.
 *
 * @deprecated `surface` parameter is ignored; use {@link resolveSharedTokenPath} directly.
 */
function resolveTokenPath(_surface: string, basePath?: string, daemonHomeDir?: string): string {
  return resolveSharedTokenPath(basePath, daemonHomeDir);
}

/**
 * Load the stored companion token for a surface, or generate and persist a new one.
 */
export function getOrCreateCompanionToken(
  surface: string,
  options?: { basePath?: string; daemonHomeDir?: string; regenerate?: boolean },
): CompanionPairingResult {
  const tokenPath = resolveTokenPath(surface, options?.basePath, options?.daemonHomeDir);

  if (!options?.regenerate && existsSync(tokenPath)) {
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

  mkdirSync(join(resolveTokenPath(surface, options?.basePath, options?.daemonHomeDir), '..'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(record, null, 2), 'utf-8');

  return { token: record.token, peerId: record.peerId, createdAt: record.createdAt };
}

/**
 * Regenerate the companion token for a surface, replacing any existing token.
 */
export function regenerateCompanionToken(
  surface: string,
  options?: { basePath?: string; daemonHomeDir?: string },
): CompanionPairingResult {
  return getOrCreateCompanionToken(surface, { ...options, regenerate: true });
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
