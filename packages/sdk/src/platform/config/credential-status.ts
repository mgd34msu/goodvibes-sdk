/**
 * credential-status.ts
 *
 * Promotes the internal SecretsManager to a secret-FREE status source for the
 * daemon's `credentials.get` wire method (W6-C1 / E7 config sharing).
 *
 * The returned provider reports whether each credential in the shared store is
 * configured and usable — it NEVER exposes the plaintext value. `usable` is a
 * real in-process resolution attempt (env → store → secret-ref), reported only
 * as a boolean, so a configured-but-unresolvable reference (e.g. a broken
 * `op://` ref) is honestly `configured: true, usable: false`.
 *
 * Enumeration is over STORED keys only (SecretsManager.listDetailed filtered to
 * non-env sources) — never a `process.env` dump — so it cannot leak the names of
 * unrelated environment variables. A caller-named single-key probe (`get`) may
 * consult env for that one named key only.
 */

import type {
  CredentialStatusProviderLike,
  CredentialStatusRecord,
} from '@pellux/goodvibes-daemon-sdk';
import type { SecretsManager } from './secrets.js';

/** The SecretsManager surface this adapter needs (keeps callers free to inject a stub). */
type SecretsMetadataSource = Pick<SecretsManager, 'get' | 'list' | 'listDetailed'>;

async function resolveUsable(secrets: SecretsMetadataSource, key: string): Promise<boolean> {
  try {
    const value = await secrets.get(key);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}

/**
 * Wrap a SecretsManager (the daemon's shared store) as a secret-free credential
 * status provider suitable for the `credentials.get` route context.
 */
export function createCredentialStatusProvider(
  secrets: SecretsMetadataSource,
): CredentialStatusProviderLike {
  return {
    async list(): Promise<readonly CredentialStatusRecord[]> {
      const detailed = await secrets.listDetailed();
      // STORED keys only — filter out the bulk env enumeration so we never leak
      // the names of unrelated environment variables over the wire.
      const stored = detailed.filter((record) => record.source !== 'env');
      const records: CredentialStatusRecord[] = [];
      for (const record of stored) {
        records.push({
          key: record.key,
          configured: true,
          usable: await resolveUsable(secrets, record.key),
          source: record.source,
          scope: record.scope,
          secure: record.secure,
          overriddenByEnv: record.overriddenByEnv,
          ...(record.refSource ? { refSource: record.refSource } : {}),
        });
      }
      return records;
    },
    async get(key: string): Promise<CredentialStatusRecord | null> {
      const detailed = await secrets.listDetailed();
      // A named probe MAY consult env for this one caller-named key. Prefer a
      // stored record; fall back to an env-backed record for the same name.
      const match =
        detailed.find((record) => record.key === key && record.source !== 'env') ??
        detailed.find((record) => record.key === key) ??
        null;
      if (!match) {
        return { key, configured: false, usable: false, source: 'none', scope: 'none', secure: false, overriddenByEnv: false };
      }
      return {
        key: match.key,
        configured: true,
        usable: await resolveUsable(secrets, key),
        source: match.source,
        scope: match.scope,
        secure: match.secure,
        overriddenByEnv: match.overriddenByEnv,
        ...(match.refSource ? { refSource: match.refSource } : {}),
      };
    },
  };
}
