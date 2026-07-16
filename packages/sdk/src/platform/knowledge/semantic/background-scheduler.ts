/**
 * background-scheduler.ts — THE governed scheduler for background knowledge
 * self-improvement. Every trigger (enrichment tails, answer refinement, Home
 * Graph ingest, knowledge-service ingest) routes through here so five guards
 * apply to all of them — no caller can schedule a bare-0ms run (the hot loop
 * that fanned control-plane events until the 2026-07-14 daemon OOM):
 *
 *  1. FLOOR — a background run is never scheduled sooner than the minimum
 *     delay, even when a caller asks for 0ms.
 *  2. COALESCING — one pending slot per scope+reason; a same-scope burst
 *     yields one run, and a later trigger's gapIds MERGE into the queued run
 *     instead of being dropped.
 *  3. CARDINALITY BOUND — a burst across more distinct scopes than the pending
 *     cap collapses into ONE queued global sweep; scheduling state is evicted
 *     so the map never accretes.
 *  4. ZERO-GAP BACKOFF — a run that found no candidate gaps parks its scope
 *     until the backoff lapses; a new trigger carrying concrete gapIds is
 *     EVIDENCE and clears the window instead of being swallowed.
 *  5. GOVERNOR PRESSURE — pause is rechecked at fire time (a timer queued
 *     before the pause re-arms instead of executing), and the critical-tier
 *     admission gate refuses the run with an honest logged reason.
 */
import { logger } from '../../utils/logger.js';
import { normalizeKnowledgeSpaceId } from '../spaces.js';
import { uniqueStrings } from './utils.js';
import type { KnowledgeSemanticSelfImproveInput, KnowledgeSemanticSelfImproveResult } from './types.js';

/** Default floor for background self-improvement scheduling (ms). */
export const DEFAULT_SELF_IMPROVE_MIN_DELAY_MS = 5_000;
/** Default zero-gap backoff window; matches the hourly reindex cadence (ms). */
export const DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS = 3_600_000;
/**
 * Max distinct scope keys with a pending background run. A burst across MORE
 * distinct scopes (the incident touched ~1,400 distinct sources) collapses
 * into one queued global sweep instead of N concurrent runs.
 */
export const MAX_PENDING_BACKGROUND_KEYS = 8;
/** Hard bound on retained scheduling-state entries (evicted oldest-first). */
export const MAX_BACKGROUND_STATE_ENTRIES = 256;
/** The collapsed many-scope-burst key: one sweep covers every space. */
const GLOBAL_SWEEP_KEY = 'global|sweep';

/** The coalescing scope key for a self-improve input. */
export function selfImprovementRunKey(input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return `space:${normalizeKnowledgeSpaceId(input.knowledgeSpaceId)}`;
  if (input.sourceIds?.length) return `sources:${uniqueStrings(input.sourceIds).sort().join(',')}`;
  return 'global';
}

/** Per-scope background scheduling state: coalescing flag + zero-gap backoff deadline. */
interface BackgroundRunState {
  pending: boolean;
  zeroGapUntil: number;
  /** The queued run's merged input — later triggers' gapIds merge in rather than being dropped. */
  pendingInput?: KnowledgeSemanticSelfImproveInput | undefined;
}

export interface BackgroundSelfImproveSchedulerDeps {
  /** Execute the run (the semantic service's selfImprove with stopWhenPaused). */
  readonly run: (input: KnowledgeSemanticSelfImproveInput) => Promise<KnowledgeSemanticSelfImproveResult>;
  /** Whether a gap repairer is configured (no repairer = nothing to schedule). */
  readonly enabled: () => boolean;
  /** Governor pause probe (rechecked at fire time). */
  readonly isPaused?: (() => boolean) | undefined;
  /** Governor critical-tier admission gate. */
  readonly admit?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
  readonly minDelayMs: () => number;
  readonly backoffMs: () => number;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => void;
}

export class BackgroundSelfImproveScheduler {
  private readonly state = new Map<string, BackgroundRunState>();

  constructor(private readonly deps: BackgroundSelfImproveSchedulerDeps) {}

  /** Drop settled state entries (not pending, backoff expired) and bound the map. */
  private prune(now: number): void {
    for (const [key, state] of this.state) {
      if (!state.pending && state.zeroGapUntil <= now) this.state.delete(key);
    }
    if (this.state.size > MAX_BACKGROUND_STATE_ENTRIES) {
      for (const [key, state] of this.state) {
        if (this.state.size <= MAX_BACKGROUND_STATE_ENTRIES) break;
        if (!state.pending) this.state.delete(key);
      }
    }
  }

  queue(input: KnowledgeSemanticSelfImproveInput, delayMs = 0): void {
    if (!this.deps.enabled()) return;
    const now = this.deps.now();
    this.prune(now);
    let key = `${selfImprovementRunKey(input)}|${input.reason ?? 'none'}`;
    let effectiveInput = input;
    const existing = this.state.get(key);
    // New-gap EVIDENCE clears the zero-gap backoff: a trigger carrying concrete
    // gapIds is proof the scope is no longer gap-free, so the window must not
    // silently swallow it.
    if (input.gapIds?.length && existing) existing.zeroGapUntil = 0;
    if (existing?.pending) {
      // Coalesce — but PRESERVE the later trigger's payload: merge its gapIds
      // into the queued run's input instead of dropping them.
      if (input.gapIds?.length) {
        const prior = existing.pendingInput ?? input;
        existing.pendingInput = {
          ...prior,
          gapIds: uniqueStrings([...(prior.gapIds ?? []), ...input.gapIds]),
          limit: Math.max(prior.limit ?? 1, input.limit ?? 1, input.gapIds.length),
        };
      }
      return;
    }
    const state = existing ?? { pending: false, zeroGapUntil: 0 };
    if (now < state.zeroGapUntil) return; // zero-gap backoff (gapIds evidence already cleared it above)
    // Cardinality bound: past the pending-key cap, further distinct scopes
    // collapse into ONE queued global sweep (which covers every space).
    let pendingKeys = 0;
    for (const s of this.state.values()) if (s.pending) pendingKeys += 1;
    if (pendingKeys >= MAX_PENDING_BACKGROUND_KEYS && key !== GLOBAL_SWEEP_KEY) {
      key = GLOBAL_SWEEP_KEY;
      effectiveInput = { reason: input.reason, ...(input.force !== undefined ? { force: input.force } : {}) };
      const sweep = this.state.get(key);
      if (sweep) {
        // The backoff must be checked against the FINAL key: a sustained
        // distinct-scope burst would otherwise re-run the collapsed sweep
        // back-to-back straight through the sweep's own zero-gap window.
        // Concrete gap evidence still clears it, exactly like a scoped key.
        if (input.gapIds?.length) sweep.zeroGapUntil = 0;
        if (sweep.pending) return; // one queued sweep absorbs the whole burst
        if (now < sweep.zeroGapUntil) return; // the sweep found nothing recently — parked
      }
    }
    const minDelayMs = Math.max(0, this.deps.minDelayMs());
    const backoffMs = Math.max(0, this.deps.backoffMs());
    // Enforce the floor: a background run is NEVER scheduled sooner than
    // minDelayMs, even when the caller passes delayMs=0.
    const flooredDelayMs = Math.max(minDelayMs, Math.max(0, delayMs));
    const scheduledState: BackgroundRunState = this.state.get(key) ?? { pending: false, zeroGapUntil: 0 };
    scheduledState.pending = true;
    scheduledState.pendingInput = effectiveInput;
    this.state.set(key, scheduledState);
    const fire = (): void => {
      const st = this.state.get(key);
      // Governor pause recheck AT FIRE TIME: a timer queued before the pause
      // must not execute a full self-improve mid-pressure. Re-arm at the floor
      // cadence (no LLM work) until resumed.
      if (this.deps.isPaused?.()) {
        this.deps.schedule(fire, Math.max(minDelayMs, 1_000));
        return;
      }
      // Critical-tier admission: refuse honestly instead of allocating.
      const decision = this.deps.admit?.('knowledge self-improvement');
      if (decision && !decision.allowed) {
        logger.warn('Knowledge semantic background self-improvement refused by the memory governor', {
          reason: decision.reason,
        });
        if (st) {
          st.pending = false;
          st.pendingInput = undefined;
        }
        return;
      }
      // CONSUME the queued input: anything re-armed onto pendingInput after
      // this point arrived MID-RUN and must not be lost when the run settles.
      const runInput = st?.pendingInput ?? effectiveInput;
      if (st) st.pendingInput = undefined;
      // If new input (gap evidence) merged in while the run executed, the
      // completion re-queues it through the full guard set instead of wiping
      // it — and a zero-gap RESULT must not park the scope over that fresh
      // evidence (the run that just finished never looked at it).
      const settle = (result: { candidateGaps?: number | undefined } | null): void => {
        const next = this.state.get(key) ?? { pending: false, zeroGapUntil: 0 };
        next.pending = false;
        const rearmed = next.pendingInput;
        next.pendingInput = undefined;
        if (rearmed) {
          next.zeroGapUntil = 0;
          this.state.set(key, next);
          this.queue(rearmed, 0);
          return;
        }
        // Zero candidate gaps ⇒ back off; a run that found nothing must not
        // keep rescheduling itself. New-gap evidence clears the window.
        next.zeroGapUntil = result !== null && (result.candidateGaps ?? 0) === 0 ? this.deps.now() + backoffMs : 0;
        this.state.set(key, next);
      };
      void this.deps.run(runInput)
        .then((result) => settle(result))
        .catch((error: unknown) => {
          settle(null);
          logger.warn('Knowledge semantic background self-improvement failed', {
            error: error instanceof Error ? error.message : String(error),
            knowledgeSpaceId: input.knowledgeSpaceId,
            reason: input.reason,
          });
        });
    };
    this.deps.schedule(fire, flooredDelayMs);
  }
}
