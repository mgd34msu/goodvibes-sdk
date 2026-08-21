/**
 * render-audience.ts, the one gate between machine diagnostics and a reply.
 *
 * The owner received these as Telegram messages, interleaved with an exchange
 * he was having with the bot:
 *
 *     registry, email send
 *     fetch, standard
 *     find
 *     exec, standard
 *
 * Every one of those is a tool-selection diagnostic. They reached him because
 * `eventLine()` in reply-render.ts renders a `ChannelRenderEvent` by KIND, and
 * every kind had a rendering, including `tool_start`, `tool_result` and the
 * `status` line built from `AgentRecord.progress`, which the orchestrator fills
 * with the running tool's name and a scrap of its arguments.
 *
 * Kind answers "what is this". It never answered "is this for the person in the
 * conversation", so nothing could refuse to render it, and the class of leak was
 * not one channel's bug: the same renderer serves ntfy, Discord, Slack, Signal,
 * Matrix, Teams, the web UI and the TUI's channel-delivered replies. One of
 * them showing this meant all of them would.
 *
 * So a render event carries an audience, and `eventLine()` refuses anything that
 * is not the owner's. There is exactly one place to change that decision, and
 * this is it.
 *
 * The default per kind DENIES. A new render event kind is operator-only until
 * someone adds it to `OWNER_FACING_RENDER_EVENT_KINDS` on purpose, so the cost
 * of forgetting is an operator detail the owner never sees, not a diagnostic
 * pushed to his lock screen.
 */

import type { ChannelRenderEventKind } from './types.js';

/** Who a rendered line is written for. */
export type ChannelRenderAudience =
  /** The person in the conversation. May be delivered on a channel. */
  | 'owner'
  /** Whoever is watching the machine work. Operator surfaces only. */
  | 'operator';

/**
 * Kinds that are the owner's by nature.
 *
 * - `assistant_text`, what the agent said. The reply itself.
 * - `reasoning`     , the model's own words about its answer; each surface's
 *                      `reasoningVisibility` policy still decides how much of
 *                      it shows, and `suppress` still means none.
 * - `error`         , a failure the person asked for work is owed.
 * - `approval`      , a request that only they can answer.
 *
 * Everything else is machine telemetry: which tool ran, what the planner
 * picked, how compaction went, which model took over. Real and worth keeping,
 * on an operator surface, which reads the runtime events directly.
 *
 * `status` is deliberately NOT here. It is the kind the leak arrived as, and
 * whether a given status line is the owner's depends on where it came from, not
 * on its kind, so its audience is stamped at the point the runtime event is
 * normalized (see `normalizeChannelRenderEventFromRuntime`) rather than assumed
 * here.
 */
export const OWNER_FACING_RENDER_EVENT_KINDS: ReadonlySet<ChannelRenderEventKind> = new Set<ChannelRenderEventKind>([
  'assistant_text',
  'reasoning',
  'error',
  'approval',
]);

/** What an unmarked event of this kind counts as. Denies unless listed above. */
export function defaultRenderAudienceForKind(kind: ChannelRenderEventKind): ChannelRenderAudience {
  return OWNER_FACING_RENDER_EVENT_KINDS.has(kind) ? 'owner' : 'operator';
}

/**
 * The audience an event actually has: its own stamp, or the kind's default.
 *
 * Events built outside this package (a channel plugin, a test fixture, an older
 * caller) carry no stamp, and they get the kind default, which denies for
 * everything the leak travelled as.
 */
export function resolveRenderAudience(event: {
  readonly kind: ChannelRenderEventKind;
  readonly audience?: ChannelRenderAudience | undefined;
}): ChannelRenderAudience {
  return event.audience ?? defaultRenderAudienceForKind(event.kind);
}

/** True when this event may be rendered into a reply delivered on a channel. */
export function isOwnerFacingRenderEvent(event: {
  readonly kind: ChannelRenderEventKind;
  readonly audience?: ChannelRenderAudience | undefined;
}): boolean {
  return resolveRenderAudience(event) === 'owner';
}
