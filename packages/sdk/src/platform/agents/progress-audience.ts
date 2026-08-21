/**
 * progress-audience.ts, who a progress line is written for.
 *
 * The defect this exists to fix: the owner messaged the bot on Telegram and
 * received these, as chat messages, in the middle of the exchange:
 *
 *     registry, email send
 *     fetch, standard
 *     find
 *     exec, standard
 *
 * That is `AgentRecord.progress`. The orchestrator maintains it as one short
 * line naming the tool it is running and a scrap of that tool's arguments
 * (`orchestrator-runner.ts`: `Turn ${turn} · ${call.name}${summarizeToolArgs}`),
 * and two separate routes carried it to the channel: the daemon's poller handed
 * the raw string to `deliverProgress`, and the same string was republished as an
 * `AGENT_PROGRESS` runtime event which the channel renderer turned into a
 * `status` line. The channel's status renderer strips the `Turn 3 · ` prefix, so
 * what landed on the phone was the bare tool name and its argument summary,
 * tool-selection diagnostics, delivered as if they were the assistant speaking.
 *
 * The line itself is not wrong. It is exactly right for an operator surface: the
 * TUI's activity sidebar and the fleet transcript want to see which tool is
 * running. What was missing is any statement of WHO it was written for, so
 * every consumer that could render a string rendered it.
 *
 * So progress carries an audience, and the rule is one sentence:
 *
 *   `operator` progress never leaves the machine. Only `owner` progress may be
 *   rendered into a reply on a channel.
 *
 * The default is `operator`, deliberately. A new progress line someone adds
 * without thinking about this file is invisible to the owner's phone rather
 * than shipped to it, and the failure mode of forgetting is a missing operator
 * detail rather than a leak. Opting a line IN is a decision someone makes on
 * purpose, at the call site, and it is greppable.
 */

/** Who a progress line was written for. */
export type ProgressAudience =
  /** The person in the conversation. May be rendered into a channel reply. */
  | 'owner'
  /** Whoever is watching the machine work. Operator surfaces only, never a channel. */
  | 'operator';

/**
 * What an unmarked progress line counts as.
 *
 * `operator`, so that forgetting to classify cannot leak. See the header.
 */
export const DEFAULT_PROGRESS_AUDIENCE: ProgressAudience = 'operator';

/** Resolve a possibly-absent audience to the deny-by-default answer. */
export function resolveProgressAudience(audience: ProgressAudience | undefined): ProgressAudience {
  return audience ?? DEFAULT_PROGRESS_AUDIENCE;
}

/** True when this progress line may be rendered into a reply on a channel. */
export function isOwnerFacingProgress(audience: ProgressAudience | undefined): boolean {
  return resolveProgressAudience(audience) === 'owner';
}

/**
 * The minimum a record needs for progress to be set on it. Structural rather
 * than a nominal `AgentRecord` import so this module stays dependency-free and
 * the WRFC controller's own record shapes can use it too.
 */
export interface ProgressBearingRecord {
  progress?: string | undefined;
  progressAudience?: ProgressAudience | undefined;
}

/**
 * Set a progress line and its audience together.
 *
 * The two fields are only correct as a pair: a line whose audience says
 * `owner` while the text is a tool trace is the original defect, and a line
 * whose text changed while a stale `owner` audience stayed behind is the same
 * defect with an extra step. Assigning `record.progress` directly leaves the
 * audience behind; this does not, so it is the only supported way to set it.
 */
export function setAgentProgress(
  record: ProgressBearingRecord,
  progress: string,
  audience: ProgressAudience,
): void {
  record.progress = progress;
  record.progressAudience = audience;
}
