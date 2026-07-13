/**
 * attribution.ts
 *
 * CostAttributionService — a cost view over the platform's existing LLM usage
 * records (the LLM_RESPONSE_RECEIVED turn events), with cache-aware pricing and
 * 24h/7d aggregation windows, attributable across every dimension a usage
 * record carries (agent, tool, hook, MCP server, model, provider, session).
 *
 * HONESTY IDIOM (non-negotiable, mirrors services.ts `priceUsage` and the fleet
 * cost-state contract): a model the pricing catalog does not know is `unpriced`
 * — its cost is null and it is counted separately, never folded into a
 * fabricated dollar amount. An aggregate over a mix of priced and unpriced
 * records reports costState `estimated` (some contributors unpriced) so a
 * surface never mistakes a partial total for a complete one.
 *
 * CACHE ECONOMICS: fresh input, cache-read, and cache-write tokens are priced
 * distinctly. The catalog carries only the fresh input/output rates, so the
 * cache-read/write rates are derived from the fresh input rate via a documented
 * per-provider multiplier table ({@link CACHE_MULTIPLIERS}) — these are the
 * providers' own published cache ratios (e.g. Anthropic cache-read 0.1x,
 * cache-write 1.25x), NOT a guessed base price: the base rate is always the
 * catalog's, and an unknown model stays unpriced regardless.
 */

/** A single usage record. Every dimension is optional — the service attributes over whatever a record carries. */
export interface CostUsageRecord {
  /** Epoch ms the usage occurred. */
  readonly at: number;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly tool?: string | undefined;
  readonly hook?: string | undefined;
  readonly mcpServer?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** The dimension an attribution query groups by. */
export type CostDimension = 'agent' | 'tool' | 'hook' | 'mcp' | 'model' | 'provider' | 'session';

/** Aggregation window. */
export type CostWindow = '24h' | '7d';

/** Whether an aggregate's `costUsd` is complete. Mirrors the fleet ProcessCostState. */
export type CostAttributionState = 'priced' | 'estimated' | 'unpriced';

/** Token totals for an aggregate. */
export interface CostTokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** One row of the attribution breakdown. */
export interface CostAttributionRow {
  /** The dimension value (e.g. an agentId, a model id, a provider name), or '(unattributed)' when a record lacked the queried dimension. */
  readonly key: string;
  readonly costUsd: number | null;
  readonly costState: CostAttributionState;
  readonly pricedRecordCount: number;
  readonly unpricedRecordCount: number;
  readonly tokens: CostTokenTotals;
}

/** The full attribution result. */
export interface CostAttributionResult {
  readonly window: CostWindow;
  readonly windowStartMs: number;
  readonly dimension: CostDimension;
  /** Sum of priced contributors, or null when every contributor is unpriced. */
  readonly totalCostUsd: number | null;
  readonly costState: CostAttributionState;
  readonly pricedRecordCount: number;
  readonly unpricedRecordCount: number;
  readonly tokens: CostTokenTotals;
  readonly rows: readonly CostAttributionRow[];
}

/**
 * Rates per 1M tokens, or null when the model is unpriced. Wire from
 * providerRegistry.resolveModelPricing (the one pricing resolver: manual ->
 * registration -> provider-served -> catalog -> honest null). Explicit
 * cacheRead/cacheWrite rates, when the source carried them, take precedence
 * over the CACHE_MULTIPLIERS fallback in priceRecord.
 */
export type ResolvePricing = (model: string | undefined, provider?: string | undefined) => {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
} | null;

/**
 * Published per-provider cache ratios relative to the fresh input rate. Keyed by
 * a provider substring (matched case-insensitively). `read`/`write` multiply the
 * catalog input rate to price cache-read/cache-write tokens. The default (no
 * match) is 1.0/1.0 — cache tokens priced at full input rate, the conservative
 * honest choice when the provider's ratio is unknown.
 */
export const CACHE_MULTIPLIERS: Readonly<Record<string, { readonly read: number; readonly write: number }>> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.5, write: 1.0 },
  google: { read: 0.25, write: 1.0 },
  deepseek: { read: 0.1, write: 1.0 },
};

const WINDOW_MS: Record<CostWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const DIMENSION_KEY: Record<CostDimension, (r: CostUsageRecord) => string | undefined> = {
  agent: (r) => r.agentId,
  tool: (r) => r.tool,
  hook: (r) => r.hook,
  mcp: (r) => r.mcpServer,
  model: (r) => r.model,
  provider: (r) => r.provider,
  session: (r) => r.sessionId,
};

const UNATTRIBUTED = '(unattributed)';

function cacheMultipliers(provider: string | undefined): { read: number; write: number } {
  if (provider) {
    const lower = provider.toLowerCase();
    for (const [needle, mult] of Object.entries(CACHE_MULTIPLIERS)) {
      if (lower.includes(needle)) return mult;
    }
  }
  return { read: 1.0, write: 1.0 };
}

interface AccumulatorState {
  costUsd: number;
  hasPriced: boolean;
  priced: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function emptyAccumulator(): AccumulatorState {
  return { costUsd: 0, hasPriced: false, priced: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function resolveState(acc: Pick<AccumulatorState, 'priced' | 'unpriced'>): CostAttributionState {
  if (acc.unpriced === 0) return 'priced';
  if (acc.priced === 0) return 'unpriced';
  return 'estimated';
}

export interface CostAttributionServiceOptions {
  readonly resolvePricing: ResolvePricing;
  /** Ceiling on retained records (oldest pruned first). Default 50000. */
  readonly maxRecords?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class CostAttributionService {
  private readonly resolvePricing: ResolvePricing;
  private readonly maxRecords: number;
  private readonly now: () => number;
  /** Append-only ring, oldest-first; pruned by count and (on read) by the 7d ceiling. */
  private records: CostUsageRecord[] = [];

  constructor(opts: CostAttributionServiceOptions) {
    this.resolvePricing = opts.resolvePricing;
    this.maxRecords = opts.maxRecords ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  /** Ingest one usage record. Zero-token records are dropped (nothing to attribute). */
  record(rec: CostUsageRecord): void {
    if (rec.inputTokens <= 0 && rec.outputTokens <= 0 && rec.cacheReadTokens <= 0 && rec.cacheWriteTokens <= 0) return;
    this.records.push(rec);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  /** Price one record with cache-aware rates, honestly unpriced when the model is unknown. */
  priceRecord(rec: CostUsageRecord): { costUsd: number | null; state: 'priced' | 'unpriced' } {
    const pricing = this.resolvePricing(rec.model, rec.provider);
    if (!pricing) return { costUsd: null, state: 'unpriced' };
    const mult = cacheMultipliers(rec.provider);
    // Source-carried cache rates win; the published ratio table is the
    // fallback when the pricing feed had no cache-specific rates.
    const cacheReadRate = pricing.cacheRead ?? pricing.input * mult.read;
    const cacheWriteRate = pricing.cacheWrite ?? pricing.input * mult.write;
    const costUsd =
      (rec.inputTokens * pricing.input +
        rec.cacheReadTokens * cacheReadRate +
        rec.cacheWriteTokens * cacheWriteRate +
        rec.outputTokens * pricing.output) /
      1_000_000;
    return { costUsd, state: 'priced' };
  }

  /** Aggregate cost + tokens over a window, grouped by `dimension`. */
  attribution(window: CostWindow, dimension: CostDimension): CostAttributionResult {
    const now = this.now();
    const windowStartMs = now - WINDOW_MS[window];
    const keyOf = DIMENSION_KEY[dimension];
    const groups = new Map<string, AccumulatorState>();
    const total = emptyAccumulator();

    for (const rec of this.records) {
      if (rec.at < windowStartMs) continue;
      const { costUsd, state } = this.priceRecord(rec);
      const key = keyOf(rec) ?? UNATTRIBUTED;
      let group = groups.get(key);
      if (!group) {
        group = emptyAccumulator();
        groups.set(key, group);
      }
      for (const acc of [group, total]) {
        acc.inputTokens += rec.inputTokens;
        acc.outputTokens += rec.outputTokens;
        acc.cacheReadTokens += rec.cacheReadTokens;
        acc.cacheWriteTokens += rec.cacheWriteTokens;
        if (state === 'priced' && costUsd !== null) {
          acc.costUsd += costUsd;
          acc.hasPriced = true;
          acc.priced += 1;
        } else {
          acc.unpriced += 1;
        }
      }
    }

    const rows: CostAttributionRow[] = [...groups.entries()]
      .map(([key, acc]) => ({
        key,
        costUsd: acc.hasPriced ? acc.costUsd : null,
        costState: resolveState(acc),
        pricedRecordCount: acc.priced,
        unpricedRecordCount: acc.unpriced,
        tokens: this.tokensOf(acc),
      }))
      .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key));

    return {
      window,
      windowStartMs,
      dimension,
      totalCostUsd: total.hasPriced ? total.costUsd : null,
      costState: resolveState(total),
      pricedRecordCount: total.priced,
      unpricedRecordCount: total.unpriced,
      tokens: this.tokensOf(total),
      rows,
    };
  }

  private tokensOf(acc: AccumulatorState): CostTokenTotals {
    return {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens,
    };
  }
}
