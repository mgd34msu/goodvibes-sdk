import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function requireSurfaceRoot(surfaceRoot: string, source = 'surfaceRoot'): string {
  const normalized = surfaceRoot.trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') {
    throw new Error(`${source} must be a single non-empty path segment.`);
  }
  return normalized;
}

export function resolveSurfaceDirectory(baseDirectory: string, surfaceRoot: string, ...segments: string[]): string {
  return join(baseDirectory, '.goodvibes', requireSurfaceRoot(surfaceRoot), ...segments);
}

export function resolveSurfaceSharedFile(baseDirectory: string, surfaceRoot: string, extension = 'json'): string {
  return join(baseDirectory, '.goodvibes', `${requireSurfaceRoot(surfaceRoot)}.${extension}`);
}

export function resolveSharedDirectory(baseDirectory: string, ...segments: string[]): string {
  return join(baseDirectory, '.goodvibes', ...segments);
}

export function resolveScopedDirectory(
  baseDirectory: string,
  surfaceRoot: string | undefined,
  ...segments: string[]
): string {
  return surfaceRoot && surfaceRoot.trim().length > 0
    ? resolveSurfaceDirectory(baseDirectory, surfaceRoot, ...segments)
    : resolveSharedDirectory(baseDirectory, ...segments);
}

/**
 * Restrict an id to a safe single filename segment (no path traversal, no
 * separators). Shared by the legacy per-session recovery filenames in
 * session-persistence-scope.ts and the `SessionSurface.recoveryFile` helper in
 * session-surface.ts, so both produce byte-identical filenames for the same
 * session id.
 *
 * Collision resistance: character replacement alone is not injective, `a/b`
 * and `a_b` both flatten to `a_b`, so two different sessions would share one
 * snapshot file and silently overwrite each other. When (and only when)
 * sanitization actually changed the id, a short digest of the RAW id is
 * appended, which restores one-file-per-id. An id that is already a safe
 * segment is returned byte-for-byte unchanged, machine-minted session ids
 * (`randomBytes(4).toString('hex')`, see generateUserSessionId; agent ids
 * `agent-<8 hex>`) always take that path, so no existing on-disk filename
 * moves as a result of this rule.
 */
export function sanitizeSessionIdSegment(id: string, source = 'recovery session id'): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`Session persistence requires a non-empty ${source}.`);
  }
  if (safe === id) return safe;
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${safe}-${digest}`;
}
