/**
 * Persisted per-model context-window knowledge: user overrides and learned
 * (observed) provider limits.
 *
 * Two layers, user first:
 *
 * - **User override** (set via the TUI's /context window command or the model
 *   picker's context-cap flow): registryKey -> tokens, applied with
 *   provenance 'configured_cap', which getContextWindowForModel treats as
 *   authoritative. Clearing returns the model to automatic resolution.
 * - **Observed limit**: when a provider rejects a request as too long
 *   (context_length_exceeded and friends), the size of the rejected request
 *   is recorded as the model's practical ceiling — catalogs routinely
 *   over-state what a given endpoint actually accepts (e.g. a catalog says
 *   1M while the subscriber endpoint enforces ~250k). Applied with
 *   provenance 'observed_limit' whenever it is SMALLER than the automatic
 *   window. Self-correcting in both directions: another, smaller rejection
 *   lowers it; a successful request whose real billed input exceeds it
 *   raises it.
 *
 * The file lives in the control-plane config dir, so both layers reach every
 * consumer of the same home (TUI, daemon, agent) without extra wiring.
 */
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ModelDefinition } from './registry-types.js';

/**
 * Ceiling for a configured context window. Matches the model-picker's input
 * validation; anything above this is a typo, not a real model window.
 */
export const MAX_CONTEXT_WINDOW_OVERRIDE = 10_000_000;

interface ContextWindowOverridesFile {
  version: 1 | 2;
  overrides: Record<string, number>;
  /** v2: learned provider limits (registryKey -> tokens). */
  observed?: Record<string, number>;
}

export function getContextWindowOverridesPath(configDir: string): string {
  return join(configDir, 'context-window-overrides.json');
}

/** True when the value is usable as a context window override. */
export function isValidContextWindowOverride(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_CONTEXT_WINDOW_OVERRIDE;
}

function readValidEntries(source: Record<string, number> | undefined, label: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const [registryKey, value] of Object.entries(source ?? {})) {
    if (typeof value === 'number' && isValidContextWindowOverride(value)) {
      map.set(registryKey, value);
    } else {
      logger.warn(`[context-window-overrides] Dropping invalid ${label} entry`, { registryKey, value });
    }
  }
  return map;
}

interface LoadedContextWindowState {
  overrides: Map<string, number>;
  observed: Map<string, number>;
}

/**
 * Load persisted state (v1 files have no observed section). Malformed files
 * and invalid entries are dropped with a warning — never poison downstream
 * window math with a bad value.
 */
export function loadContextWindowOverrides(filePath: string): LoadedContextWindowState {
  const empty: LoadedContextWindowState = { overrides: new Map(), observed: new Map() };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return empty; // missing file = no overrides (first run)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ContextWindowOverridesFile> | null;
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || typeof parsed.overrides !== 'object' || parsed.overrides === null) {
      logger.warn('[context-window-overrides] Ignoring malformed overrides file', { filePath });
      return empty;
    }
    return {
      overrides: readValidEntries(parsed.overrides, 'override'),
      observed: readValidEntries(parsed.observed, 'observed-limit'),
    };
  } catch (error) {
    logger.warn('[context-window-overrides] Failed to parse overrides file', {
      filePath,
      error: summarizeError(error),
    });
    return empty;
  }
}

/** Persist state. Write failures are logged, not thrown — the in-memory values still apply this session. */
export function saveContextWindowOverrides(filePath: string, state: LoadedContextWindowState): void {
  const sorted = (map: ReadonlyMap<string, number>): Record<string, number> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const file: ContextWindowOverridesFile = {
    version: 2,
    overrides: sorted(state.overrides),
    observed: sorted(state.observed),
  };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
  } catch (error) {
    logger.warn('[context-window-overrides] Failed to persist overrides', {
      filePath,
      error: summarizeError(error),
    });
  }
}

/**
 * Owns the per-model window knowledge: lazy disk load, validated set/clear
 * with persistence, observed-limit learning, and the overlay applied to
 * model definitions. ProviderRegistry delegates here so window policy lives
 * in one place.
 */
export class ContextWindowOverrideStore {
  private state: LoadedContextWindowState | null = null;

  constructor(private readonly filePath: string) {}

  private load(): LoadedContextWindowState {
    this.state ??= loadContextWindowOverrides(this.filePath);
    return this.state;
  }

  private persist(): void {
    saveContextWindowOverrides(this.filePath, this.load());
  }

  /** The user-configured window for a model, or null when automatic. */
  get(registryKey: string): number | null {
    return this.load().overrides.get(registryKey) ?? null;
  }

  /** The learned provider limit for a model, or null when none observed. */
  getObserved(registryKey: string): number | null {
    return this.load().observed.get(registryKey) ?? null;
  }

  /** Validate, store, and persist a user override. Returns false (and stores nothing) for invalid caps. */
  set(registryKey: string, cap: number): boolean {
    if (!isValidContextWindowOverride(cap)) return false;
    this.load().overrides.set(registryKey, cap);
    this.persist();
    return true;
  }

  /**
   * Remove the user override AND any learned limit, returning the model to
   * fully automatic resolution. Returns true when anything was cleared.
   */
  clear(registryKey: string): boolean {
    const state = this.load();
    const existed = state.overrides.delete(registryKey);
    const observedExisted = state.observed.delete(registryKey);
    if (existed || observedExisted) this.persist();
    return existed || observedExisted;
  }

  /**
   * A provider rejected a request of ~`rejectedAtTokens` as too long: record
   * that size as the model's practical ceiling. Only lowers (or sets) the
   * learned limit — a larger rejection than a known-smaller limit teaches
   * nothing new.
   */
  recordRejection(registryKey: string, rejectedAtTokens: number): void {
    const rounded = Math.floor(rejectedAtTokens);
    if (!isValidContextWindowOverride(rounded)) return;
    const state = this.load();
    const existing = state.observed.get(registryKey);
    if (existing !== undefined && existing <= rounded) return;
    state.observed.set(registryKey, rounded);
    this.persist();
    logger.info('[context-window-overrides] Learned context ceiling from provider rejection', {
      registryKey,
      observedTokens: rounded,
    });
  }

  /**
   * A request with real billed input of `successfulInputTokens` succeeded:
   * if that exceeds the learned limit, the limit was too pessimistic (token
   * estimates overshoot) — raise it to what the provider demonstrably
   * accepted.
   */
  reconcileSuccess(registryKey: string, successfulInputTokens: number): void {
    const rounded = Math.floor(successfulInputTokens);
    const state = this.load();
    const existing = state.observed.get(registryKey);
    if (existing === undefined || rounded <= existing) return;
    if (!isValidContextWindowOverride(rounded)) return;
    state.observed.set(registryKey, rounded);
    this.persist();
  }

  /**
   * Overlay window knowledge onto a model definition. A user override wins
   * ('configured_cap', authoritative downstream); otherwise a learned limit
   * applies when it is smaller than the automatic window ('observed_limit',
   * equally authoritative — the provider proved the catalog wrong).
   */
  apply(model: ModelDefinition): ModelDefinition {
    const state = this.load();
    const override = state.overrides.get(model.registryKey);
    if (override !== undefined) {
      return { ...model, contextWindow: override, contextWindowProvenance: 'configured_cap' };
    }
    const observed = state.observed.get(model.registryKey);
    if (observed !== undefined && (model.contextWindow <= 0 || observed < model.contextWindow)) {
      return { ...model, contextWindow: observed, contextWindowProvenance: 'observed_limit' };
    }
    return model;
  }
}
