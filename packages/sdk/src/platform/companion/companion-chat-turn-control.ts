/**
 * companion-chat-turn-control.ts
 *
 * Turn-lifecycle control for companion chat: the per-turn abort scope, the
 * cancel finalization path (`companion.chat.turns.cancel`), and the pending
 * turn queue that backs queue-when-busy sends and the steer verb
 * (`companion.chat.messages.steer`).
 *
 * Split out of companion-chat-manager.ts (which is under the repo's line
 * cap): everything here is policy over structural dependencies the manager
 * injects — no manager privates are imported, matching the pattern the other
 * companion helper modules use.
 */

import type { ConversationManager } from '../core/conversation.js';
import type { ProviderMessage } from '../providers/interface.js';
import type { ToolDefinition } from '../types/tools.js';
import type {
  CancelCompanionChatTurnInput,
  CancelCompanionChatTurnOutput,
  CompanionChatMessage,
  CompanionChatTurnEvent,
  CompanionChatTurnStoppedBy,
  ConversationMessageEnvelope,
} from './companion-chat-types.js';

// ---------------------------------------------------------------------------
// Minimal provider types (subset of the real ProviderRegistry interface)
// ---------------------------------------------------------------------------

export type CompanionProviderMessage = ProviderMessage;

export interface CompanionProviderChunk {
  readonly type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  readonly delta?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolInput?: unknown | undefined;
  readonly result?: unknown | undefined;
  readonly isError?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface CompanionLLMProvider {
  /** Stream a single-turn conversation. Yields chunks. */
  chatStream(
    messages: CompanionProviderMessage[],
    options: {
      readonly systemPrompt?: string | null | undefined;
      readonly model?: string | null | undefined;
      readonly provider?: string | null | undefined;
      readonly tools?: readonly ToolDefinition[] | undefined;
      readonly abortSignal?: AbortSignal | undefined;
    },
  ): AsyncIterable<CompanionProviderChunk>;
}

// ---------------------------------------------------------------------------
// Per-turn abort scope
// ---------------------------------------------------------------------------

/** What a settled (finished or finalized-cancelled) turn reports back. */
export interface TurnSettleResult {
  readonly partialPersisted: boolean;
  readonly assistantMessageId?: string | undefined;
}

/**
 * The in-flight turn a `companion.chat.turns.cancel` can target. One slot per
 * session: the most recently started, not-yet-finished turn owns it (the
 * optional turnId guard on cancel exists exactly for the race where a stale
 * stop click lands after a newer turn has taken the slot).
 */
export interface ActiveCompanionTurn {
  readonly turnId: string;
  /** Per-turn controller — chained UNDER the session controller, never the reverse. */
  readonly controller: AbortController;
  /** Set by cancel before aborting; distinguishes a user stop from a session close. */
  cancelRequested: boolean;
  /** Resolves when the turn's cancel-finalization (or any other exit) has run. */
  readonly settled: Promise<TurnSettleResult>;
}

export interface TurnAbortScope {
  readonly activeTurn: ActiveCompanionTurn;
  readonly abortSignal: AbortSignal;
  /** Settle the turn (idempotent — the first call wins). */
  readonly settle: (result: TurnSettleResult) => void;
  /** Detach the session-abort chain listener. Call on every exit path. */
  readonly detach: () => void;
}

/**
 * Create the per-turn abort scope, chained UNDER the session-level controller.
 * A user cancel aborts ONLY this turn; the session controller (close/delete/
 * shutdown) still aborts everything. The session controller must never be
 * aborted for a single-turn stop — its signal stays aborted forever and would
 * poison every later turn in the session.
 */
export function createTurnAbortScope(turnId: string, sessionSignal: AbortSignal): TurnAbortScope {
  const controller = new AbortController();
  const onSessionAbort = (): void => { controller.abort(); };
  if (sessionSignal.aborted) controller.abort();
  else sessionSignal.addEventListener('abort', onSessionAbort, { once: true });

  let settle!: (result: TurnSettleResult) => void;
  const settled = new Promise<TurnSettleResult>((resolve) => {
    settle = resolve;
  });
  const activeTurn: ActiveCompanionTurn = { turnId, controller, cancelRequested: false, settled };
  return {
    activeTurn,
    abortSignal: controller.signal,
    settle,
    detach: () => { sessionSignal.removeEventListener('abort', onSessionAbort); },
  };
}

// ---------------------------------------------------------------------------
// Cancel finalization
// ---------------------------------------------------------------------------

/**
 * Appended (model-facing only) to an interrupted partial when it is committed
 * to the conversation history, so the model can reason about the true chain
 * of events on later turns — a user's follow-up often refers to what it was
 * watching at the moment it hit stop. The transcript copy stays clean; the UI
 * carries the marker as the deliveryState badge instead.
 */
export const TURN_INTERRUPTION_NOTE =
  '\n\n[Interrupted: the user stopped this response here, before it was complete.]';

/** Structural dependencies finalizeCancelledTurn needs from the manager. */
export interface CancelFinalizeContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  /** The user message that started the turn (the partial's inReplyTo link). */
  readonly userMessageId: string;
  /** Read at finalize time — the streamed partial accumulates in a mutable local. */
  readonly getAssistantContent: () => string;
  /**
   * The portion of the partial NOT yet committed to the conversation history
   * (completed tool rounds commit as they finish; only the interrupted
   * round's tail is uncommitted).
   */
  readonly getUncommittedContent: () => string;
  /** Commit the interrupted tail (with its interruption note) to the model-facing history. */
  readonly commitPartialToHistory: (content: string) => void;
  /** toolCallId -> toolName for every announced-but-unresolved tool call. */
  readonly openToolCalls: Map<string, string>;
  readonly wasCancelRequested: () => boolean;
  readonly isShutdown: () => boolean;
  readonly publish: (event: CompanionChatTurnEvent) => void;
  /** Push the partial into the transcript, update meta, persist. */
  readonly persistPartial: (message: CompanionChatMessage) => void;
  /** Resolve the post's pending reply; `extra` carries the partial when one exists. */
  readonly resolveReply: (extra: { assistantMessageId?: string; response?: string }) => void;
  readonly settle: (result: TurnSettleResult) => void;
}

/**
 * The single exit path for an aborted turn (user cancel, session close, or
 * shutdown). Closes dangling tool blocks, persists a non-empty partial with
 * an explicit `deliveryState: 'cancelled'` marker (never a silent loss, never
 * a partial masquerading as a finished reply), commits the interrupted tail
 * to the model-facing conversation history with an explicit interruption note
 * (later turns must be able to reason about what the user saw and stopped),
 * and publishes the terminal `turn.cancelled` to every subscriber so a stop
 * issued from one client converges on all of them.
 */
export function finalizeCancelledTurn(ctx: CancelFinalizeContext): void {
  const { sessionId, turnId } = ctx;
  const stoppedBy: CompanionChatTurnStoppedBy = ctx.wasCancelRequested()
    ? 'user'
    : ctx.isShutdown()
      ? 'shutdown'
      : 'session-closed';
  for (const [toolCallId, toolName] of ctx.openToolCalls) {
    ctx.publish({
      type: 'turn.tool_result',
      sessionId,
      turnId,
      toolCallId,
      toolName,
      result: 'Cancelled: the turn was stopped before this tool call completed.',
      isError: true,
    });
  }
  ctx.openToolCalls.clear();

  const assistantContent = ctx.getAssistantContent();
  const uncommitted = ctx.getUncommittedContent();
  if (uncommitted.trim()) {
    ctx.commitPartialToHistory(uncommitted + TURN_INTERRUPTION_NOTE);
  }
  let persistedId: string | undefined;
  let envelope: ConversationMessageEnvelope | undefined;
  if (assistantContent.trim()) {
    const now = Date.now();
    ctx.persistPartial({
      id: ctx.assistantMessageId,
      sessionId,
      role: 'assistant',
      content: assistantContent,
      attachments: [],
      createdAt: now,
      deliveryState: 'cancelled',
      inReplyTo: ctx.userMessageId,
    });
    persistedId = ctx.assistantMessageId;
    envelope = {
      sessionId,
      messageId: ctx.assistantMessageId,
      body: assistantContent,
      source: 'companion-chat-assistant',
      timestamp: now,
    };
  }
  ctx.publish({
    type: 'turn.cancelled',
    sessionId,
    turnId,
    stoppedBy,
    partialPersisted: persistedId !== undefined,
    ...(persistedId !== undefined ? { assistantMessageId: persistedId, envelope } : {}),
  });
  ctx.resolveReply(persistedId !== undefined ? { assistantMessageId: persistedId, response: assistantContent } : {});
  ctx.settle({
    partialPersisted: persistedId !== undefined,
    ...(persistedId !== undefined ? { assistantMessageId: persistedId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Cancel request validation + execution
// ---------------------------------------------------------------------------

/**
 * How long a cancel waits for the aborted turn to finalize before answering
 * with partialPersisted:false (the terminal turn.cancelled SSE event stays the
 * authoritative signal either way). Providers release an aborted fetch stream
 * near-instantly; this bound only matters for a wedged provider.
 */
const CANCEL_SETTLE_TIMEOUT_MS = 3_000;

/**
 * Cancel the given active turn. Refusals are honest machine codes:
 * no turn in flight → 404 NO_ACTIVE_TURN (benign — the turn finished before
 * the stop landed); `turnId` guard mismatch → 409 TURN_MISMATCH (a newer turn
 * took the slot — a stale stop click must not kill it). Repeat cancels are
 * idempotent successes, never errors. The caller resolves the session
 * (SESSION_NOT_FOUND is its refusal).
 */
export async function cancelActiveTurn(
  sessionId: string,
  turn: ActiveCompanionTurn | null,
  input: CancelCompanionChatTurnInput,
): Promise<CancelCompanionChatTurnOutput> {
  if (!turn) {
    throw Object.assign(
      new Error('No turn is in flight for this session — it may have finished before the stop landed.'),
      { code: 'NO_ACTIVE_TURN', status: 404 },
    );
  }
  if (input.turnId !== undefined && input.turnId !== turn.turnId) {
    throw Object.assign(
      new Error('The requested turn is not the active turn — a newer turn is already running.'),
      { code: 'TURN_MISMATCH', status: 409 },
    );
  }
  const alreadyCancelled = turn.cancelRequested;
  if (!alreadyCancelled) {
    turn.cancelRequested = true;
    turn.controller.abort();
  }
  const settled = await Promise.race([
    turn.settled,
    new Promise<null>((resolve) => setTimeout(resolve, CANCEL_SETTLE_TIMEOUT_MS)),
  ]);
  return {
    sessionId,
    turnId: turn.turnId,
    cancelled: true,
    ...(alreadyCancelled ? { alreadyCancelled: true } : {}),
    partialPersisted: settled?.partialPersisted ?? false,
  };
}

// ---------------------------------------------------------------------------
// Post-and-await-reply plumbing
// ---------------------------------------------------------------------------

export interface CompanionReplyWait {
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * Wrap a post in a bounded reply wait: resolves with the turn's reply result,
 * a timeout marker, or the post failure — never rejects. The `post` callback
 * receives the pending-reply record to register (resolve + its timeout handle)
 * and returns the message id; `onTimeout` lets the caller drop the
 * registration when the bound fires first.
 */
export function awaitCompanionReply(
  timeoutMs: number,
  post: (pendingReply: {
    readonly resolve: (result: CompanionReplyWait) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }) => Promise<string>,
  onTimeout: (messageId: string) => void,
): Promise<CompanionReplyWait> {
  let messageId = '';
  return new Promise<CompanionReplyWait>((resolve) => {
    const timeout = setTimeout(() => {
      if (messageId) onTimeout(messageId);
      resolve({ messageId, error: 'Timed out waiting for companion chat reply' });
    }, timeoutMs);
    timeout.unref?.();
    void post({ resolve, timeout })
      .then((id) => { messageId = id; })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        resolve({
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

// ---------------------------------------------------------------------------
// Pending-turn queue (queue-when-busy sends + steer-to-front)
// ---------------------------------------------------------------------------

/**
 * A user message whose LLM turn has not started yet. The transcript message
 * is already appended (marked `deliveryState: 'queued'`); the provider-ready
 * conversation content is stashed here and committed to the conversation only
 * when the turn actually starts — committing at post time would leak the
 * queued message into the ACTIVE turn's later tool rounds, which re-read the
 * conversation every round.
 */
export interface QueuedCompanionTurn {
  readonly userMessageId: string;
  /** Provider-ready user content (attachments resolved at post time). */
  readonly providerContent: Parameters<ConversationManager['addUserMessage']>[0];
  /** In-process tap for this turn's incremental events (rides the queue entry). */
  readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
}
