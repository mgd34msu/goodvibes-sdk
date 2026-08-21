/**
 * What to do when a run that owes a person an answer produces nothing.
 *
 * Owner ruling: "if it is truly worthy of silence then let it be silence.
 * otherwise, i generally expect a conversation to have a response."
 *
 * That splits cleanly in two, and this module owns the conversational half:
 *
 * - A CONVERSATIONAL run that ends with empty output is a DEFECT, not an
 *   outcome. Somebody sent a message and is waiting. The model gets one more
 *   attempt at an answer; if that also comes back empty, the person is told
 *   plainly that no reply was generated. Never a bare acknowledgement, never
 *   silence.
 * - A BACKGROUND run (a schedule, a trigger, agreed work) with nothing to
 *   report is silence, and that half needs no code here, it is the absence of
 *   a notification (channels/reply-pipeline.ts).
 *
 * The retry is bounded at ONE, and the bound is derived from the conversation
 * itself rather than from a counter: the request this module appends is its
 * own record that the attempt was already spent. A second empty response after
 * that reaches the notice, so a model that returns nothing forever costs one
 * extra turn, not a loop.
 */
import type { AgentRecord } from '../tools/agent/index.js';
import { setAgentProgress } from './progress-audience.js';

/**
 * What the person receives when the model produced nothing twice.
 *
 * Plain language, first person, no error code and no agent id: the reader is
 * someone who sent a message, and what they need to know is that the silence
 * is a fault on this side rather than an answer.
 */
export const CONVERSATIONAL_EMPTY_REPLY_NOTICE =
  'No reply was generated, something went wrong on my side.';

/**
 * The re-prompt. Deliberately concrete about what went wrong and what is
 * wanted, and identical every time so {@link regenerationAlreadySpent} can
 * recognise it.
 */
export const CONVERSATIONAL_REGENERATION_REQUEST =
  'Your last message was empty, so the person you are talking to received nothing. Answer their message now, in plain sentences.';

/** How long a final answer may be when reused as the operator status line. */
const MAX_PROGRESS_FROM_ANSWER = 200;

/** A conversation, structurally, only what this module touches. */
export interface RecoveryConversation {
  addAssistantMessage(content: string, options?: { usage?: unknown }): void;
  addUserMessage(content: string): void;
  getMessageSnapshot(): ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
}

/** A model response at the point the turn loop decides the run is finished. */
export interface RecoveryResponse {
  readonly content: string;
  readonly usage?: unknown;
}

/** True when this run's final message is a reply to a person. */
export function isConversationalRun(record: Pick<AgentRecord, 'replyStyle'>): boolean {
  return record.replyStyle === 'conversational';
}

/** True when the one allowed regeneration was already requested this run. */
function regenerationAlreadySpent(conversation: RecoveryConversation): boolean {
  return conversation.getMessageSnapshot().some(
    (message) => message.role === 'user' && message.content === CONVERSATIONAL_REGENERATION_REQUEST,
  );
}

/**
 * Record the model's final message, and report whether the turn loop should
 * keep going.
 *
 * Returns true in exactly one case: a conversational run whose answer is empty
 * and whose one regeneration is unspent. Every other case ends the run, which
 * is what the loop did unconditionally before this existed.
 *
 * `record.progress` is set from the answer ONLY when there is an answer. It
 * used to fall back to a hardcoded 'Done.', which is a status line that says
 * nothing and, once progress reached channel surfaces, could be published as
 * though it were the reply.
 */
export function completeOrRegenerate(
  record: AgentRecord,
  conversation: RecoveryConversation,
  response: RecoveryResponse,
): boolean {
  conversation.addAssistantMessage(response.content, { usage: response.usage });
  record.fullOutput = response.content;
  if (response.content.trim().length > 0) {
    // OPERATOR. This is a truncated copy of the ANSWER, kept so an operator
    // surface can show what the agent settled on. The reader gets the real
    // thing, complete and once, as `fullOutput` in the final message, a
    // partial answer delivered as progress is what made every notification a
    // superset of the one before it. See agents/progress-audience.ts.
    setAgentProgress(record, response.content.slice(0, MAX_PROGRESS_FROM_ANSWER), 'operator');
    return false;
  }
  if (!isConversationalRun(record) || regenerationAlreadySpent(conversation)) return false;
  conversation.addUserMessage(CONVERSATIONAL_REGENERATION_REQUEST);
  // OWNER. Someone waiting on a reply is owed the reason it is taking a
  // second pass.
  setAgentProgress(record, 'The reply came back empty; answering again…', 'owner');
  return true;
}

/**
 * Last stop before a completed run is reported: a conversational run that
 * still has nothing to say says so.
 *
 * Applied at the single completion funnel rather than at the end of the turn
 * loop, so it also covers the runs that finish some other way, a turn budget
 * exhausted mid-answer, a loop that broke early, where the regeneration above
 * never had a chance to fire and the person would otherwise get silence.
 *
 * A no-op for every non-conversational run: work with nothing to report is
 * allowed to report nothing.
 */
export function recoverEmptyConversationalReply(record: AgentRecord): void {
  if (!isConversationalRun(record)) return;
  if ((record.fullOutput ?? '').trim().length > 0) return;
  record.fullOutput = CONVERSATIONAL_EMPTY_REPLY_NOTICE;
  // The notice reaches the reader as `fullOutput`; this is the operator mirror.
  setAgentProgress(record, CONVERSATIONAL_EMPTY_REPLY_NOTICE, 'operator');
}
