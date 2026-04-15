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
