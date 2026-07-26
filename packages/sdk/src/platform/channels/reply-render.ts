/**
 * Rendering for channel replies: runtime event -> render event -> message body.
 *
 * Split out of reply-pipeline.ts so the pipeline holds the delivery decisions
 * (what to send, when, once) and this module holds the text decisions (what a
 * given surface is allowed to show, and how it reads).
 */
import type { RuntimeEventEnvelope, AnyRuntimeEvent } from '../runtime/events/index.js';
import { splitInlineReasoning } from '../providers/inline-reasoning.js';
import { stripProseCompletionReport } from './completion-report-prose.js';
import type {
  ChannelRenderEvent,
  ChannelRenderPhase,
  ChannelRenderPolicy,
  ChannelReasoningVisibility,
} from './types.js';

export function trimText(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * The human summary of an agent completion report, or null if this is not one.
 *
 * Keyed off the report's OWN discriminators — `version: 1` plus a non-empty
 * `archetype` (see agents/completion-report.ts) — never off "this text looks
 * like JSON", so an answer that legitimately is JSON is left untouched.
 */
function readCompletionReportSummary(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const report = value as Record<string, unknown>;
  if (report['version'] !== 1) return null;
  const archetype = report['archetype'];
  if (typeof archetype !== 'string' || archetype.trim().length === 0) return null;
  const summary = typeof report['summary'] === 'string' ? report['summary'].trim() : '';
  if (summary.length > 0) return summary;
  const result = typeof report['result'] === 'string' ? report['result'].trim() : '';
  if (result.length > 0) return result;
  return `${archetype.trim()} finished.`;
}

interface CompletionReportSpan {
  readonly start: number;
  readonly end: number;
  readonly summary: string;
}

/**
 * Locate a completion-report payload inside a body, as a character span.
 *
 * Mirrors the two extraction strategies agents/completion-report.ts uses to
 * READ the report (fenced ```json block, then brace-counting from `"version"`)
 * so the channel recognises exactly what the WRFC controller recognises.
 */
function findCompletionReportSpan(text: string): CompletionReportSpan | null {
  const fenced = /```json\s*\n(\{[\s\S]*?\})\s*\n```/.exec(text);
  if (fenced?.[1]) {
    const summary = readCompletionReportSummary(safeParseJson(fenced[1]));
    if (summary !== null) {
      return { start: fenced.index, end: fenced.index + fenced[0].length, summary };
    }
  }
  const versionIdx = text.indexOf('"version"');
  if (versionIdx === -1) return null;
  let open = -1;
  for (let i = versionIdx - 1; i >= 0; i -= 1) {
    if (text[i] === '{') {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth !== 0) continue;
      const summary = readCompletionReportSummary(safeParseJson(text.slice(open, i + 1)));
      return summary === null ? null : { start: open, end: i + 1, summary };
    }
  }
  return null;
}

/** Bounded so a summary that itself contains `"version"` cannot loop. */
const MAX_COMPLETION_REPORT_REWRITES = 4;

/**
 * Replace any agent completion report with the summary it carries.
 *
 * The report is an internal contract between an agent and the WRFC controller.
 * It belongs in the transcript, so only the report SPAN is rewritten — prose
 * written around it survives intact.
 *
 * BOTH forms are handled, because the report reached the owner's phone in both:
 * once as `{"version":1,"archetype":"engineer",...}`, and again — after that
 * was fixed — as the prose form the base agent prompt asks for, a filled-in
 * `Summary: / Changes: / Decisions:` template with `Changes: None` under a
 * greeting. The prose half lives in completion-report-prose.ts.
 *
 * The JSON pass runs first: a report can carry BOTH (prose sections above, a
 * fenced JSON block below), and the JSON pass would otherwise be handed text
 * the prose pass had already truncated.
 */
export function renderWithoutCompletionReport(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_COMPLETION_REPORT_REWRITES; pass += 1) {
    const span = findCompletionReportSpan(out);
    if (!span) break;
    out = `${out.slice(0, span.start)}${span.summary}${out.slice(span.end)}`;
  }
  return stripProseCompletionReport(out).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Apply the surface's reasoning policy to assistant text that has reasoning
 * baked into it.
 *
 * Backstop for reasoning a provider inlined in the assistant message rather
 * than sending it on a reasoning field. openai-compat splits that at the wire
 * (providers/inline-reasoning.ts) so it arrives as a `reasoning` event, which
 * `eventLine` already governs. This covers what that fix cannot reach: a
 * provider path not yet taught the wire format, whose reasoning would
 * otherwise land verbatim in an ntfy or telephony body — surfaces whose whole
 * policy is `reasoningVisibility: 'suppress'`. Applied here, one place, for
 * every channel surface; no surface re-solves it.
 *
 * `public` is the only visibility that keeps the text as sent, since it is the
 * only one that would have rendered the reasoning anyway.
 */
function assistantTextForVisibility(text: string, reasoningVisibility: ChannelReasoningVisibility): string {
  if (reasoningVisibility === 'public') return text;
  const split = splitInlineReasoning(text);
  if (split.reasoning.length === 0) return text;
  if (split.content.length === 0) {
    // The whole message was reasoning. `summary` still owes the reader
    // something, so it gets a bounded excerpt rather than an empty body;
    // `suppress` and `private` get nothing, which is what they asked for.
    return reasoningVisibility === 'summary' ? `Reasoning: ${trimText(split.reasoning, 220)}` : '';
  }
  return split.content;
}

/**
 * Ceiling for a status arriving as a render EVENT rather than as an explicit
 * progress line. Looser than the progress ceiling because WRFC chain lines
 * legitimately quote a task summary; the surface policy trims the final body.
 */
const MAX_EVENT_STATUS_CHARS = 400;

export function eventLine(event: ChannelRenderEvent, reasoningVisibility: ChannelReasoningVisibility): string | null {
  switch (event.kind) {
    case 'assistant_text': {
      if (!event.text?.trim()) return null;
      const body = assistantTextForVisibility(event.text, reasoningVisibility);
      if (!body.trim()) return null;
      const rendered = renderWithoutCompletionReport(body);
      return rendered.length > 0 ? rendered : null;
    }
    case 'reasoning':
      if (reasoningVisibility === 'suppress') return null;
      if (!event.text?.trim()) return null;
      return reasoningVisibility === 'summary'
        ? `Reasoning: ${trimText(event.text, 220)}`
        : `Reasoning: ${event.text.trim()}`;
    case 'tool_start':
      return event.toolName ? `Tool started: ${event.toolName}` : event.text ?? null;
    case 'tool_result':
      return event.toolName
        ? `${event.text?.startsWith('Failed') ? 'Tool failed' : 'Tool finished'}: ${event.toolName}${event.summary ? ` (${event.summary})` : ''}`
        : event.text ?? null;
    case 'plan':
      return event.text ? `Plan: ${event.text}` : null;
    case 'approval':
      return event.text ? `Approval: ${event.text}` : null;
    case 'command_output':
      return event.text ? `Command output: ${event.text}` : null;
    case 'patch':
      return event.text ? `Patch: ${event.text}` : null;
    case 'compaction':
      return event.text ? `Compaction: ${event.text}` : null;
    case 'model':
      return event.provider || event.model
        ? `Model: ${[event.provider, event.model].filter(Boolean).join(' / ')}`
        : event.text ?? null;
    case 'status':
      // Same placeholder rule as an explicit progress line. `AgentRecord.progress`
      // reaches a surface by BOTH routes — handed to deliverProgress by the
      // daemon's poller, and republished as an AGENT_PROGRESS runtime event —
      // so filtering only the first route would leave the second one shipping
      // "Turn 1 · Thinking…" exactly as before.
      return event.text ? channelStatusLine(event.text, MAX_EVENT_STATUS_CHARS) : null;
    case 'error':
      return event.text ? `Error: ${event.text}` : null;
  }
}

/**
 * The hard ceiling on a progress status line. A status line is one short
 * phrase — "Read(src/parse.ts)", "Network error, retrying in 5s…" — so this is
 * a backstop, not a budget to fill.
 */
const MAX_PROGRESS_STATUS_CHARS = 160;

/**
 * The turn counter the orchestrator prefixes to every progress line
 * ("Turn 3 · Read(src/parse.ts)").
 *
 * Kept for operator surfaces, removed here. Which turn an agent is on is a
 * fact about the machine, not about the work: nobody reading a phone can do
 * anything with it, and it changes on every tick, which is exactly what
 * defeats the identical-body suppression and turns one exchange into a stack
 * of notifications.
 */
const TURN_COUNTER_PREFIX = /^turn\s+\d+\s*(?:[·:•\-–—]\s*)?/i;

/**
 * Status text that says only that the machine is running.
 *
 * Owner ruling: never emit a placeholder that carries no information a person
 * can act on — if the only thing you have to say is that a turn started, say
 * nothing. `Turn 1 · Thinking…` is both halves of that at once, and it was the
 * single most-delivered notification body on the owner's phone.
 */
const CONTENTLESS_STATUS = /^(?:thinking|working|processing|starting|started|running|in progress|please wait|waiting|busy)\b[\s.…!]*$/i;

/**
 * Reduce whatever the caller passed as progress to ONE bounded line a person
 * can act on, or null when it says nothing.
 *
 * Newlines are collapsed rather than kept, which is what makes this safe by
 * construction: a caller who wrongly hands over accumulating content cannot
 * turn a progress notification into a growing transcript, because the result
 * is always a single bounded line whose head is stable — so the pipeline's
 * identical-body check suppresses the repeat instead of shipping it.
 *
 * Callers must still pass a STATUS ("what is happening now"), never content:
 * `AgentRecord.progress` is exactly that, and `streamingContent` is not.
 */
export function channelStatusLine(rawText: string, maxChars = MAX_PROGRESS_STATUS_CHARS): string | null {
  const collapsed = rawText.replace(/\s+/g, ' ').trim().replace(TURN_COUNTER_PREFIX, '').trim();
  if (!collapsed) return null;
  if (CONTENTLESS_STATUS.test(collapsed)) return null;
  return trimText(collapsed, maxChars);
}

function progressStatusLine(explicitText: string, policy: ChannelRenderPolicy): string | null {
  return channelStatusLine(explicitText, Math.min(MAX_PROGRESS_STATUS_CHARS, policy.maxChunkChars));
}

export function buildRenderedText(
  explicitText: string,
  events: readonly ChannelRenderEvent[],
  policy: ChannelRenderPolicy,
  phase: ChannelRenderPhase,
): string {
  if (phase === 'final' && explicitText.trim().length > 0) {
    // The final body is the explicit text, so it never passes through
    // `eventLine` — the reasoning policy has to be applied to it here or a
    // suppressed surface receives the model's reasoning as the answer.
    const visible = assistantTextForVisibility(explicitText, policy.reasoningVisibility);
    if (visible.trim().length > 0) {
      return trimText(renderWithoutCompletionReport(visible), policy.maxChunkChars);
    }
  }
  // A partial answer is not progress. Streaming `assistant_text` fragments into
  // progress notifications is what made each notification a superset of the one
  // before it: the reader watched the answer typed out in pieces and then
  // received the whole thing again in the final. Progress carries what the
  // agent is DOING; the final carries what it SAID, complete, exactly once.
  //
  // This used to be an ntfy-only rule that ALSO covered the final phase, which
  // is what left the owner with "Agent completed in Nms" and never the reply.
  // Reasoning is not special-cased here at all — `reasoningVisibility` already
  // decides it, and ntfy's policy suppresses it.
  const renderableEvents = phase === 'final'
    ? events
    : events.filter((event) => event.kind !== 'assistant_text');
  const eventLines = renderableEvents
    .slice(-policy.maxEventsPerUpdate)
    .map((event) => eventLine(event, policy.reasoningVisibility))
    .filter((line): line is string => Boolean(line && line.trim().length > 0));
  // The status line is what the agent is doing RIGHT NOW, so it reads last —
  // the newest thing on a lock screen. On the progress phase this is the only
  // use of explicitText; it used to be dropped on the floor here, which is why
  // `AgentRecord.progress` reached no notification body on any surface.
  const status = phase === 'progress' ? progressStatusLine(explicitText, policy) : null;
  const lines = status ? [...eventLines, status] : eventLines;
  const deduped = lines.filter((line, index) => lines.indexOf(line) === index);
  return trimText(deduped.join('\n'), policy.maxChunkChars);
}

function baseMetadata(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    runtimeType: envelope.type,
    traceId: envelope.traceId,
    source: envelope.source,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
  };
}

function renderEvent(
  kind: ChannelRenderEvent['kind'],
  phase: ChannelRenderPhase,
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  extras: Partial<ChannelRenderEvent> = {},
): ChannelRenderEvent {
  return {
    id: `${envelope.traceId}:${kind}:${envelope.ts}`,
    kind,
    phase,
    ts: envelope.ts,
    metadata: baseMetadata(envelope),
    ...extras,
  };
}

export function normalizeChannelRenderEventFromRuntime(
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
): ChannelRenderEvent[] {
  const payload = envelope.payload;
  switch (payload.type) {
    case 'AGENT_STREAM_DELTA':
      return payload.content.trim().length > 0
        ? [renderEvent('assistant_text', 'progress', envelope, { text: payload.content })]
        : [];
    case 'AGENT_PROGRESS':
      return payload.progress.trim().length > 0
        ? [renderEvent('status', 'progress', envelope, { text: payload.progress })]
        : [];
    case 'AGENT_COMPLETED':
      // The answer, and nothing else.
      //
      // This used to ALSO emit `Agent completed in ${durationMs}ms`, which the
      // pipeline appended under the reply on every completion — operator
      // telemetry pushed to a phone, and the source of the duplicate
      // completion line under every answer. It stays in the activity log and
      // on operator surfaces, which read the runtime event directly.
      //
      // A completion with NO output still emits one final-phase event, and
      // that event carries no text on purpose. Owner ruling: work with nothing
      // to report reports nothing — silence is the correct outcome, not a
      // bare "Done." A textless event renders to an empty body, which the
      // pipeline closes the run out on WITHOUT notifying anyone; an empty
      // event LIST would instead leave the pipeline never told the run ended.
      // (A run that owes a person an answer never reaches here empty: the
      // agent runtime regenerates it and, failing that, substitutes a plain
      // notice — agents/conversational-reply-recovery.ts.)
      return payload.output?.trim()
        ? [renderEvent('assistant_text', 'final', envelope, { text: payload.output })]
        : [renderEvent('status', 'final', envelope)];
    case 'AGENT_FAILED':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    case 'AGENT_CANCELLED':
      return [renderEvent('status', 'final', envelope, { text: payload.reason ? `Cancelled: ${payload.reason}` : 'Cancelled' })];
    case 'STREAM_DELTA': {
      const events: ChannelRenderEvent[] = [];
      if (payload.content.trim().length > 0) {
        events.push(renderEvent('assistant_text', 'progress', envelope, { text: payload.content }));
      }
      if (payload.reasoning?.trim()) {
        events.push(renderEvent('reasoning', 'progress', envelope, { text: payload.reasoning }));
      }
      return events;
    }
    case 'TOOL_EXECUTING':
      return [renderEvent('tool_start', 'progress', envelope, { toolName: payload.tool, text: payload.tool })];
    case 'TOOL_SUCCEEDED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Succeeded',
        summary: `${payload.durationMs}ms`,
      })];
    case 'TOOL_FAILED':
      return [renderEvent('tool_result', 'progress', envelope, {
        toolName: payload.tool,
        text: 'Failed',
        summary: payload.error,
      })];
    case 'PLAN_STRATEGY_SELECTED':
      return [renderEvent('plan', 'progress', envelope, {
        text: `Selected ${payload.selected} (${payload.reasonCode})${payload.inputs.taskDescription ? ` for ${payload.inputs.taskDescription}` : ''}`,
      })];
    case 'PLAN_STRATEGY_OVERRIDDEN':
      return [renderEvent('plan', 'progress', envelope, {
        text: payload.strategy ? `Overridden to ${payload.strategy}` : 'Planner override cleared',
      })];
    case 'PERMISSION_REQUESTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: payload.summary ?? `Permission requested for ${payload.tool}`,
      })];
    case 'DECISION_EMITTED':
      return [renderEvent('approval', 'progress', envelope, {
        text: `${payload.approved ? 'Approved' : 'Denied'} ${payload.tool}`,
      })];
    case 'MODEL_FALLBACK':
      return [renderEvent('model', 'progress', envelope, {
        provider: payload.provider,
        model: `${payload.from} -> ${payload.to}`,
      })];
    case 'COMPACTION_RECEIPT':
      return [renderEvent(payload.outcome === 'applied' ? 'compaction' : 'error', 'progress', envelope, {
        text: `compaction ${payload.outcome}: ${payload.tokensBefore}->${payload.tokensAfter} tokens, quality ${payload.qualityGrade}${payload.detail ? ` — ${payload.detail}` : ''}`,
      })];
    case 'COMPACTION_CHECK':
    case 'COMPACTION_MICROCOMPACT':
    case 'COMPACTION_COLLAPSE':
    case 'COMPACTION_AUTOCOMPACT':
    case 'COMPACTION_REACTIVE':
    case 'COMPACTION_DONE':
    case 'COMPACTION_FAILED':
    case 'COMPACTION_RESUME_REPAIR':
    case 'COMPACTION_QUALITY_SCORE':
    case 'COMPACTION_STRATEGY_SWITCH':
      return [renderEvent(payload.type === 'COMPACTION_FAILED' ? 'error' : 'compaction', 'progress', envelope, {
        text: payload.type.replace(/^COMPACTION_/, '').toLowerCase().replace(/_/g, ' '),
      })];
    case 'WORKFLOW_CHAIN_CREATED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} started: ${trimText(payload.task, 180)}`,
      })];
    case 'WORKFLOW_STATE_CHANGED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} moved from ${payload.from} to ${payload.to}`,
      })];
    case 'WORKFLOW_REVIEW_COMPLETED': {
      const constraintSummary = typeof payload.constraintsSatisfied === 'number' && typeof payload.constraintsTotal === 'number'
        ? `, constraints ${payload.constraintsSatisfied}/${payload.constraintsTotal}`
        : '';
      return [renderEvent(payload.passed ? 'status' : 'error', 'progress', envelope, {
        text: `WRFC review ${payload.passed ? 'passed' : 'needs fixes'}: score ${payload.score}/10${constraintSummary}`,
      })];
    }
    case 'WORKFLOW_FIX_ATTEMPTED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC fix attempt ${payload.attempt}/${payload.maxAttempts} started`,
      })];
    case 'WORKFLOW_GATE_RESULT':
      return [renderEvent(payload.passed ? 'status' : 'error', 'progress', envelope, {
        text: `WRFC gate ${payload.gate} ${payload.passed ? 'passed' : 'failed'}`,
      })];
    case 'WORKFLOW_AUTO_COMMITTED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC changes committed${payload.commitHash ? `: ${payload.commitHash}` : ''}`,
      })];
    case 'WORKFLOW_SCORE_REGRESSION':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC score regression warning: ${payload.reason}`,
      })];
    case 'WORKFLOW_CASCADE_ABORTED':
      return [renderEvent('error', 'progress', envelope, {
        text: `WRFC cascade warning: ${payload.reason}`,
      })];
    case 'WORKFLOW_CONSTRAINTS_ENUMERATED':
      return [renderEvent('status', 'progress', envelope, {
        text: `WRFC constraints enumerated: ${payload.constraints.length}`,
      })];
    case 'WORKFLOW_CHAIN_PASSED':
      return [renderEvent('status', 'final', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} passed`,
      })];
    case 'WORKFLOW_CHAIN_FAILED':
      return [renderEvent('error', 'final', envelope, {
        text: `WRFC chain ${payload.chainId.slice(0, 12)} failed: ${payload.reason}`,
      })];
    case 'TURN_COMPLETED':
      return payload.response.trim().length > 0
        ? [renderEvent('assistant_text', 'final', envelope, { text: payload.response })]
        : [];
    case 'TURN_ERROR':
      return [renderEvent('error', 'final', envelope, { text: payload.error })];
    default:
      return [];
  }
}
