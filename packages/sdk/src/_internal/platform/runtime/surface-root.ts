export function requireSurfaceRoot(surfaceRoot: string, source = 'surfaceRoot'): string {
  const normalized = surfaceRoot.trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..') {
    throw new Error(`${source} must be a single non-empty path segment.`);
  }
  return normalized;
}
