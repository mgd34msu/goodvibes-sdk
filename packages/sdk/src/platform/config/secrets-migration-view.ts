/**
 * secrets-migration-view.ts, the only view of the secret stores that reaches
 * across surfaces.
 *
 * Resolution walks ONE surface root, and that is correct: the agent has no
 * business resolving a credential out of the TUI's silo at read time, and a
 * daemon that did would be reading a value nobody asked it to. Revoke walks the
 * same set, for the same reason.
 *
 * Migration is the single exception, and the owner's machine is why it has to
 * exist. Their Telegram token sat in `~/.goodvibes/agent/secrets.enc` while the
 * daemon booted rooted at `daemon` and enumerated only its own store. The
 * credential was one directory away, perfectly readable, and invisible to the
 * only code that could have lifted it, so nothing ever lifted it.
 *
 * Kept in its own module so the widening is a thing you have to import on
 * purpose. Anything reaching for `SecretsManager` gets the narrow view by
 * default; the cross-surface one has a name that says what it is.
 */

import { readdirSync, existsSync } from 'node:fs';
import type { SecretRecord } from './secrets.js';
import {
  siblingSurfaceSecretStores,
  type SecretStoreLayout,
  type SecretStorePath,
} from './secrets-store-paths.js';

/** This manager's own stores, plus every other surface's, deduplicated by file. */
export function migratableStores(
  layout: SecretStoreLayout,
  ownStores: readonly SecretStorePath[],
): SecretStorePath[] {
  const seen = new Set(ownStores.map((store) => store.path));
  const siblings = siblingSurfaceSecretStores(
    layout,
    // Both store shapes live here: a surface DIRECTORY holding `secrets.enc`,
    // and a sibling `<surface>.secrets.json` FILE. Listing only directories
    // missed every plaintext store.
    (path) => readdirSync(path),
    (path) => existsSync(path),
  );
  return [...ownStores, ...siblings.filter((store) => !seen.has(store.path))];
}

/**
 * Every credential in those stores, tagged with the FILE it came from.
 *
 * The path matters as much as the tier: several surfaces share the `user`
 * scope, so a record identified only by scope cannot say which copy it is, and
 * the migration's read-back verification would be comparing against an
 * arbitrary one of them.
 */
export function listMigratableSecrets(
  stores: readonly SecretStorePath[],
  read: (path: string, secure: boolean) => Record<string, string> | null,
): SecretRecord[] {
  const envKeys = new Set(Object.keys(process.env));
  const records: SecretRecord[] = [];
  for (const store of stores) {
    const values = read(store.path, store.secure);
    if (!values) continue;
    for (const key of Object.keys(values)) {
      records.push({
        key,
        source: store.source,
        scope: store.scope,
        secure: store.secure,
        path: store.path,
        overriddenByEnv: envKeys.has(key),
      });
    }
  }
  return records.sort((a, b) => a.key.localeCompare(b.key) || (a.path ?? '').localeCompare(b.path ?? ''));
}
