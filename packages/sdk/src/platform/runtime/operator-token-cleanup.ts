/**
 * operator-token-cleanup.ts, where a surface's operator token lives, and the
 * workspace-scoped locations an older install may have left one in.
 *
 * The canonical location is `<daemonHomeDir>/operator-tokens.json`. Earlier
 * releases wrote workspace-scoped copies instead;
 * `workspaceOperatorTokenCandidates` enumerates those so a boot can prune them
 * from one list rather than each caller guessing. Adding a location: append to
 * that function and it is inspected on the next boot.
 *
 * `resolveDaemonCompanionToken` is the read side: which token this process
 * authenticates to its daemon with, honoring a non-interactive override.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getOrCreateCompanionToken } from '../pairing/companion-token.js';
import type { CompanionPairingResult } from '../pairing/companion-token.js';

/**
 * The absolute operator-tokens.json paths a workspace may hold from an older
 * install: the unscoped `.goodvibes/` one and the surface-scoped one under
 * `.goodvibes/<surfaceRoot>/`.
 *
 * The canonical, current location is `<daemonHomeDir>/operator-tokens.json`;
 * this list is strictly the pruning candidates.
 */
export function workspaceOperatorTokenCandidates(
  workingDirectory: string,
  surfaceRoot: string,
): readonly string[] {
  return [
    join(workingDirectory, '.goodvibes', 'operator-tokens.json'),
    join(workingDirectory, '.goodvibes', surfaceRoot, 'operator-tokens.json'),
  ];
}

/**
 * External-daemon adoption: resolve the operator/companion token this process
 * uses to authenticate with its daemon, honoring `GOODVIBES_DAEMON_TOKEN` as a
 * non-interactive override.
 *
 * Without the override, the only way to make a surface adopt an already-running
 * external daemon that used an out-of-band or explicit token (rather than one
 * derived from `getOrCreateCompanionToken` under a *shared* home directory) is
 * to hand-write `<daemonHomeDir>/operator-tokens.json` before startup, no env
 * var or flag equivalent exists.
 *
 * `GOODVIBES_DAEMON_TOKEN` is the same env var the daemon honors for its own
 * bearer token, and the same one an outside prober falls back to when reaching
 * a daemon's HTTP surface. Reusing the name means one env var configures both
 * sides of an adopted-daemon setup, start the daemon with
 * `GOODVIBES_DAEMON_TOKEN=<token>` and point the surface at it with the same
 * `GOODVIBES_DAEMON_TOKEN=<token>` plus its control-plane host/port, instead of
 * a second, per-product flag.
 *
 * When the override is set and does not already match the on-disk record, the
 * file is rewritten so the override becomes durable for this home directory (an
 * existing peerId is kept when present, so companion-pairing identity does not
 * needlessly churn). Falls back to the existing `getOrCreateCompanionToken`
 * behavior, read the existing file, or mint a fresh random token, when the
 * override is unset.
 *
 * @param daemonHomeDir - The daemon home whose token record is read/written.
 * @param peerName - The companion peer name minted under when no override is
 * set; the calling product's own name, so two products sharing a home mint
 * distinguishable peers.
 * @param explicitToken - Takes precedence over `GOODVIBES_DAEMON_TOKEN` when
 * provided. Used by an onboarding "connect to an existing daemon" action (a
 * pasted token) so it shares this exact persistence logic with the env-var path
 * instead of duplicating it.
 */
export function resolveDaemonCompanionToken(
  daemonHomeDir: string,
  peerName: string,
  explicitToken?: string,
): CompanionPairingResult {
  const override = explicitToken?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (!override) return getOrCreateCompanionToken(peerName, { daemonHomeDir });

  const tokenPath = join(daemonHomeDir, 'operator-tokens.json');
  let existingPeerId: string | undefined;
  let existingCreatedAt: number | undefined;
  if (existsSync(tokenPath)) {
    try {
      const record = JSON.parse(readFileSync(tokenPath, 'utf-8')) as {
        token?: unknown;
        peerId?: unknown;
        createdAt?: unknown;
      };
      if (typeof record.token === 'string' && record.token === override) {
        return {
          token: override,
          peerId: typeof record.peerId === 'string' ? record.peerId : randomBytes(12).toString('hex'),
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        };
      }
      if (typeof record.peerId === 'string') existingPeerId = record.peerId;
      if (typeof record.createdAt === 'number') existingCreatedAt = record.createdAt;
    } catch {
      // Malformed on-disk record, fall through and rewrite it with the override.
    }
  }

  const record: CompanionPairingResult = {
    token: override,
    peerId: existingPeerId ?? randomBytes(12).toString('hex'),
    createdAt: existingCreatedAt ?? Date.now(),
  };
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch {
    // Best-effort persistence, the override still applies for this process
    // even if the file could not be written (e.g. a read-only home directory).
  }
  return record;
}
