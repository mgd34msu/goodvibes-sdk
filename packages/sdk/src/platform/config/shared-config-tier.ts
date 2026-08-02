/**
 * shared-config-tier.ts — the surface-root-independent config tier.
 *
 * A small set of keys (the voice/tts settings) must resolve to the SAME value on
 * every surface — terminal, desktop, and the agent — rather than living in a
 * per-surface silo (`~/.goodvibes/<surface>/settings.json`). Those keys read from
 * and write to one neutral on-disk store, `~/.goodvibes/shared/settings.json`
 * (the E7 shared-tier path; see docs/decisions/2026-07-06-config-sharing-shared-tier-and-secret-read.md
 * and docs/decisions/2026-07-06-shared-voice-config-tier.md).
 *
 * Resolution order for a shared key: defaults < global surface < project surface
 * < SHARED TIER < CLI overrides. A surface with no shared value falls back to its
 * local setting, so existing setups never break; a present shared value wins so
 * all surfaces agree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { ConfigKey } from './schema.js';
import { raiseSettingsReaderFloor } from './settings-reader-floor.js';

/**
 * The keys that ride the shared, surface-root-independent tier. Currently the
 * voice/tts settings — one voice across every surface.
 */
export const SHARED_CONFIG_KEYS: readonly ConfigKey[] = [
  'tts.provider',
  'tts.voice',
  'tts.speed',
  'tts.llmProvider',
  'tts.llmModel',
];

const SHARED_CONFIG_KEY_SET = new Set<string>(SHARED_CONFIG_KEYS);

/** True when `key` resolves from/writes to the shared tier rather than a surface silo. */
export function isSharedConfigKey(key: string): key is ConfigKey {
  return SHARED_CONFIG_KEY_SET.has(key);
}

/**
 * Read a dot-path (e.g. `tts.voice`) from a parsed-JSON object, distinguishing an
 * absent key from a stored value (so an explicit `""` is honored, not treated as
 * "not set").
 */
export function readDotPath(root: unknown, key: string): { present: boolean; value: unknown } {
  const parts = key.split('.');
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)
      || !(part in (cursor as Record<string, unknown>))) {
      return { present: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { present: true, value: cursor };
}

function writeDotPath(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Load a settings tier file into a plain object (empty object when the file does
 * not exist yet). Throws when the file exists but cannot be read as a JSON
 * object.
 *
 * ── Why this one does NOT quarantine and carry on ─────────────────────────
 *
 * Every other JSON store in the platform now treats content it cannot trust as
 * "absent": the file is moved aside with a receipt and the caller rebuilds. This
 * store is the exception, deliberately.
 *
 * It backs the DAEMON tier, which is where every daemon-owned key lives —
 * permissions, the payment limits, the gates that decide what may run and what
 * may be spent. A reader cannot tell whether the bytes it could not parse held
 * one of those, so it cannot know that starting on the shipped defaults is safe;
 * defaults are frequently MORE permissive than what the operator stored. The
 * ruled behaviour is to refuse to start and say which file and why (see
 * settings-ingestion.ts for the same reasoning applied per key, and
 * test/daemon-isolation-guards.ts for the daemon's side of it).
 *
 * The torn-write half of the problem is solved at the writer instead: every
 * write through this module is atomic (temp file, fsync, rename), so a crash
 * mid-save can no longer produce the half-file that made this refusal fire.
 */
export function readSharedTierFile(path: string, label = 'shared tier'): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} settings file is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Write a dot-path into a plain object, creating intermediate objects. */
export function writeTierDotPath(root: Record<string, unknown>, key: string, value: unknown): void {
  writeDotPath(root, key, value);
}

/**
 * Persist one shared key's value into the shared tier file, merging with whatever
 * is already there (never clobbering the other shared keys). Writes only the
 * explicitly-set key so unrelated surface-local values are not silently promoted.
 */
export function persistSharedKey(path: string, key: string, value: unknown): void {
  const existing = readSharedTierFile(path);
  writeDotPath(existing, key, value);
  writeJsonFileAtomic(path, existing);
}

/**
 * Record, in the file itself, the lowest reader version that can ingest what a
 * migration just rewrote here.
 *
 * This settings file is SHARED state: several components read it and several
 * write it, and on a real machine they are not all the same version at the same
 * moment. When the credential sweep rewrote a literal password into a
 * `goodvibes://secrets/…` reference, it wrote a form the daemon of the day could
 * not walk, and that daemon failed while constructing its ConfigManager. The
 * operator saw a daemon that would not start. What had happened was a newer
 * component migrating shared state under an older reader, and nothing on disk
 * said so.
 *
 * Best-effort by construction: a floor that cannot be written must never undo a
 * migration that already succeeded, and a file that does not exist gets no
 * marker — a floor describes a rewrite, so there is nothing to record where
 * nothing was written. Returns true when the floor was raised.
 */
export function raiseReaderFloorInFile(path: string, minReaderVersion: string, setBy: string): boolean {
  if (!existsSync(path)) return false;
  const existing = readSharedTierFile(path);
  const { raised } = raiseSettingsReaderFloor(existing, minReaderVersion, setBy);
  if (!raised) return false;
  writeJsonFileAtomic(path, existing);
  return true;
}

/**
 * Remove one shared key from the shared tier file, so the key falls back to its
 * surface-local or default value (used by reset). A no-op when the file or key is
 * absent. Prunes an emptied parent object so a reset leaves no `{ tts: {} }` shell.
 */
export function removeSharedKey(path: string, key: string): void {
  if (!existsSync(path)) return;
  const existing = readSharedTierFile(path);
  const parts = key.split('.');
  const parents: Array<Record<string, unknown>> = [existing];
  let cursor: Record<string, unknown> = existing;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cursor[parts[i]!];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
    parents.push(cursor);
  }
  const leaf = parts[parts.length - 1]!;
  if (!(leaf in cursor)) return;
  delete cursor[leaf];
  // Prune now-empty parent objects from the deepest up.
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
  writeJsonFileAtomic(path, existing);
}
