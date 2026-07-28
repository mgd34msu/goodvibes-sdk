/**
 * manager-bootstrap.ts — what a ConfigManager needs before it can load anything.
 *
 * Split out of manager.ts (line cap), and cohesive on its own terms: these four
 * helpers are the pre-load layer. Two of them decide the SHAPE of a config
 * object — a fresh clone of the frozen defaults, and the sanitizer that drops
 * permission-tool keys the schema no longer knows — and two decide the PATHS
 * and files a manager is constructed from. None of them touches an instance,
 * which is why they were already module-level functions and why moving them
 * changes no behaviour.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import type { GoodVibesConfig } from './schema.js';
import { DEFAULT_CONFIG } from './schema.js';

/**
 * Cloned ONCE at module load, then cloned again per manager.
 *
 * The snapshot exists so a manager that mutates its own config can never reach
 * back into the exported `DEFAULT_CONFIG` object and change what the next
 * manager in this process starts from.
 */
export const DEFAULT_CONFIG_SNAPSHOT = structuredClone(DEFAULT_CONFIG) as GoodVibesConfig;
const PERMISSION_TOOL_KEYS = new Set(Object.keys(DEFAULT_CONFIG.permissions.tools));

/** A fresh, fully-owned copy of the defaults. */
export function cloneDefaultConfig(): GoodVibesConfig {
  return structuredClone(DEFAULT_CONFIG_SNAPSHOT) as GoodVibesConfig;
}

/**
 * Drop permission-tool entries the current schema does not define.
 *
 * A settings file written by an older build can carry a tool key that no longer
 * exists; left in place it would show up in every listing and in `getAll()` as
 * a permission for a tool nothing can run.
 */
export function sanitizeConfigShape(config: GoodVibesConfig): GoodVibesConfig {
  const sanitized = structuredClone(config) as GoodVibesConfig;
  for (const key of Object.keys(sanitized.permissions.tools)) {
    if (!PERMISSION_TOOL_KEYS.has(key)) {
      delete (sanitized.permissions.tools as Record<string, unknown>)[key];
    }
  }
  return sanitized;
}

/** An absolute, resolved path, or `undefined` when the caller supplied none. */
export function requireAbsoluteOwnedPath(path: string | undefined, name: string): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`ConfigManager ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`ConfigManager ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

/** Ensure the shared ~/.goodvibes/<surface>.json exists (empty object if not). */
export function ensureSharedConfig(sharedPath: string): void {
  if (!existsSync(sharedPath)) {
    mkdirSync(dirname(sharedPath), { recursive: true });
    writeFileSync(sharedPath, '{}\n', 'utf-8');
  }
}
