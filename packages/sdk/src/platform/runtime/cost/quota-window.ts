/**
 * quota-window.ts
 *
 * QuotaWindowTracker — tracks provider rate/quota windows from REAL observed
 * signals (429 rate-limit errors and their retry-after, plus explicit
 * limit/remaining/reset when a provider's headers carry them) and answers a
 * pre-fan-out question: "will spawning N agents against this provider likely
 * exhaust its quota window right now?"
 *
 * HONESTY IDIOM: the assessment is grounded in observed evidence and NEVER a
 * fabricated certainty. With no signal for a provider the verdict is `unknown`
 * (with an empty-evidence explanation), not a confident "you're fine". A
 * `likely-exhausts` verdict always carries the evidence it rests on (an active
 * cooldown, or an observed remaining below the requested fan-out), so a caller
 * can see why.
 */

/** One observed rate/quota signal for a provider. */
export interface QuotaSignal {
  readonly provider: string;
  /** Epoch ms the signal was observed. */
  readonly at: number;
  /** Retry-after the provider asked for (ms), when a 429 carried one. Defines the active cooldown window. */
  readonly retryAfterMs?: number | undefined;
  /** Observed window limit (requests or tokens), when headers carried it. */
  readonly limit?: number | undefined;
  /** Observed remaining in the window, when headers carried it. */
  readonly remaining?: number | undefined;
  /** Epoch ms the window resets, when headers carried it. */
  readonly resetAt?: number | undefined;
}

export type FanoutVerdict = 'likely-exhausts' | 'unlikely' | 'unknown';

/** The evidence a fan-out assessment rests on — all observed, never invented. */
export interface FanoutEvidence {
  /** How many rate-limit signals were seen for this provider inside the lookback window. */
  readonly recentRateLimitCount: number;
  /** Remaining cooldown (ms) from the most recent retry-after that has not yet elapsed, when one is active. */
  readonly activeCooldownMs?: number | undefined;
  /** The most recent observed remaining-in-window, when a provider reported it. */
  readonly observedRemaining?: number | undefined;
  /** The most recent observed window limit, when a provider reported it. */
  readonly observedLimit?: number | undefined;
  /** The fan-out size the assessment was made against. */
  readonly requestedAgents: number;
}

export interface FanoutAssessment {
  readonly provider: string;
  readonly verdict: FanoutVerdict;
  /** A plain-language explanation of the verdict and the evidence behind it. */
  readonly reason: string;
  readonly evidence: FanoutEvidence;
}

export interface FanoutQuery {
  readonly provider: string;
  /** How many agents the caller is about to spawn against this provider. */
  readonly agentCount: number;
  /** Optional expected LLM calls each agent will make (defaults to 1) — used against an observed `remaining`. */
  readonly callsPerAgent?: number | undefined;
}

/**
 * A point-in-time view of a provider's observed quota window — the most recent
 * limit/remaining/reset a provider's headers reported, plus any active cooldown.
 * `hasSignal:false` (with every observed-* field absent) when no rate-limit
 * signal has been seen for the provider in the lookback window — an honest "no
 * observation", never a fabricated full quota.
 */
export interface QuotaSnapshot {
  readonly provider: string;
  /** Whether any rate-limit/quota signal has been observed within the lookback window. */
  readonly hasSignal: boolean;
  /** Epoch ms of the most recent observed signal, when one exists. */
  readonly observedAt?: number | undefined;
  /** Most recent observed remaining-in-window, when a provider reported it. */
  readonly remaining?: number | undefined;
  /** Most recent observed window limit, when a provider reported it. */
  readonly limit?: number | undefined;
  /** Most recent observed window reset (epoch ms), when a provider reported it. */
  readonly resetAt?: number | undefined;
  /** Remaining cooldown (ms) from the most recent retry-after that has not yet elapsed, when active. */
  readonly activeCooldownMs?: number | undefined;
  /** How many rate-limit (retry-after-carrying) signals were seen in the lookback window. */
  readonly recentRateLimitCount: number;
}

export interface QuotaWindowTrackerOptions {
  /** How far back observed signals stay relevant to an assessment. Default 15 min. */
  readonly lookbackMs?: number | undefined;
  /** Ceiling on retained signals per provider (oldest pruned first). Default 200. */
  readonly maxSignalsPerProvider?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;

export class QuotaWindowTracker {
  private readonly lookbackMs: number;
  private readonly maxSignalsPerProvider: number;
  private readonly now: () => number;
  private readonly signals = new Map<string, QuotaSignal[]>();

  constructor(opts: QuotaWindowTrackerOptions = {}) {
    this.lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.maxSignalsPerProvider = opts.maxSignalsPerProvider ?? 200;
    this.now = opts.now ?? Date.now;
  }

  /** Ingest one observed rate/quota signal. */
  record(signal: QuotaSignal): void {
    if (!signal.provider) return;
    const list = this.signals.get(signal.provider) ?? [];
    list.push(signal);
    if (list.length > this.maxSignalsPerProvider) {
      list.splice(0, list.length - this.maxSignalsPerProvider);
    }
    this.signals.set(signal.provider, list);
  }

  /**
   * A point-in-time view of the provider's observed quota window: the most
   * recent limit/remaining/reset and any active cooldown, grounded only in what
   * headers actually reported. Honest "no observation" (hasSignal:false) when
   * nothing has been seen in the lookback window.
   */
  snapshot(provider: string): QuotaSnapshot {
    const now = this.now();
    const recent = (this.signals.get(provider) ?? []).filter((s) => now - s.at <= this.lookbackMs);
    if (recent.length === 0) {
      return { provider, hasSignal: false, recentRateLimitCount: 0 };
    }
    const latest = recent[recent.length - 1]!;
    const activeCooldownMs = latest.retryAfterMs !== undefined
      ? Math.max(0, latest.at + latest.retryAfterMs - now)
      : undefined;
    const remaining = lastDefined(recent, (s) => s.remaining);
    const limit = lastDefined(recent, (s) => s.limit);
    const resetAt = lastDefined(recent, (s) => s.resetAt);
    return {
      provider,
      hasSignal: true,
      observedAt: latest.at,
      recentRateLimitCount: recent.filter((s) => s.retryAfterMs !== undefined).length,
      ...(remaining !== undefined ? { remaining } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(activeCooldownMs !== undefined && activeCooldownMs > 0 ? { activeCooldownMs } : {}),
    };
  }

  /**
   * Assess whether the requested fan-out likely exhausts the provider's quota
   * window right now, grounded in observed signals.
   */
  assessFanout(query: FanoutQuery): FanoutAssessment {
    const now = this.now();
    const callsPerAgent = query.callsPerAgent && query.callsPerAgent > 0 ? query.callsPerAgent : 1;
    const requestedCalls = Math.max(0, query.agentCount) * callsPerAgent;
    const recent = (this.signals.get(query.provider) ?? []).filter((s) => now - s.at <= this.lookbackMs);

    if (recent.length === 0) {
      return {
        provider: query.provider,
        verdict: 'unknown',
        reason: `No rate-limit or quota signal has been observed for ${query.provider} in the last ${Math.round(this.lookbackMs / 60000)} minutes — there is no evidence to judge this fan-out either way.`,
        evidence: { recentRateLimitCount: 0, requestedAgents: query.agentCount },
      };
    }

    // Most recent signal drives the live window view.
    const latest = recent[recent.length - 1]!;
    const activeCooldownMs = latest.retryAfterMs !== undefined
      ? Math.max(0, latest.at + latest.retryAfterMs - now)
      : undefined;
    const observedRemaining = lastDefined(recent, (s) => s.remaining);
    const observedLimit = lastDefined(recent, (s) => s.limit);
    const evidence: FanoutEvidence = {
      recentRateLimitCount: recent.filter((s) => s.retryAfterMs !== undefined).length,
      ...(activeCooldownMs !== undefined && activeCooldownMs > 0 ? { activeCooldownMs } : {}),
      ...(observedRemaining !== undefined ? { observedRemaining } : {}),
      ...(observedLimit !== undefined ? { observedLimit } : {}),
      requestedAgents: query.agentCount,
    };

    // 1) An active cooldown means the provider is rate-limiting RIGHT NOW.
    if (activeCooldownMs !== undefined && activeCooldownMs > 0) {
      return {
        provider: query.provider,
        verdict: 'likely-exhausts',
        reason: `${query.provider} is in an active rate-limit cooldown for another ${Math.ceil(activeCooldownMs / 1000)}s (from an observed 429). Spawning ${query.agentCount} agent(s) now will very likely hit the limit.`,
        evidence,
      };
    }

    // 2) A reported remaining below the requested calls will run the window dry.
    if (observedRemaining !== undefined && requestedCalls > observedRemaining) {
      return {
        provider: query.provider,
        verdict: 'likely-exhausts',
        reason: `${query.provider} reported ${observedRemaining} remaining in its quota window, but this fan-out needs about ${requestedCalls} call(s) (${query.agentCount} agent(s) x ${callsPerAgent}). It will likely exhaust the window.`,
        evidence,
      };
    }

    // 3) Signals exist but no active cooldown and no shortfall — unlikely, with the evidence stated.
    return {
      provider: query.provider,
      verdict: 'unlikely',
      reason: observedRemaining !== undefined
        ? `${query.provider} reported ${observedRemaining} remaining and no active cooldown; ~${requestedCalls} call(s) should fit.`
        : `${query.provider} had ${recent.length} recent signal(s) but no active cooldown; no evidence this fan-out exhausts the window.`,
      evidence,
    };
  }
}

function lastDefined<T>(list: readonly QuotaSignal[], pick: (s: QuotaSignal) => T | undefined): T | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const value = pick(list[i]!);
    if (value !== undefined) return value;
  }
  return undefined;
}
