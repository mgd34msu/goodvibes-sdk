/**
 * Channel-reply resolution of pending permission asks.
 *
 * A paired channel owner can approve, deny, or steer a pending ask by
 * replying in the channel with an explicit verb. The reply is consumed on
 * the shared ingress path (no session, no chat turn) and resolved through
 * the same ApprovalBroker the TUI and webui use.
 */
import type { ChannelIngressPolicyInput, ChannelPolicyDecision } from '../channels/index.js';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { RouteBindingManager } from '../channels/index.js';
import { logger } from '../utils/logger.js';

export type ApprovalReplyBroker = Pick<ApprovalBroker, 'listApprovals' | 'resolveApproval'>;

/**
 * Parse an owner's channel reply as an approval verb. Only explicit verbs are
 * consumed — anything else flows through as a normal message. The text after
 * the verb becomes the steering note carried on the resolution.
 */
export function parseApprovalReplyVerb(
  text: string | undefined,
): { readonly approved: boolean; readonly note?: string | undefined } | null {
  if (!text) return null;
  const match = text.trim().match(/^(approve|approved|allow|yes|deny|denied|reject|no)\b[\s:,–—-]*([\s\S]*)$/i);
  if (!match) return null;
  const verb = match[1]!.toLowerCase();
  const approved = verb === 'approve' || verb === 'approved' || verb === 'allow' || verb === 'yes';
  const note = match[2]?.trim();
  return { approved, ...(note ? { note } : {}) };
}

/**
 * When the paired owner replies with an explicit approve/deny verb and a
 * pending ask exists, resolve that ask through the shared ApprovalBroker.
 * Matching prefers asks whose route binding points at this surface; with no
 * surface-bound match, a single platform-wide pending ask is unambiguous and
 * is resolved; anything more ambiguous is left alone (the message then flows
 * through as a normal chat turn). Returns true when a reply was consumed.
 */
export async function tryResolveApprovalReplyFromChannel(
  input: ChannelIngressPolicyInput,
  decision: ChannelPolicyDecision,
  deps: {
    readonly approvalBroker?: ApprovalReplyBroker | undefined;
    readonly routeBindings: Pick<RouteBindingManager, 'getBinding'>;
  },
): Promise<boolean> {
  const broker = deps.approvalBroker;
  if (!broker || !input.userId) return false;
  const owners = decision.matchedGroupPolicy?.allowlistUserIds ?? decision.policy.allowlistUserIds;
  if (owners.length === 0 || !owners.includes(input.userId)) return false;
  const verb = parseApprovalReplyVerb(input.text);
  if (!verb) return false;

  const pending = broker.listApprovals(100).filter(
    (record) => record.status === 'pending' || record.status === 'claimed',
  );
  if (pending.length === 0) return false;
  const surfaceBound = pending.filter((record) => {
    if (!record.routeId) return false;
    const binding = deps.routeBindings.getBinding(record.routeId);
    return binding?.surfaceKind === input.surface;
  });
  // listApprovals sorts newest-first, so [0] is the most recent ask.
  const target = surfaceBound[0] ?? (pending.length === 1 ? pending[0] : undefined);
  if (!target) {
    logger.info('Channel approval reply not resolved: multiple pending asks and none bound to this surface', {
      surface: input.surface,
      userId: input.userId,
      pendingCount: pending.length,
    });
    return false;
  }

  await broker.resolveApproval(target.id, {
    approved: verb.approved,
    actor: input.userId,
    actorSurface: input.surface,
    // The reply's trailing text is model-visible guidance, not just an audit
    // note: as `reason` it rides the structured declined/approved decision to
    // the waiting tool call (the same field the in-process deny-with-reason
    // path uses), so "deny — use the staging database instead" steers the
    // model instead of behaving as a bare deny. `note` keeps the audit trail.
    ...(verb.note ? { note: verb.note, reason: verb.note } : {}),
  });
  logger.info('Pending approval resolved from a channel reply', {
    surface: input.surface,
    userId: input.userId,
    approvalId: target.id,
    approved: verb.approved,
    steered: Boolean(verb.note),
  });
  return true;
}
