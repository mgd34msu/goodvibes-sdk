/**
 * grants.ts — pre-registered, digest-pinned action grants.
 *
 * A firing trigger runs an agent turn or a grant registered here. It never
 * composes a new command at fire time: arbitrary shell on an unattended event
 * is the one path with no person in the loop. A grant closes that gap by moving
 * the human moment forward — the exact argv is written down and confirmed while
 * a person is present, hashed, and the hash is what the trigger carries.
 *
 * At fire time the digest is recomputed from the stored grant and must match
 * the digest recorded on the trigger byte for byte. Editing the grant after the
 * fact therefore breaks every trigger pinned to it, which is the intended
 * behaviour: the operator re-confirms rather than silently inheriting a
 * different command than the one they approved.
 */

import { createHash } from 'node:crypto';
import { validateArgv } from './validation.js';
import type { TriggerActionGrant } from './types.js';

/**
 * Canonical digest input. Covers everything that decides what actually runs —
 * the executable, its arguments and its working directory. The description and
 * timestamps are deliberately excluded so a typo fix in prose does not
 * invalidate a grant, while any change to the command does.
 */
function canonicalGrant(grant: Pick<TriggerActionGrant, 'command' | 'args' | 'cwd'>): string {
  return JSON.stringify({
    command: grant.command,
    args: [...grant.args],
    cwd: grant.cwd ?? null,
  });
}

export function computeGrantDigest(grant: Pick<TriggerActionGrant, 'command' | 'args' | 'cwd'>): string {
  return createHash('sha256').update(canonicalGrant(grant)).digest('hex');
}

export interface RegisterGrantInput {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** Who confirmed it. Recorded so the approval has a name attached. */
  readonly confirmedBy: string;
  readonly now?: number | undefined;
}

export function createActionGrant(input: RegisterGrantInput): TriggerActionGrant {
  const { command, args } = validateArgv(input.command, input.args, 'grant');
  if (!input.confirmedBy || input.confirmedBy.trim().length === 0) {
    throw new Error('An action grant must record who confirmed it — an unattributed grant is not a confirmation.');
  }
  if (!input.description || input.description.trim().length === 0) {
    throw new Error('An action grant must carry a description of what it does, so the confirmation is informed.');
  }
  const now = input.now ?? Date.now();
  const base = { command, args, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) };
  return {
    id: input.id,
    description: input.description,
    ...base,
    createdAt: now,
    confirmedAt: now,
    confirmedBy: input.confirmedBy,
    digest: computeGrantDigest(base),
  };
}

export type GrantVerification =
  | { readonly ok: true; readonly grant: TriggerActionGrant }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a pinned grant at fire time. Three ways to fail, all refusals:
 * the grant is gone, its stored digest no longer matches its own contents
 * (edited on disk), or the trigger's pin does not match the grant.
 */
export function verifyGrant(
  grants: readonly TriggerActionGrant[],
  grantId: string,
  pinnedDigest: string,
): GrantVerification {
  const grant = grants.find((entry) => entry.id === grantId);
  if (!grant) {
    return { ok: false, reason: `action grant "${grantId}" is not registered — refusing to fire` };
  }
  const recomputed = computeGrantDigest(grant);
  if (recomputed !== grant.digest) {
    return {
      ok: false,
      reason: `action grant "${grantId}" was modified after it was confirmed (stored digest does not match its contents) — refusing to fire`,
    };
  }
  if (recomputed !== pinnedDigest) {
    return {
      ok: false,
      reason: `action grant "${grantId}" no longer matches the digest this trigger was created against — re-confirm the grant to re-pin it`,
    };
  }
  return { ok: true, grant };
}
