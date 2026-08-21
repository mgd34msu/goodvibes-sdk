/**
 * session-dispatch.ts, how work that arrives for a session THIS surface hosts
 * reaches the loop, now that the register is not in this process.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 *
 * A surface composition used to own a persisting `SharedSessionBroker`, and the
 * broker's `setContinuationRunner` was how the graph said "when a continuation
 * arrives for a session, spawn this". The broker was the register AND the
 * dispatcher, and the surface owned both.
 *
 * As a client it owns neither. The daemon holds the register; a surface only
 * needs to RECEIVE dispatch for sessions it is running. That is exactly the
 * `SessionContinuationDispatch` seam the client shape takes, one method,
 * `setContinuationRunner`, and this module satisfies it over the wire:
 * `sessions.inputs.list` for continuation-intent inputs on the sessions this
 * surface hosts, the bound runner for each, `sessions.inputs.deliver` to
 * acknowledge.
 *
 * ── The reply half ─────────────────────────────────────────────────────────
 *
 * The runner returns the id of the agent it started, and that id is not
 * bookkeeping, it is the reply binding. When the daemon spawns a continuation
 * itself, `SharedSessionBroker.bindAgent` pairs the agent with the input it was
 * started for and announces the pairing, which is how an answer to a message
 * that arrived from Telegram/Slack/ntfy finds its way back to that
 * conversation. Dispatched over the wire, the agent runs HERE, so nothing in
 * the daemon could make that pairing: the id was dropped, no binding existed,
 * and a channel message answered by a surface was answered into the void.
 *
 * So this dispatcher reports both halves of the pairing:
 *  - on dispatch, `deliver` carries `agentId` and marks the input DELIVERED,
 *    "collected, and this agent is answering it". The daemon binds the reply
 *    there.
 *  - when that agent finishes, `deliver` carries the answer and marks the input
 *    COMPLETED, "finished acting on it, here is what it said". The daemon
 *    writes it into the session and pushes it down the reply pipeline, exactly
 *    as its own completion poll does for the agents it spawned itself.
 *
 * The finish half needs a way to read this surface's own agent outcomes, which
 * is the `readAgentOutcome` option. A host that does not supply one keeps the
 * old single-acknowledgement behavior (still carrying `agentId`, so the reply
 * is bound) rather than silently claiming an answer it cannot produce.
 *
 * ── Discipline (inherited from the spine client, deliberately) ─────────────
 *
 * Every wire call is best-effort and never throws into the render or keystroke
 * path. A failed poll leaves the cursor where it was, so the input is retried
 * next tick; `deliver` is the only de-duplication, because an input already
 * advanced past `queued` is not returned again. Nothing here blocks a turn.
 *
 * ── Why it polls ───────────────────────────────────────────────────────────
 *
 * The same reason the inbound steer poller does: this is not a hot path, a
 * continuation arrives seconds apart at most, and a poll survives a suspended
 * laptop and a dropped tunnel without a reconnect state machine. The SSE stream
 * carries the same transitions for anything that genuinely needs per-token
 * latency.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { SharedSessionInputRecord } from '../../control-plane/index.js';
import type { SharedSessionContinuationRunner } from '../../control-plane/session-intents.js';
import type { SessionContinuationDispatch } from '../client-services.js';
import { renderAgentCompletionAnswer, type AgentCompletionRecordView } from '../../agents/completion-answer.js';

/** What a surface's own agent register says about a dispatched run. */
export interface SurfaceAgentOutcome {
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** The finished output. Only read on a terminal status; empty is a real answer (silence). */
  readonly answer?: string | undefined;
}

/**
 * Map a surface's own agent record onto the outcome this dispatcher reports.
 *
 * A missing record is `null`, "this surface no longer knows about that run",
 * and is deliberately distinct from a run still in flight. The answer text is
 * the SHARED rule (agents/completion-answer.ts), the same one the daemon
 * renders for the runs it hosts itself, so an answer does not read differently
 * depending on which process happened to execute it.
 */
export function readSurfaceAgentOutcome(
  record: AgentCompletionRecordView | null | undefined,
): SurfaceAgentOutcome | null {
  if (!record) return null;
  if (record.status === 'pending' || record.status === 'running') return { status: record.status };
  return { status: record.status, answer: renderAgentCompletionAnswer(record) };
}

/**
 * The narrow inbound wire surface this dispatcher needs, `sessions.inputs.list`
 * and `sessions.inputs.deliver`. A product's own operator client satisfies it
 * structurally, so a test injects a stub instead of a port.
 */
export interface SessionInputsWireClient {
  listInputs(
    sessionId: string,
    options: { readonly state?: string; readonly since?: number; readonly limit?: number },
  ): Promise<{ readonly inputs: readonly SharedSessionInputRecord[] }>;
  deliverInput(
    sessionId: string,
    inputId: string,
    options?: {
      readonly consumed?: boolean | undefined;
      readonly agentId?: string | undefined;
      readonly answer?: string | undefined;
      readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
    },
  ): Promise<unknown>;
}

/** The setter's own "unbind" argument is part of the seam's signature. */
type ContinuationRunner = SharedSessionContinuationRunner | null;

const DEFAULT_INTERVAL_MS = 2_000;

/**
 * How many dispatched runs this dispatcher will wait on answers for at once,
 * and for how long. Both are bounds on an in-memory map that only ever shrinks
 * when an agent reaches a terminal state, a run that never does (a killed
 * process, a register that forgot it) would otherwise be tracked forever.
 * Dropping one is disclosed, never silent, and the input is still acknowledged
 * so the daemon does not keep it queued.
 */
const MAX_AWAITED_ANSWERS = 200;
const AWAITED_ANSWER_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

interface AwaitedAnswer {
  readonly sessionId: string;
  readonly inputId: string;
  readonly startedAt: number;
}

export interface WireSessionDispatchOptions {
  /** The sessions this surface is hosting right now. Re-read every tick. */
  readonly hostedSessionIds: () => readonly string[];
  /**
   * This surface's own read of a dispatched agent's state. Supplying it is what
   * lets the answer reach the conversation the message came from; omitting it
   * keeps the reply binding but leaves the answer un-reported.
   */
  readonly readAgentOutcome?: ((agentId: string) => SurfaceAgentOutcome | null) | undefined;
  /** Poll interval; defaults to two seconds. */
  readonly intervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
  readonly now?: (() => number) | undefined;
}

export interface WireSessionDispatch extends SessionContinuationDispatch {
  /** Attach the wire once a daemon has been adopted. Idempotent per base URL. */
  activate(client: SessionInputsWireClient): void;
  /** Detach; the bound runner is kept so a re-adopted daemon resumes dispatch. */
  deactivate(reason: string): void;
  /** Stop polling entirely. Idempotent. */
  stop(): void;
}

/**
 * A dispatch seam backed by the adopted daemon's session inputs.
 *
 * Inert until `activate`, a surface with no daemon adopted holds its runner and
 * dispatches nothing, which is the honest offline posture rather than a missing
 * dependency.
 */
export function createWireSessionDispatch(options: WireSessionDispatchOptions): WireSessionDispatch {
  const log = options.log ?? logger;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let runner: ContinuationRunner = null;
  let client: SessionInputsWireClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  /** agentId -> the input it is answering. Insertion-ordered, so the oldest is first. */
  const awaitingAnswers = new Map<string, AwaitedAnswer>();

  const trackAnswer = (agentId: string, entry: AwaitedAnswer): void => {
    awaitingAnswers.set(agentId, entry);
    while (awaitingAnswers.size > MAX_AWAITED_ANSWERS) {
      const oldest = awaitingAnswers.keys().next();
      if (oldest.done) break;
      awaitingAnswers.delete(oldest.value);
      log.warn('[session dispatch] dropped a run from the answer watch list: too many are outstanding', {
        agentId: oldest.value,
        limit: MAX_AWAITED_ANSWERS,
      });
    }
  };

  const drainSession = async (active: SessionInputsWireClient, sessionId: string): Promise<void> => {
    const bound = runner;
    if (!bound) return;
    const { inputs } = await active.listInputs(sessionId, { state: 'queued', limit: 20 });
    for (const input of inputs) {
      // A `submit` is the continuation case: a message posted into a session
      // THIS surface hosts, which the surface's loop must answer. `steer` and
      // `follow-up` are the live-turn path and belong to the inbound steer
      // poller, which injects them into the turn already in flight rather than
      // starting a new run.
      if (input.intent !== 'submit') continue;
      let agentId: string | undefined;
      try {
        const spawned = await bound({ sessionId, task: input.body, input });
        const claimed = spawned?.agentId?.trim();
        if (claimed) agentId = claimed;
      } catch (error) {
        log.warn('[session dispatch] the bound runner rejected a continuation', {
          sessionId,
          inputId: input.id,
          error: summarizeError(error),
        });
        continue; // leave it queued; a transient runner failure must not consume the work
      }
      // No agent id means nothing ran HERE, the runner declined, or the work
      // moved elsewhere (a conversation handed to daemon hosting). The input is
      // still consumed, because leaving it queued would have it dispatched
      // again; there is nothing to bind a reply to, and claiming otherwise
      // would bind one to an agent that does not exist.
      if (!agentId) {
        await active.deliverInput(sessionId, input.id, { consumed: true });
        continue;
      }
      // No way to read this surface's outcomes: bind the reply, acknowledge in
      // one step, and do not pretend an answer is coming.
      if (!options.readAgentOutcome) {
        await active.deliverInput(sessionId, input.id, { consumed: true, agentId });
        continue;
      }
      await active.deliverInput(sessionId, input.id, { agentId });
      trackAnswer(agentId, { sessionId, inputId: input.id, startedAt: now() });
    }
  };

  const reportAnswers = async (active: SessionInputsWireClient): Promise<void> => {
    const readOutcome = options.readAgentOutcome;
    if (!readOutcome || awaitingAnswers.size === 0) return;
    for (const [agentId, awaited] of [...awaitingAnswers]) {
      const outcome = readOutcome(agentId);
      if (outcome && (outcome.status === 'pending' || outcome.status === 'running')) {
        if (now() - awaited.startedAt < AWAITED_ANSWER_MAX_AGE_MS) continue;
        log.warn('[session dispatch] a dispatched run has not finished within the answer watch window; acknowledging without an answer', {
          sessionId: awaited.sessionId,
          agentId,
          ageMs: now() - awaited.startedAt,
        });
        awaitingAnswers.delete(agentId);
        await active.deliverInput(awaited.sessionId, awaited.inputId, { consumed: true, agentId });
        continue;
      }
      // A run this surface no longer knows about. It cannot be waited on, and
      // the daemon must not keep the input open on its account.
      if (!outcome) {
        log.warn('[session dispatch] a dispatched run left this surface\'s register before it reported an answer', {
          sessionId: awaited.sessionId,
          agentId,
        });
        awaitingAnswers.delete(agentId);
        await active.deliverInput(awaited.sessionId, awaited.inputId, { consumed: true, agentId });
        continue;
      }
      awaitingAnswers.delete(agentId);
      await active.deliverInput(awaited.sessionId, awaited.inputId, {
        consumed: true,
        agentId,
        answer: outcome.answer ?? '',
        // Narrowed above: only a terminal status reaches here.
        status: outcome.status as 'completed' | 'failed' | 'cancelled',
      });
    }
  };

  const tick = async (): Promise<void> => {
    const active = client;
    if (!active || runner === null || inFlight) return;
    inFlight = true;
    try {
      for (const sessionId of options.hostedSessionIds()) {
        await drainSession(active, sessionId);
      }
      await reportAnswers(active);
    } catch (error) {
      log.debug('[session dispatch] poll failed; retrying next tick', { error: summarizeError(error) });
    } finally {
      inFlight = false;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
  };

  return {
    setContinuationRunner(next) {
      runner = next;
      if (next !== null && client !== null) ensureTimer();
    },
    activate(next) {
      client = next;
      if (runner !== null) ensureTimer();
      log.info('[session dispatch] adopted the daemon\'s session inputs for continuation dispatch');
    },
    deactivate(reason) {
      client = null;
      log.info(`[session dispatch] detached: ${reason}`);
    },
    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      client = null;
      awaitingAnswers.clear();
    },
  };
}
