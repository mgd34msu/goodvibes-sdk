import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

function pathOutsideRootError(inputPath: string): GoodVibesSdkError {
  return new GoodVibesSdkError(`Path '${inputPath}' is outside the project root`, {
    category: 'contract',
    source: 'runtime',
    recoverable: false,
    operation: 'resolveAndValidatePath',
  });
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..') && !rel.startsWith(sep));
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolves an input path against the provided project root and validates it is
 * contained within the project root. Throws if the resolved path escapes the
 * root (path traversal attempt).
 */
export function resolveAndValidatePath(inputPath: string, projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot), 'utf8');
  const resolved = resolve(root, inputPath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw pathOutsideRootError(inputPath);
  }
  const existingPath = nearestExistingPath(resolved);
  const realExistingPath = realpathSync(existingPath, 'utf8');
  if (!isInsideRoot(root, realExistingPath)) {
    throw pathOutsideRootError(inputPath);
  }
  if (existsSync(resolved)) {
    const realTargetPath = realpathSync(resolved, 'utf8');
    if (!isInsideRoot(root, realTargetPath)) {
      throw pathOutsideRootError(inputPath);
    }
  }
  return resolved;
}
