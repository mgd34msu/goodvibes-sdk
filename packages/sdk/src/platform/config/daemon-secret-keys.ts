/**
 * daemon-secret-keys.ts, which SECRET the daemon owns, derived from which
 * CONFIG the daemon owns.
 *
 * `config-ownership.ts` answers "who writes this setting". A credential is the
 * other half of the same question: `surfaces.googleChat.verificationToken` is
 * daemon-owned, so the token that setting points at is daemon-owned too, and it
 * belongs in the daemon's own store rather than in whichever client silo the
 * operator happened to be sitting in when they pasted it.
 *
 * The set is DERIVED from `listDaemonOwnedConfigPaths()` and never
 * hand-maintained: a credential is daemon-owned exactly when a daemon-owned
 * config path names it. Nothing else can be added here by accident, and a new
 * daemon-owned setting brings its credential along without anyone remembering.
 *
 * The name derivation is the platform-wide one (`buildGoodVibesSecretKey` in
 * the TUI, `replicatedSecretKeyFor` in the cluster policy, which now delegates
 * here). One rule, one implementation, so the two halves cannot drift.
 */

import { listDaemonOwnedConfigPaths } from './config-ownership.js';

function normalizeSecretKeyPart(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * The secret-store name a config path implies:
 * `surfaces.slack.botToken` → `GOODVIBES_SURFACES_SLACK_BOT_TOKEN`.
 */
export function daemonSecretKeyFor(configPath: string): string {
  return `GOODVIBES_${configPath.split('.').map(normalizeSecretKeyPart).filter(Boolean).join('_')}`;
}

let daemonSecretKeyCache: ReadonlyMap<string, string> | null = null;

/** Secret-store name → the daemon-owned config path that named it. */
export function listDaemonOwnedSecretKeys(): ReadonlyMap<string, string> {
  if (!daemonSecretKeyCache) {
    const map = new Map<string, string>();
    for (const path of listDaemonOwnedConfigPaths()) map.set(daemonSecretKeyFor(path), path);
    daemonSecretKeyCache = map;
  }
  return daemonSecretKeyCache;
}

/**
 * True when the daemon is the reader-of-record for this credential, and the
 * daemon tier is therefore its home.
 *
 * A bare name an operator invented (`SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`) is
 * NOT daemon-owned by this rule: nothing derives it from a daemon-owned path,
 * so it keeps whatever scope its caller asks for. Only the derived names move.
 */
export function isDaemonOwnedSecretKey(secretKey: string): boolean {
  return listDaemonOwnedSecretKeys().has(secretKey);
}
