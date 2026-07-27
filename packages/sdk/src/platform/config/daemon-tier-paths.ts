/**
 * daemon-tier-paths.ts — resolving a daemon-owned path while loading the
 * daemon tier, creating the section it lives in if the product has not yet.
 *
 * ── The defect this exists to fix ─────────────────────────────────────────
 *
 * Not every daemon-owned path is a CONFIG_SCHEMA key. `email.*`, `calendar.*`
 * and `google.*` are app-layer sections a product materializes at runtime
 * (`ensureEmailConfigDefaults`, `ensureGoogleConfigDefaults`,
 * `ensureCalendarConfigDefaults`), and the whole mail and calendar connection
 * was made daemon-owned so a value set from ANY surface reaches the daemon
 * instead of stranding in that surface's silo.
 *
 * Those two facts collided. The daemon-tier overlay runs inside the
 * `ConfigManager` CONSTRUCTOR, before any product has had a chance to call its
 * `ensure*` seeding. So a daemon settings file containing `email.imapHost` — a
 * path the platform itself declares daemon-owned — made `resolvePath` throw
 * "section 'email' does not exist", and every `ConfigManager` built against
 * that directory failed to construct. Storing a value correctly bricked
 * reading it back, which is a worse failure than the stranding it was meant to
 * cure.
 *
 * ── Why create the section rather than skip the key ───────────────────────
 *
 * Skipping would put the value back exactly where daemon ownership was
 * introduced to rescue it from: present in the store, ignored on load, looking
 * set while doing nothing. That is the silent-no-op class this whole area has
 * been fixing.
 *
 * And it cannot become a hole for arbitrary keys. The overlay only ever yields
 * paths on the declared daemon-owned list, so the only sections this can
 * materialize are ones the platform already says the daemon owns. A key nobody
 * declared never reaches here.
 */

import type { DaemonOwnedConfigPath } from './config-ownership.js';

/** Where a dot-path lands: the object holding the final field, and that field. */
export interface ResolvedConfigSlot {
  readonly parent: Record<string, unknown>;
  readonly field: string;
}

/**
 * Walk `root` to `key`, creating any missing intermediate section.
 *
 * A non-object sitting where a section should be (a string left by a hand
 * edit, say) is replaced rather than walked into — the alternative is throwing
 * during construction, which is the failure this module exists to remove.
 */
export function resolveOrCreateDaemonPath(
  root: Record<string, unknown>,
  key: DaemonOwnedConfigPath,
): ResolvedConfigSlot {
  const parts = key.split('.');
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = cursor[part];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  return { parent: cursor, field: parts[parts.length - 1]! };
}
