/**
 * settings-io.ts — raw settings-file read/merge/write + frozen-default stripping.
 *
 * These pure helpers back ConfigManager's per-key persistence model: a set()
 * writes only the touched key into the raw on-disk shape (read-merge-write), a
 * whole-config write emits only the keys that differ from the shipped defaults,
 * and a one-time migration removes previously-frozen defaults from existing
 * files. Keeping them out of manager.ts keeps that file under the line cap and
 * makes the persistence rules independently testable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from './schema.js';
import type { GoodVibesConfig } from './schema.js';

const DEFAULT_CONFIG_SNAPSHOT = structuredClone(DEFAULT_CONFIG) as GoodVibesConfig;

/** Read a settings JSON file into a plain object; a missing/invalid file reads as {}. */
export function readRawSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Set a dot-path within a raw settings object, creating intermediate objects. */
export function writeRawDotPath(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Delete a dot-path leaf from a raw settings object, pruning any parent objects
 * it empties. Returns true when something was removed. Mirrors the shared-tier
 * removeSharedKey pruning so a cleared key leaves no `{ section: {} }` shell.
 */
export function deleteRawDotPath(root: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  const parents: Array<Record<string, unknown>> = [root];
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cursor[parts[i]!];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
    cursor = next as Record<string, unknown>;
    parents.push(cursor);
  }
  const leaf = parts[parts.length - 1]!;
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  for (let i = parts.length - 2; i >= 0; i--) {
    const parent = parents[i]!;
    const childKey = parts[i]!;
    const child = parent[childKey];
    if (child && typeof child === 'object' && !Array.isArray(child)
      && Object.keys(child as Record<string, unknown>).length === 0) {
      delete parent[childKey];
    } else {
      break;
    }
  }
  return true;
}

/** Structural equality for JSON-shaped config values (scalars, arrays, objects). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when a raw settings file looks like a whole-config dump the old save()
 * produced — every top-level default domain is present. This is the provenance
 * signal the read-time strip migration keys off: a full dump is the frozen-
 * defaults artifact and is safe to minimize; a sparse, hand-authored file
 * (even one whose lone key happens to equal a default) is deliberate user
 * intent and is left untouched. Keeps the migration conservative.
 */
export function isFrozenDefaultDump(
  raw: Record<string, unknown>,
  defaults: Record<string, unknown> = DEFAULT_CONFIG_SNAPSHOT as unknown as Record<string, unknown>,
): boolean {
  const domains = Object.keys(defaults);
  if (domains.length === 0) return false;
  return domains.every((domain) => domain in raw);
}

/**
 * Drop every leaf whose value equals the shipped default at the same path —
 * the "frozen defaults" a whole-config write used to bake in. Keys absent from
 * the defaults (genuine user data we cannot classify) are kept as-is; a value
 * that DIFFERS from its default is kept; an object emptied by stripping is
 * pruned. Conservative by construction: only default-equal, defaults-known
 * leaves are removed. Returns the stripped object and whether anything changed.
 */
export function stripFrozenDefaults(
  raw: Record<string, unknown>,
  defaults: Record<string, unknown> = DEFAULT_CONFIG_SNAPSHOT as unknown as Record<string, unknown>,
): { config: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const walk = (value: Record<string, unknown>, def: Record<string, unknown> | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const defChild = def ? def[key] : undefined;
      if (defChild === undefined) {
        out[key] = child; // Unknown key (not in defaults): keep genuine user data.
        continue;
      }
      const childIsObject = child !== null && typeof child === 'object' && !Array.isArray(child);
      const defIsObject = defChild !== null && typeof defChild === 'object' && !Array.isArray(defChild);
      if (childIsObject && defIsObject) {
        const nested = walk(child as Record<string, unknown>, defChild as Record<string, unknown>);
        if (Object.keys(nested).length > 0) out[key] = nested;
        else changed = true; // Every leaf under here equalled its default — prune the shell.
        continue;
      }
      if (jsonEqual(child, defChild)) {
        changed = true; // A frozen default leaf: drop it.
        continue;
      }
      out[key] = child;
    }
    return out;
  };
  const config = walk(raw, defaults);
  return { config, changed };
}
