/**
 * session-dispatch.ts — how work that arrives for a session THIS surface hosts
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
 * `SessionContinuationDispatch` seam the client shape takes — one method,
 * `setContinuationRunner` — and this module satisfies it over the wire:
 * `sessions.inputs.list` for continuation-intent inputs on the sessions this
 * surface hosts, the bound runner for each, `sessions.inputs.deliver` to
 * acknowledge.
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
 * The same reason the inbound steer poller does: this is not a hot path — a
 * continuation arrives seconds apart at most — and a poll survives a suspended
 * laptop and a dropped tunnel without a reconnect state machine. The SSE stream
 * carries the same transitions for anything that genuinely needs per-token
 * latency.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { SharedSessionInputRecord } from '../../control-plane/index.js';
import type { SharedSessionContinuationRunner } from '../../control-plane/session-intents.js';
import type { SessionContinuationDispatch } from '../client-services.js';

/**
 * The narrow inbound wire surface this dispatcher needs — `sessions.inputs.list`
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
    options?: { readonly consumed?: boolean },
  ): Promise<unknown>;
}

/** The setter's own "unbind" argument is part of the seam's signature. */
type ContinuationRunner = SharedSessionContinuationRunner | null;

const DEFAULT_INTERVAL_MS = 2_000;

export interface WireSessionDispatchOptions {
  /** The sessions this surface is hosting right now. Re-read every tick. */
  readonly hostedSessionIds: () => readonly string[];
  /** Poll interval; defaults to two seconds. */
  readonly intervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
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
 * Inert until `activate` — a surface with no daemon adopted holds its runner and
 * dispatches nothing, which is the honest offline posture rather than a missing
 * dependency.
 */
export function createWireSessionDispatch(options: WireSessionDispatchOptions): WireSessionDispatch {
  const log = options.log ?? logger;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let runner: ContinuationRunner = null;
  let client: SessionInputsWireClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

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
      try {
        await bound({ sessionId, task: input.body, input });
      } catch (error) {
        log.warn('[session dispatch] the bound runner rejected a continuation', {
          sessionId,
          inputId: input.id,
          error: summarizeError(error),
        });
        continue; // leave it queued; a transient runner failure must not consume the work
      }
      await active.deliverInput(sessionId, input.id, { consumed: true });
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
    },
  };
}
