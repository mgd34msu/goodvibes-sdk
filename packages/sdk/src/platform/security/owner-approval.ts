/**
 * owner-approval.ts, the one thing that clears an outward-effect refusal, and
 * why untrusted content cannot produce one.
 *
 * ── The failure this replaces ─────────────────────────────────────────────
 *
 * The refusal used to tell the owner: reply "send it now" and it will be
 * resent. He replied, and it refused again with the same message. Two things
 * were wrong at once and either alone would have been a defect:
 *
 *  - Nothing in production ever minted an `OwnerApproval`. `grantOwnerApproval`
 *    had test callers only, so the advice named a mechanism with no
 *    implementation behind it. Advice that cannot work is worse than no advice:
 *    it spends the owner's trust and teaches him the boundary is broken.
 *  - Had a typed phrase minted one, that would have been the WORSE outcome. A
 *    security boundary cleared by three words of chat text is cleared by
 *    anything that can get those words into the chat, and steering the
 *    conversation toward producing a particular sentence is exactly what the
 *    content this boundary guards against is good at. The gate would have been
 *    theatre.
 *
 * ── What an approval is, therefore ────────────────────────────────────────
 *
 * A record that a HUMAN answered a prompt, out of band from the conversation,
 * about ONE specific action carrying ONE specific payload. Four properties, and
 * each closes a way the previous design could be ridden:
 *
 *  1. **Owner-direct only.** `grantOwnerApproval` refuses every other surface,
 *     so no page, mailbox, channel or document can produce one no matter what
 *     it says. This was already true and is kept.
 *  2. **Bound to the content.** An approval carries a fingerprint of the exact
 *     fields it approved. Without this, an approval is a standing permit for an
 *     action id: the owner approves one benign `email.send`, and the next
 *     `email.send`, whose body the injected content wrote, rides it. Matching
 *     on the action id alone is matching on the verb, not on the deed.
 *  3. **Short-lived.** An approval that never expires is a key left in a lock.
 *     The window is minutes, because the gesture and the send are adjacent in
 *     time by construction.
 *  4. **Single use.** Taken from the store when spent, so one answered prompt
 *     authorizes one action and not a loop of them.
 *
 * ── What this deliberately does NOT accept as an approval ─────────────────
 *
 *  - A phrase in the conversation, however specific.
 *  - `confirm: true` on a tool call. That flag says the CALL was formed
 *    deliberately; it is set by the model, and a model reading injected text is
 *    precisely the thing being defended against. It remains a useful gate in
 *    front of every outward effect and it is not this one.
 *  - Anything derived from message or page content, including a sender address
 *    or a header.
 *
 * The gesture that mints one is a prompt the human answers, see the surface's
 * approval broker. That is why `grantOwnerApproval` takes `surface` from the
 * CODE PATH rather than from any argument a tool call can carry.
 */

import { createHash } from 'node:crypto';

/**
 * How long an answered prompt stays spendable.
 *
 * Minutes, not hours: the owner answers and the action follows immediately, so
 * a long window buys nothing and leaves a spendable approval sitting in memory
 * across everything the process does next.
 */
export const OWNER_APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Only the owner, speaking directly to the runtime, can authorize work. */
export type ApprovalSurface = 'owner-direct' | 'web-page' | 'email' | 'channel-message' | 'document';

/**
 * An owner approval for one outward effect, carrying one payload.
 *
 * It can only be created from a surface with command authority, which is why
 * the factory takes the surface and refuses everything else. Page text cannot
 * manufacture one of these no matter what it says.
 */
export interface OwnerApproval {
  readonly action: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly surface: 'owner-direct';
  /**
   * Fingerprint of the exact fields approved, or `null` when the approving
   * surface could not enumerate them.
   *
   * `null` is the weaker form and is treated as such: it clears only a refusal
   * that was itself made without content, never a content-derivation finding.
   * An approval given without seeing the payload cannot authorize a payload.
   */
  readonly contentFingerprint: string | null;
}

/**
 * A stable digest of the fields about to leave the machine.
 *
 * Field names are included and the record is sorted, so moving a body into the
 * subject changes the fingerprint. Values are compared after the same
 * whitespace normalization the taint check uses, so a reflowed line does not
 * invalidate an approval the owner has just given for the same message, but
 * any change to the words does.
 */
export function fingerprintOutwardContent(
  fields: Readonly<Record<string, string | undefined>> | undefined,
): string | null {
  if (fields === undefined) return null;
  const normalized = Object.entries(fields)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => [name, value.replace(/\s+/g, ' ').trim()] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  if (normalized.length === 0) return null;
  const hash = createHash('sha256');
  for (const [name, value] of normalized) {
    // Length-prefixed so `{a:'xy'}` and `{ax:'y'}` cannot digest alike.
    hash.update(`${String(name.length)}:${name}${String(value.length)}:${value}`);
  }
  return hash.digest('hex');
}

export function grantOwnerApproval(input: {
  readonly action: string;
  /**
   * The surface the approving gesture arrived on. Supplied by the CODE PATH
   * that handled the gesture, never read from a tool argument or from content.
   */
  readonly surface: ApprovalSurface;
  /** The exact fields the owner was shown. Omitting them yields the weak form. */
  readonly content?: Readonly<Record<string, string | undefined>> | undefined;
  readonly ttlMs?: number | undefined;
  readonly now?: () => Date;
}): OwnerApproval | null {
  if (input.surface !== 'owner-direct') return null;
  const at = input.now?.() ?? new Date();
  const ttl = input.ttlMs !== undefined && input.ttlMs > 0 ? input.ttlMs : OWNER_APPROVAL_TTL_MS;
  return {
    action: input.action,
    grantedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + ttl).toISOString(),
    surface: 'owner-direct',
    contentFingerprint: fingerprintOutwardContent(input.content),
  };
}

/** Why an approval did not clear a refusal, so a message can say which. */
export type ApprovalMismatch =
  | 'none'
  | 'different-action'
  | 'expired'
  | 'different-content'
  | 'no-content-binding';

/**
 * Does this approval authorize THIS action with THIS payload?
 *
 * `contentInQuestion` is the field record the caller is about to send. When it
 * is present, the approval must be bound to the same payload, an approval for
 * a different message is not an approval for this one, and that is the whole
 * point of the binding.
 */
export function checkOwnerApproval(input: {
  readonly approval: OwnerApproval | null | undefined;
  readonly action: string;
  readonly contentInQuestion?: Readonly<Record<string, string | undefined>> | undefined;
  /** True when the refusal being cleared is a content-derivation finding. */
  readonly clearingContentTaint: boolean;
  readonly now?: () => Date;
}): { readonly authorized: boolean; readonly mismatch: ApprovalMismatch } {
  const approval = input.approval;
  if (!approval) return { authorized: false, mismatch: 'none' };
  if (approval.action !== input.action) return { authorized: false, mismatch: 'different-action' };
  const now = (input.now?.() ?? new Date()).getTime();
  if (Number.isFinite(Date.parse(approval.expiresAt)) && Date.parse(approval.expiresAt) <= now) {
    return { authorized: false, mismatch: 'expired' };
  }
  if (input.clearingContentTaint) {
    // A derivation finding says THIS payload repeats what was read. Only an
    // approval the owner gave while looking at THIS payload answers it.
    if (approval.contentFingerprint === null) {
      return { authorized: false, mismatch: 'no-content-binding' };
    }
    const fingerprint = fingerprintOutwardContent(input.contentInQuestion);
    if (fingerprint === null || fingerprint !== approval.contentFingerprint) {
      return { authorized: false, mismatch: 'different-content' };
    }
  }
  return { authorized: true, mismatch: 'none' };
}

/**
 * Where a surface keeps approvals between the gesture and the action.
 *
 * Single use is enforced here rather than by convention: `take` removes what it
 * returns, so one answered prompt cannot authorize a loop. Expired entries are
 * swept on every access, so an abandoned prompt does not leave a spendable
 * approval in memory for the life of the process.
 */
export class OwnerApprovalStore {
  private readonly approvals: OwnerApproval[] = [];

  /** Bounded: a surface that mints without spending must not grow without limit. */
  private static readonly MAX_PENDING = 64;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Record an approval the owner has just given.
   *
   * Returns null, and stores nothing, for any surface without command
   * authority, so a caller that threads the wrong surface fails closed.
   */
  grant(input: {
    readonly action: string;
    readonly surface: ApprovalSurface;
    readonly content?: Readonly<Record<string, string | undefined>> | undefined;
    readonly ttlMs?: number | undefined;
  }): OwnerApproval | null {
    const approval = grantOwnerApproval({ ...input, now: this.now });
    if (approval === null) return null;
    this.sweep();
    this.approvals.push(approval);
    if (this.approvals.length > OwnerApprovalStore.MAX_PENDING) {
      this.approvals.splice(0, this.approvals.length - OwnerApprovalStore.MAX_PENDING);
    }
    return approval;
  }

  /**
   * Spend the approval matching this action and payload, if one is held.
   *
   * Removes what it returns. A caller that takes an approval and then does not
   * perform the action has spent it, which is the safe direction.
   */
  take(input: {
    readonly action: string;
    readonly content?: Readonly<Record<string, string | undefined>> | undefined;
  }): OwnerApproval | null {
    this.sweep();
    const wanted = fingerprintOutwardContent(input.content);
    const index = this.approvals.findIndex(
      (approval) =>
        approval.action === input.action
        && (wanted === null || approval.contentFingerprint === null || approval.contentFingerprint === wanted),
    );
    if (index < 0) return null;
    const [approval] = this.approvals.splice(index, 1);
    return approval ?? null;
  }

  /** Whether anything is currently spendable, for a status line. */
  pendingCount(): number {
    this.sweep();
    return this.approvals.length;
  }

  private sweep(): void {
    const now = this.now().getTime();
    for (let index = this.approvals.length - 1; index >= 0; index -= 1) {
      const entry = this.approvals[index];
      if (entry === undefined) continue;
      const expiry = Date.parse(entry.expiresAt);
      if (Number.isFinite(expiry) && expiry <= now) this.approvals.splice(index, 1);
    }
  }
}
