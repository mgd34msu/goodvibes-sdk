/**
 * health.ts, email's own health entry, deliberately NOT a channel's.
 *
 * Why this is not a `ChannelStatusSnapshot` with `surface: 'email'`
 * ────────────────────────────────────────────────────────────────
 * `ManagedSurface` (channels/builtin/shared.ts) means a channel the daemon
 * TALKS TO: it carries accounts, delivery, ingress authorization, target
 * resolution and conversation routing, and every one of those is reached by
 * being a member of the union. §2.1 removes exactly those capabilities from
 * inbound mail structurally rather than by a guard, so widening the union to
 * fit email into the existing status list would hand every one of them back by
 * inheritance, the removal undone by a type edit nobody would read as a
 * capability change. `ChannelSurface` has no `'email'` member and is not
 * widened here.
 *
 * So email gets its OWN entry, shaped like a channel's so the doctor report
 * and the channel-health view can render it in the same list, and projected off
 * `ChannelStatusSnapshot` rather than restated so the two cannot drift.
 *
 * Read from the live supervisor, never from config presence
 * ────────────────────────────────────────────────────────
 * `ChannelStatusSnapshot.state` is computed today purely from whether a
 * surface is configured, `surfaceDeliveryEnabled(...) ? 'healthy' : 'disabled'`
 *, so a surface whose ingress died reports healthy because its credential is
 * still in the file. That is the pattern this function does not copy: every
 * field below comes from what the supervisor is DOING right now, and an enabled
 * mailbox that cannot be read reports `degraded`, not `healthy`.
 */

import type { ChannelStatusSnapshot } from '../../channels/types.js';
import type { InboundNoticeRefusalState } from './notice-health.js';
import type { InboundCapabilityVerdict } from './ports.js';
import type { InboundMailboxWatcherStatus } from './watcher.js';

/**
 * Email's health entry.
 *
 * `Omit<ChannelStatusSnapshot, 'surface' | 'accountId'>` keeps `id`, `label`,
 * `state`, `enabled` and `metadata` identical to a channel's by construction,
 * and drops the two fields that would be a lie: `surface` because email is not
 * a `ChannelSurface`, and `accountId` because a channel account id means a
 * provider-side identity the daemon holds a credential for. The mailbox
 * identity is named honestly instead.
 */
export type InboundMailHealthEntry = Omit<ChannelStatusSnapshot, 'surface' | 'accountId'> & {
  /** Discriminates this entry from a channel's in a mixed list. */
  readonly kind: 'email-inbound';
  /** Config account id, never an address. */
  readonly account: string;
  /** The watched mailbox or Gmail label. */
  readonly mailbox: string;
  /** What the source is doing right now, from the supervisor. */
  readonly mode: InboundMailboxWatcherStatus['mode'];
  /** Why it is in that mode, in one sentence. */
  readonly reason: string;
};

/** The live facts a health entry is built from. Supplied by the supervisor. */
export interface InboundMailHealthInput {
  readonly account: string;
  readonly mailbox: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly mode: InboundMailboxWatcherStatus['mode'];
  readonly reason: string;
  /** The last capability verdict, or null before anything has been probed. */
  readonly verdict: InboundCapabilityVerdict | null;
  /**
   * The live notice-refusal condition, or null when notices are getting
   * through. Optional so a caller that has no notion of one behaves exactly as
   * before rather than being forced to pass a lie.
   */
  readonly noticeRefusal?: InboundNoticeRefusalState | null | undefined;
}

/**
 * Which of the three channel-health states an inbound mailbox is in.
 *
 * `disabled` is reserved for "the owner switched it off". An enabled mailbox
 * that cannot be read is `degraded` and never `disabled`, because `disabled`
 * reads as a choice and this is a fault, that distinction is the entire
 * reason this function exists rather than a config lookup.
 *
 * A mailbox being READ but whose notices are all being refused is `degraded`
 * too, and that arm is the one that was missing. Every input above describes
 * the connection to the mail server, and all of them were satisfied while the
 * capability delivered nothing: the watcher was connected, the capability
 * verdict was healthy, the loop was running, and every message it found was
 * recorded and announced to nobody. `healthy` has to mean the capability is
 * doing its job, not that its socket is open.
 */
function healthState(input: InboundMailHealthInput): ChannelStatusSnapshot['state'] {
  if (!input.enabled) return 'disabled';
  if (input.noticeRefusal) return 'degraded';
  if (input.verdict?.state === 'healthy' && input.running) return 'healthy';
  return 'degraded';
}

/** Build email's health entry from live supervisor state. */
export function describeInboundMailHealth(
  input: InboundMailHealthInput,
): InboundMailHealthEntry {
  return {
    kind: 'email-inbound',
    id: `email-inbound:${input.account}:${input.mailbox}`,
    label: `Email (inbound), ${input.account}`,
    state: healthState(input),
    enabled: input.enabled,
    account: input.account,
    mailbox: input.mailbox,
    mode: input.mode,
    reason: input.reason,
    metadata: {
      running: input.running,
      mode: input.mode,
      capabilityState: input.verdict?.state ?? null,
      capabilityReason: input.verdict?.reason ?? null,
      capabilityDetail: input.verdict?.detail ?? null,
      capabilityFix: input.verdict?.fix ?? null,
      // Named separately from the capability fields because it is a different
      // fault with a different fix: the capability ones are about reading the
      // mailbox, these are about telling the owner what was read.
      noticeRefusedReason: input.noticeRefusal?.reason ?? null,
      noticeRefusedFix: input.noticeRefusal?.fix ?? null,
      noticeRefusedSince: input.noticeRefusal?.since ?? null,
      unannouncedMessages: input.noticeRefusal?.unannounced ?? 0,
    },
  };
}
