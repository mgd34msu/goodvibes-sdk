/**
 * orchestrator-live-turn.ts — per-call cancellation registry and queued-message
 * editing for the live turn.
 *
 * Two small interaction wins the Orchestrator delegates here:
 * - ToolCallAbortRegistry: one AbortController per in-flight tool call, so ONE
 *   running call can be cancelled (structured "cancelled by user" result, turn
 *   continues) without touching the whole-turn abort or sibling calls. The
 *   registry itself is the `toolCallSignals` seam executeToolCalls consumes.
 * - Queued-message list/edit/delete: the mid-turn message queue was push/shift
 *   only; entries now carry ids and stay editable/deletable until delivered.
 */

/** One pending mid-turn message (the Orchestrator.messageQueue element shape). */
export interface QueuedMessageEntry {
  id: string;
  queuedAt: number;
  text: string;
  content?: unknown;
  options?: unknown;
}

/** Per-tool-call abort controllers for calls currently in flight. */
export class ToolCallAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Open a per-call signal (registers the call as cancellable). */
  open(callId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(callId, controller);
    return controller.signal;
  }

  /** Retire a settled call. */
  close(callId: string): void {
    this.controllers.delete(callId);
  }

  /** Cancel ONE in-flight call. False when no such call is running. */
  cancel(callId: string): boolean {
    const controller = this.controllers.get(callId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** The callIds currently in flight. */
  list(): readonly string[] {
    return [...this.controllers.keys()];
  }

  /** Abort every in-flight call (the whole-turn abort path) and clear. */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

/** The pending queue in delivery order (undelivered messages only). */
export function listQueuedMessages(
  queue: readonly QueuedMessageEntry[],
): ReadonlyArray<{ id: string; queuedAt: number; text: string }> {
  return queue.map((entry) => ({ id: entry.id, queuedAt: entry.queuedAt, text: entry.text }));
}

/**
 * Replace the text of a still-queued message. False when the id is no longer
 * queued (already delivered — delivered messages are immutable) or the new
 * text is blank. Editing clears multimodal content: the edited plain text is
 * what will be delivered.
 */
export function editQueuedMessage(queue: QueuedMessageEntry[], id: string, text: string): boolean {
  const entry = queue.find((candidate) => candidate.id === id);
  if (!entry || !text.trim()) return false;
  entry.text = text;
  entry.content = undefined;
  return true;
}

/** Remove a still-queued message before delivery. False when already delivered. */
export function deleteQueuedMessage(queue: QueuedMessageEntry[], id: string): boolean {
  const index = queue.findIndex((candidate) => candidate.id === id);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}
