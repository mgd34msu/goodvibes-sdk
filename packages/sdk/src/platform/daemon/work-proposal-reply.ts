/**
 * Channel-reply resolution of pending work proposals.
 *
 * When the gate proposes a workstream over a channel, agreement has to be
 * answerable over that same channel, a gate that requires walking to a
 * terminal is the same friction with extra steps. This module is the
 * counterpart to approval-reply.ts and hangs off the same shared ingress
 * hook (`authorizeSurfaceIngress`), so every surface adapter gets it without
 * any per-adapter wiring.
 */
import type { ChannelIngressPolicyInput } from '../channels/index.js';
import {
  parseWorkProposalReply,
  renderProposalDeclinedMessage,
  renderProposalExpiredMessage,
} from '../agents/conversation-gate.js';
import type { WorkProposalRecord, WorkProposalStore } from '../agents/work-proposal-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type WorkProposalReplyOutcome =
  | { readonly consumed: false }
  | { readonly consumed: true; readonly action: 'accepted' | 'declined' | 'expired' };

export interface WorkProposalReplyDeps {
  readonly proposals?: Pick<WorkProposalStore, 'listPending' | 'resolve'> | undefined;
  /**
   * Start the agreed work. Called only after an affirmative reply resolved a
   * pending proposal, so the run is pre-authorized by construction and must
   * NOT be re-gated.
   */
  readonly startAgreedWork: (proposal: WorkProposalRecord, note?: string) => Promise<void>;
  /** Send a short acknowledgement back over the proposal's own channel. */
  readonly replyOnChannel: (proposal: WorkProposalRecord, text: string) => Promise<void>;
}

/**
 * Match an inbound message against the pending proposals for its surface.
 *
 * Matching is deliberately narrow: the proposal must be pending, on the same
 * surface, and (when both are known) from the same user. Only the most recent
 * such proposal is considered, so a bare "yes" can never resolve something the
 * owner has forgotten about. An expired proposal is not silently ignored, it
 * is reported back as expired, which is what "disclosed" means for state the
 * owner can no longer act on.
 */
export function findProposalForReply(
  input: Pick<ChannelIngressPolicyInput, 'surface' | 'userId' | 'threadId' | 'channelId'>,
  pending: readonly WorkProposalRecord[],
): WorkProposalRecord | null {
  const sameSurface = pending.filter((record) => record.surfaceKind === input.surface);
  if (sameSurface.length === 0) return null;
  const sameUser = input.userId
    ? sameSurface.filter((record) => !record.userId || record.userId === input.userId)
    : sameSurface;
  const candidates = sameUser.length > 0 ? sameUser : sameSurface;
  // Prefer a thread/channel match when the surface carries one; otherwise the
  // newest pending proposal on this surface.
  const threadMatch = input.threadId
    ? candidates.find((record) => record.threadId === input.threadId)
    : undefined;
  const channelMatch = input.channelId
    ? candidates.find((record) => record.channelId === input.channelId || record.externalId === input.channelId)
    : undefined;
  return threadMatch ?? channelMatch ?? candidates[0] ?? null;
}

/**
 * Consume an inbound message if it answers a pending work proposal.
 *
 * Returns `consumed: true` when the message was an answer, the adapter must
 * then neither create a chat turn nor spawn anything, because this function
 * has already done whatever the answer called for.
 */
export async function tryResolveWorkProposalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  deps: WorkProposalReplyDeps,
): Promise<WorkProposalReplyOutcome> {
  const store = deps.proposals;
  if (!store) return { consumed: false };

  const reply = parseWorkProposalReply(input.text);
  if (!reply) return { consumed: false };

  // listPending reaps first, so anything returned here is genuinely answerable.
  const pending = store.listPending({ surfaceKind: input.surface });
  const target = findProposalForReply(input, pending);
  if (!target) {
    // A bare "yes" with nothing pending is ordinary conversation, let it flow
    // through rather than swallowing it.
    return { consumed: false };
  }

  const resolved = store.resolve(target.id, reply.decision === 'affirmative' ? 'accepted' : 'declined');
  if (!resolved) {
    // Reaped between listPending and resolve, or answered by a racing reply.
    await deps.replyOnChannel(target, renderProposalExpiredMessage(target.summary)).catch((error: unknown) => {
      logger.warn('Work proposal expiry notice failed', { error: summarizeError(error) });
    });
    return { consumed: true, action: 'expired' };
  }

  if (reply.decision === 'negative') {
    await deps.replyOnChannel(resolved, renderProposalDeclinedMessage(resolved.summary)).catch((error: unknown) => {
      logger.warn('Work proposal decline notice failed', { error: summarizeError(error) });
    });
    logger.info('Work proposal declined from a channel reply', {
      surface: input.surface,
      proposalId: resolved.id,
    });
    return { consumed: true, action: 'declined' };
  }

  logger.info('Work proposal accepted from a channel reply', {
    surface: input.surface,
    proposalId: resolved.id,
    steered: Boolean(reply.note),
  });
  await deps.startAgreedWork(resolved, reply.note);
  return { consumed: true, action: 'accepted' };
}
