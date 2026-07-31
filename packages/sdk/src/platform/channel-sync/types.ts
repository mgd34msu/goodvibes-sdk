/**
 * channel-sync/types.ts — the two tables a daemon mirrors on behalf of the
 * surfaces that talk to channels.
 *
 * ROUTING RULES bind a channel to a profile. They are deliberately NOT the
 * channel→profile BINDINGS in platform/channel-profiles: a binding carries the
 * model, provider and permission-mode defaults an inbound message's session is
 * spawned with, and is read on the intake path for every message. A routing
 * rule carries a profile IDENTIFIER a surface chose, is read by that surface
 * when it draws its routing screen, and is mirrored here so the choice survives
 * the device that made it. Folding them together would put an intake-critical
 * record and a cross-device UI record in one table with one lifecycle.
 *
 * DRAFTS are unsent channel messages a person is composing. They are mirrored
 * so a draft started on a phone is there on a laptop, which is the only reason
 * the daemon holds them at all.
 *
 * A webhook URL in a draft is a credential — anyone holding it can post to the
 * channel — so the store refuses one outright rather than storing it. The
 * surface redacts before it sends; a raw value arriving here means that
 * redaction did not happen, and accepting it would put a live credential in a
 * cross-device store that syncs to every one of the owner's machines.
 */

/** Where a draft is in its life, as the composing surface reports it. */
export const CHANNEL_DRAFT_STATUSES = ['draft', 'queued', 'sent', 'failed'] as const;
export type ChannelDraftStatus = typeof CHANNEL_DRAFT_STATUSES[number];

/** One channel→profile routing rule, as a surface renders it. */
export interface ChannelRoutingRule {
  readonly id: string;
  /** ISO-8601. A string, not a number, because the wire schema says so. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly surfaceKind: string;
  readonly channelId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly profileId: string;
  readonly label?: string | undefined;
}

/** One mirrored draft. `version` is the composing surface's own schema version. */
export interface ChannelDraft {
  readonly version: number;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ChannelDraftStatus;
  readonly message: string;
  readonly title?: string | undefined;
  readonly channel?: string | undefined;
  readonly route?: string | undefined;
  /** Redacted before it ever arrives — see the module header. */
  readonly webhook?: string | undefined;
  readonly link?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly sentResponseId?: string | undefined;
  readonly sendError?: string | undefined;
}

export type ChannelSyncErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND';

export class ChannelSyncError extends Error {
  readonly code: ChannelSyncErrorCode;
  /** The input field the refusal is about, when it names one. */
  readonly field: string | undefined;

  constructor(message: string, code: ChannelSyncErrorCode, field?: string) {
    super(message);
    this.name = 'ChannelSyncError';
    this.code = code;
    this.field = field;
  }
}

/**
 * The deterministic id of a routing rule for a (surfaceKind, channelId?) key,
 * so assigning the same channel twice replaces the rule instead of
 * accumulating rows that disagree about where one channel routes.
 */
export function channelRoutingRuleId(surfaceKind: string, channelId?: string): string {
  const surface = surfaceKind.trim().toLowerCase();
  const channel = (channelId ?? '').trim();
  return channel ? `${surface}:${channel}` : surface;
}

/**
 * True when a string looks like a live webhook URL rather than a redacted
 * placeholder. Deliberately generous about what counts as redacted (anything
 * with no scheme, or an obviously masked value) and strict about what counts as
 * live: an http(s) URL is refused, whatever host it names.
 */
export function looksLikeLiveWebhook(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}
