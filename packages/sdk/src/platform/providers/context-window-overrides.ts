/**
 * Persisted per-model context-window overrides.
 *
 * A user-configured context window (set via a consumer surface such as the
 * TUI's /context-window command or the model picker's context-cap flow) is
 * stored as registryKey -> tokens and applied by ProviderRegistry as an
 * overlay with provenance 'configured_cap', which getContextWindowForModel
 * treats as authoritative. Clearing an override returns the model to its
 * automatic window (catalog / provider API / family fallback).
 *
 * The file lives in the control-plane config dir, so overrides reach every
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
  version: 1;
  overrides: Record<string, number>;
}

export function getContextWindowOverridesPath(configDir: string): string {
  return join(configDir, 'context-window-overrides.json');
}

/** True when the value is usable as a context window override. */
export function isValidContextWindowOverride(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_CONTEXT_WINDOW_OVERRIDE;
}

/**
 * Load persisted overrides. Malformed files and invalid entries are dropped
 * with a warning — never poison downstream window math with a bad value.
 */
export function loadContextWindowOverrides(filePath: string): Map<string, number> {
  const overrides = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return overrides; // missing file = no overrides (first run)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ContextWindowOverridesFile> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.overrides !== 'object' || parsed.overrides === null) {
      logger.warn('[context-window-overrides] Ignoring malformed overrides file', { filePath });
      return overrides;
    }
    for (const [registryKey, value] of Object.entries(parsed.overrides)) {
      if (typeof value === 'number' && isValidContextWindowOverride(value)) {
        overrides.set(registryKey, value);
      } else {
        logger.warn('[context-window-overrides] Dropping invalid override entry', { registryKey, value });
      }
    }
  } catch (error) {
    logger.warn('[context-window-overrides] Failed to parse overrides file', {
      filePath,
      error: summarizeError(error),
    });
  }
  return overrides;
}

/**
 * Owns the per-model override map: lazy disk load, validated set/clear with
 * persistence, and the 'configured_cap' overlay applied to model definitions.
 * ProviderRegistry delegates here so override policy lives in one place.
 */
export class ContextWindowOverrideStore {
  private overrides: Map<string, number> | null = null;

  constructor(private readonly filePath: string) {}

  private load(): Map<string, number> {
    this.overrides ??= loadContextWindowOverrides(this.filePath);
    return this.overrides;
  }

  /** The configured window for a model, or null when automatic. */
  get(registryKey: string): number | null {
    return this.load().get(registryKey) ?? null;
  }

  /** Validate, store, and persist an override. Returns false (and stores nothing) for invalid caps. */
  set(registryKey: string, cap: number): boolean {
    if (!isValidContextWindowOverride(cap)) return false;
    const overrides = this.load();
    overrides.set(registryKey, cap);
    saveContextWindowOverrides(this.filePath, overrides);
    return true;
  }

  /** Remove an override and persist. Returns true when one existed. */
  clear(registryKey: string): boolean {
    const overrides = this.load();
    const existed = overrides.delete(registryKey);
    if (existed) saveContextWindowOverrides(this.filePath, overrides);
    return existed;
  }

  /**
   * Overlay a configured window onto a model definition. 'configured_cap'
   * provenance is authoritative downstream — getContextWindowForModel never
   * widens or narrows it.
   */
  apply(model: ModelDefinition): ModelDefinition {
    const override = this.load().get(model.registryKey);
    if (override === undefined) return model;
    return { ...model, contextWindow: override, contextWindowProvenance: 'configured_cap' };
  }
}

/** Persist overrides. Write failures are logged, not thrown — the in-memory override still applies this session. */
export function saveContextWindowOverrides(filePath: string, overrides: ReadonlyMap<string, number>): void {
  const file: ContextWindowOverridesFile = {
    version: 1,
    overrides: Object.fromEntries([...overrides.entries()].sort(([a], [b]) => a.localeCompare(b))),
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
