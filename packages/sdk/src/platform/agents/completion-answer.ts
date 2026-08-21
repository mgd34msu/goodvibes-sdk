/**
 * completion-answer.ts, what a finished agent SAYS, as opposed to what it did.
 *
 * One rule, in one place, because two processes now need it. The daemon renders
 * it when its own completion poll finds a finished run (daemon/surface-delivery.ts).
 * A surface renders it when a run IT was dispatched finishes, so it can report
 * the answer back over `sessions.inputs.deliver` and have the daemon deliver it
 * to the conversation the message came from. Two copies of this rule would mean
 * the same agent's answer read differently depending on which process happened
 * to run it.
 */

/** The fields of an agent record this rule reads. Any agent register satisfies it. */
export interface AgentCompletionRecordView {
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly fullOutput?: string | undefined;
  readonly streamingContent?: string | undefined;
  readonly error?: string | undefined;
  readonly wrfcId?: string | undefined;
}

/**
 * The answer to send for a finished run.
 *
 * A completed run says what it produced. Nothing produced is silence, the
 * owner ruling is that work with nothing to report says nothing, and an empty
 * body closes the run out without notifying anyone. The one exception is a
 * write-review-fix-confirm chain still in flight, which is a fact the reader is
 * owed because more messages are coming.
 *
 * `progress` is deliberately never a fallback: it is a status line
 * ("Turn 3 · Read(src/parse.ts)"), and a status line is not an outcome.
 */
export function renderAgentCompletionAnswer(record: AgentCompletionRecordView): string {
  if (record.status === 'completed') {
    const answer = (record.fullOutput ?? record.streamingContent ?? '').trim();
    if (answer) return answer;
    // A run that owes a PERSON an answer cannot arrive here empty: the agent
    // runtime regenerates the reply once and then substitutes a plain notice
    // (agents/conversational-reply-recovery.ts), so `answer` is set above.
    const wrfcId = typeof record.wrfcId === 'string' ? record.wrfcId.trim() : '';
    return wrfcId ? 'Finished the first pass. Review, fix, and gate updates will follow here.' : '';
  }
  return String(record.error ?? record.status);
}
