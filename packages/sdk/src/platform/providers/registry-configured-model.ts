/**
 * registry-configured-model.ts, ProviderRegistry's live view of the
 * `provider.model` config key.
 *
 * MEASURED DEFECT this exists to prevent. `provider.model` was written through
 * the daemon's `POST /config`. It persisted to disk AND the daemon's in-memory
 * ConfigManager reported the new value, but the registry had read the key
 * exactly once, in its constructor, and kept the resolved registryKey for the
 * life of the process. A daemon runs for days, so every agent spawned after
 * that write still ran the model configured at boot. The write reported
 * success and changed nothing that mattered, which from the outside is
 * indistinguishable from the write being lost.
 *
 * The fix is a re-read at USE time, not a cache with an invalidation hook: the
 * registry asks this follower on every `getCurrentModel()`, and the follower
 * asks ConfigManager. That covers BOTH write paths for free, an in-process
 * `set()`/`setDynamic()` and an external settings-file edit that the config
 * file watcher reloads, and it needs no `subscribe`, so hosts that construct
 * the registry with a narrow config reader (`get` only) follow config changes
 * exactly like the daemon does.
 *
 * Last write wins, whichever path made it:
 *   - a config write supersedes an earlier in-process `setCurrentModel`,
 *     because the config value CHANGED since we last looked;
 *   - an in-process `setCurrentModel` supersedes the config value it was
 *     chosen over, because the config value has NOT changed since, so a UI
 *     model switch is not undone by the next read.
 */
import { logger } from '../utils/logger.js';
import { emitModelChanged } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { resolveConfiguredModelKey } from './model-id-resolution.js';
import { splitModelRegistryKey } from './registry-helpers.js';

/** Where model resolution lands when `provider.model` is empty. */
export const UNCONFIGURED_MODEL_REGISTRY_KEY = 'openrouter:openrouter/free';

/** The registry rows a bare (provider-less) configured model id resolves against. */
export interface ConfiguredModelCandidate {
  readonly id: string;
  readonly provider: string;
  readonly registryKey: string;
}

export interface ConfiguredModelFollowerDeps {
  /** Reads the raw `provider.model` value from the live config. */
  readonly readConfiguredModel: () => unknown;
  /** The models a bare configured id may resolve against, read lazily, never captured. */
  readonly listModelCandidates: () => readonly ConfiguredModelCandidate[];
  /** Runtime bus for MODEL_CHANGED, or null when the host has none. */
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}

/** The provider half of a registryKey, or '' when the key is not well-formed. */
function providerIdOf(registryKey: string): string {
  try {
    return splitModelRegistryKey(registryKey).providerId ?? '';
  } catch {
    return '';
  }
}

export class ConfiguredModelFollower {
  /** The raw config value the current registryKey was resolved from. */
  private lastResolvedRaw: string;
  /** The raw value whose resolution failure has already been logged (so it is logged once). */
  private lastWarnedRaw: string | null = null;

  constructor(private readonly deps: ConfiguredModelFollowerDeps) {
    this.lastResolvedRaw = this.readRaw();
  }

  private readRaw(): string {
    const raw = this.deps.readConfiguredModel();
    return typeof raw === 'string' ? raw.trim() : '';
  }

  private resolveRegistryKey(raw: string): string {
    if (!raw) return UNCONFIGURED_MODEL_REGISTRY_KEY;
    if (raw.includes(':')) return raw;
    return resolveConfiguredModelKey(raw, this.deps.listModelCandidates());
  }

  /** The registryKey the configured model resolves to right now (construction-time read). */
  initialRegistryKey(): string {
    return this.resolveRegistryKey(this.lastResolvedRaw);
  }

  /**
   * Adopt a `provider.model` write made after construction. Returns the
   * registryKey to use now, `currentRegistryKey` unchanged when config has
   * not moved, when the configured value resolves to the same key, or when a
   * config read or resolution fails (a bad config value must never break model
   * resolution; the previous working model stays in force and the failure is
   * reported once per distinct value).
   */
  adopt(currentRegistryKey: string): string {
    let raw: string;
    try {
      raw = this.readRaw();
    } catch {
      return currentRegistryKey;
    }
    if (raw === this.lastResolvedRaw) return currentRegistryKey;

    let nextRegistryKey: string;
    try {
      nextRegistryKey = this.resolveRegistryKey(raw);
    } catch (error) {
      // Deliberately does NOT advance lastResolvedRaw: a bare model id can
      // become resolvable later (the models.dev catalog hydrates after boot),
      // and the next read should try again rather than pin the boot model
      // forever.
      if (this.lastWarnedRaw !== raw) {
        this.lastWarnedRaw = raw;
        logger.warn('[provider-registry] provider.model changed to a value that does not resolve; keeping the current model', {
          configured: raw,
          keeping: currentRegistryKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return currentRegistryKey;
    }

    this.lastResolvedRaw = raw;
    this.lastWarnedRaw = null;
    if (nextRegistryKey === currentRegistryKey) return currentRegistryKey;
    logger.info('[provider-registry] adopted a provider.model change made after startup', {
      from: currentRegistryKey,
      to: nextRegistryKey,
    });
    const bus = this.deps.runtimeBus;
    if (bus) {
      emitModelChanged(bus, { sessionId: 'system', source: 'provider-registry', traceId: `model:config:${Date.now()}` }, {
        registryKey: nextRegistryKey,
        provider: providerIdOf(nextRegistryKey),
        previous: { registryKey: currentRegistryKey, provider: providerIdOf(currentRegistryKey) },
      });
    }
    return nextRegistryKey;
  }
}
