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
