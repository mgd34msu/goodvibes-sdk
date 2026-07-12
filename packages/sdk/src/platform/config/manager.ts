import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.js';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookEvent } from '../hooks/types.js';
import { getManagedSettingLock } from '../runtime/settings/control-plane.js';
import { requireSurfaceRoot, resolveSharedDirectory, resolveSurfaceDirectory, resolveSurfaceSharedFile } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { toRecord } from '../utils/record-coerce.js';
import { migrateDangerDaemonAlias, migrateLegacyFeatureToggles } from './migrations.js';
import {
  SHARED_CONFIG_KEYS,
  isSharedConfigKey,
  persistSharedKey,
  readDotPath,
  readSharedTierFile,
  removeSharedKey,
} from './shared-config-tier.js';

/** Deep immutable type — prevents mutation of nested objects returned from getAll(). */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** Constructor overrides for CLI args and programmatic instantiation. */
interface ConfigCliOverrides {
  model?: string | undefined;
  autoApprove?: boolean | undefined;
  systemPromptFile?: string | undefined;
  workingDir?: string | undefined;
  surfaceRoot?: string | undefined;
}

export type ConfigOverrides = ConfigCliOverrides & (
  | {
    configDir: string;
    homeDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
  }
  | {
    homeDir: string;
    configDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
  }
);

interface ConfigRoots {
  configDir?: string | undefined;
  homeDir?: string | undefined;
  sharedConfigPath?: string | undefined;
  sharedTierPath?: string | undefined;
  surfaceRoot?: string | undefined;
}

/** The tier a resolved config value came from — inspectable via describeConfigKeySource. */
export type ConfigKeyTier = 'shared' | 'project' | 'global' | 'default';

/** Where a config key's live value resolves from, and whether it rides the shared tier. */
export interface ConfigKeySource {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly tier: ConfigKeyTier;
  /** True when this key resolves from/writes to the surface-root-independent shared tier. */
  readonly shareable: boolean;
  /** The shared-tier settings file path, or null when no shared tier is configured. */
  readonly sharedTierPath: string | null;
}

export interface ConfigSetOptions {
  bypassManagedLock?: boolean | undefined;
}

/** Callback invoked when a watched config key changes. */
export type ConfigChangeCallback<K extends ConfigKey> = (newValue: ConfigValue<K>, oldValue: ConfigValue<K>) => void;

/** Unsubscribe handle returned by ConfigManager.subscribe(). */
export type ConfigUnsubscribe = () => void;

const DEFAULT_CONFIG_SNAPSHOT = structuredClone(DEFAULT_CONFIG) as GoodVibesConfig;
const PERMISSION_TOOL_KEYS = new Set(Object.keys(DEFAULT_CONFIG.permissions.tools));

function cloneDefaultConfig(): GoodVibesConfig {
  return structuredClone(DEFAULT_CONFIG_SNAPSHOT) as GoodVibesConfig;
}

function sanitizeConfigShape(config: GoodVibesConfig): GoodVibesConfig {
  const sanitized = structuredClone(config) as GoodVibesConfig;
  for (const key of Object.keys(sanitized.permissions.tools)) {
    if (!PERMISSION_TOOL_KEYS.has(key)) {
      delete (sanitized.permissions.tools as Record<string, unknown>)[key];
    }
  }
  return sanitized;
}

function requireAbsoluteOwnedPath(path: string | undefined, name: string): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`ConfigManager ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`ConfigManager ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

/**
 * Ensure the shared ~/.goodvibes/<surface>.json exists (empty object if not).
 * This is reserved for future cross-app use — no TUI settings go here.
 */
function ensureSharedConfig(sharedPath: string): void {
  if (!existsSync(sharedPath)) {
    mkdirSync(dirname(sharedPath), { recursive: true });
    writeFileSync(sharedPath, '{}\n', 'utf-8');
  }
}

/**
 * ConfigManager — Layered, mutable, persistent config system.
 *
 * Load order: defaults < global surface settings < project surface settings < CLI overrides
 * API keys are never persisted — loaded from env vars only.
 */
export class ConfigManager {
  private config: GoodVibesConfig;
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly projectConfigPath: string | null;
  private readonly workingDirectory: string | null;
  private readonly homeDirectory: string | null;
  /** Surface-root-independent shared settings file (~/.goodvibes/shared/settings.json), or null. */
  private readonly sharedTierPath: string | null;
  /** Shared keys whose value the last load actually sourced from the shared tier file. */
  private readonly sharedKeysPresent = new Set<ConfigKey>();
  private hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null;
  private readonly _listeners = new Map<string, Set<(newVal: unknown, oldVal: unknown) => void>>();

  constructor(overrides: ConfigOverrides) {
    const roots = overrides as ConfigRoots;
    const configDir = requireAbsoluteOwnedPath(roots.configDir, 'configDir');
    const homeDirectory = requireAbsoluteOwnedPath(roots.homeDir, 'homeDir') ?? null;
    const workingDirectory = requireAbsoluteOwnedPath(overrides.workingDir, 'workingDir') ?? null;
    const sharedConfigPath = requireAbsoluteOwnedPath(roots.sharedConfigPath, 'sharedConfigPath');
    const surfaceRoot = roots.surfaceRoot ? requireSurfaceRoot(roots.surfaceRoot, 'ConfigManager surfaceRoot') : null;
    if ((!configDir || workingDirectory || homeDirectory) && !surfaceRoot) {
      throw new Error('ConfigManager surfaceRoot is required when deriving config paths from homeDir/workingDir.');
    }
    const base = configDir ?? resolveSurfaceDirectory(homeDirectory!, surfaceRoot!);
    this.configDir = base;
    this.configPath = join(base, 'settings.json');
    this.workingDirectory = workingDirectory;
    this.homeDirectory = homeDirectory;
    this.projectConfigPath = this.workingDirectory
      ? resolveSurfaceDirectory(this.workingDirectory, surfaceRoot!, 'settings.json')
      : null;
    this.config = cloneDefaultConfig();

    const ownedSharedConfigPath = sharedConfigPath ?? (
      this.homeDirectory ? resolveSurfaceSharedFile(this.homeDirectory, surfaceRoot!) : null
    );
    if (ownedSharedConfigPath) {
      ensureSharedConfig(ownedSharedConfigPath);
    }

    // The surface-root-INDEPENDENT shared tier for cross-surface keys (tts.*):
    // an explicit override, else derived from homeDir as ~/.goodvibes/shared/
    // settings.json. A configDir-only construction with no homeDir has no shared
    // tier (legacy per-surface behavior preserved).
    const sharedTierPath = requireAbsoluteOwnedPath(roots.sharedTierPath, 'sharedTierPath');
    this.sharedTierPath = sharedTierPath ?? (
      this.homeDirectory ? resolveSharedDirectory(this.homeDirectory, 'shared', 'settings.json') : null
    );

    this.load();

    // Apply constructor overrides (CLI args, etc.) after load
    if (overrides.model !== undefined) {
      this.config.provider.model = overrides.model;
    }
    if (overrides.autoApprove !== undefined) {
      this.config.behavior.autoApprove = overrides.autoApprove;
    }
    if (overrides.systemPromptFile !== undefined) {
      this.config.provider.systemPromptFile = overrides.systemPromptFile;
    }
  }

  getControlPlaneConfigDir(): string {
    return this.configDir;
  }

  getWorkingDirectory(): string | null {
    return this.workingDirectory;
  }

  getHomeDirectory(): string | null {
    return this.homeDirectory;
  }

  /**
   * Returns the absolute path to the global (surface-level) settings.json file.
   * Consumers should use this instead of casting through `as unknown` to access
   * the private `configPath` field.
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Returns the absolute path to the project-level settings.json file, or
   * `undefined` if no `workingDir` was provided at construction time.
   */
  getProjectConfigPath(): string | undefined {
    return this.projectConfigPath ?? undefined;
  }

  attachHookDispatcher(hookDispatcher: Pick<HookDispatcher, 'fire'> | null): void {
    this.hookDispatcher = hookDispatcher;
  }

  private resolvePath(
    key: ConfigKey,
  ): { parent: Record<string, unknown>; field: string } {
    const parts = key.split('.');
    let cursor: unknown = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as Record<string, unknown>))) {
        throw new Error(`Invalid config path: section '${parts.slice(0, i + 1).join('.')}' does not exist`);
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor == null || typeof cursor !== 'object') {
      throw new Error(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
    }

    return {
      parent: cursor as Record<string, unknown>,
      field: parts[parts.length - 1]!,
    };
  }

  /** Get a config value by dot-path key. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.resolvePath(key);
    return parent[field] as ConfigValue<K>;
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    const schema = CONFIG_SCHEMA.find(s => s.key === key);
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }

    const { parent, field } = this.resolvePath(key);
    const previousValue = parent[field]!;
    parent[field] = value;
    // Shared keys persist to the surface-root-independent shared tier so every
    // surface sees the same value; everything else stays in the surface silo.
    const useSharedTier = this.sharedTierPath !== null && isSharedConfigKey(key);
    try {
      if (useSharedTier) {
        persistSharedKey(this.sharedTierPath!, key, value);
      } else {
        this.save();
      }
    } catch (error) {
      parent[field] = previousValue;
      throw error;
    }
    if (useSharedTier) this.sharedKeysPresent.add(key);
    this.notifyListeners(key, previousValue, value);
    this.emitConfigHook(key, previousValue, value);
  }

  /**
   * Set a single key and persist it to the PROJECT settings overlay, leaving
   * the global settings file untouched. The project file keeps only its own
   * explicit keys — the new value is merged into the raw on-disk shape rather
   * than writing the full resolved config, so an approval like
   * fetch.allowLocalhost scopes to this project and survives restarts. Falls
   * back to the global set() when no project settings path exists.
   */
  setProjectValue<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    if (!this.projectConfigPath) {
      (this.set as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    const schema = CONFIG_SCHEMA.find(s => s.key === key);
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }
    const { parent, field } = this.resolvePath(key);
    const previousValue = parent[field];
    parent[field] = value;
    let raw: Record<string, unknown> = {};
    try {
      if (existsSync(this.projectConfigPath)) {
        raw = JSON.parse(readFileSync(this.projectConfigPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
    const segments = key.split('.');
    let cursor: Record<string, unknown> = raw;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = value;
    try {
      mkdirSync(dirname(this.projectConfigPath), { recursive: true });
      writeFileSync(this.projectConfigPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    } catch (error) {
      parent[field] = previousValue;
      throw error;
    }
    this.notifyListeners(key, previousValue, value);
    this.emitConfigHook(key, previousValue, value);
  }

  /**
   * Subscribe to changes on a specific config key.
   * Returns an unsubscribe function. Safe to call multiple times.
   */
  subscribe<K extends ConfigKey>(key: K, cb: ConfigChangeCallback<K>): ConfigUnsubscribe {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    // Cast via unknown -> (n: unknown, o: unknown) => void to avoid deeply-recursive ConfigValue<K> comparison
    // that exceeds TypeScript's stack depth limit on the 100-entry conditional type.
    const wrapped = (newVal: unknown, oldVal: unknown) => (cb as (n: unknown, o: unknown) => void)(newVal, oldVal);
    this._listeners.get(key)?.add(wrapped);
    return () => {
      this._listeners.get(key)?.delete(wrapped);
    };
  }

  /** Notify synchronous subscribers of a key change. */
  private notifyListeners(key: ConfigKey, oldValue: unknown, newValue: unknown): void {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(newValue, oldValue);
      } catch (error) {
        logger.warn('Config listener failed during setting update', {
          key,
          error: summarizeError(error),
        });
      }
    }
  }

  /**
   * Fire the Change:config hook for a config key change.
   */
  private emitConfigHook(key: ConfigKey, previousValue: unknown, newValue: unknown): void {
    if (!this.hookDispatcher) return;
    try {
      const event: HookEvent = {
        path: `Change:config:${key}`,
        phase: 'Change',
        category: 'config',
        specific: key,
        sessionId: '',
        timestamp: Date.now(),
        payload: { key, value: newValue, previousValue },
      };
      this.hookDispatcher.fire(event).catch((error: unknown) => {
        logger.warn('[config] Change hook failed', {
          key,
          error: summarizeError(error),
        });
      });
    } catch (error) {
      logger.warn('[config] Change hook dispatch failed', {
        key,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Set a config value from a validated ConfigKey with unknown value type.
   * Used when iterating schema entries where the value type cannot be statically
   * inferred. Runtime validation is still applied by the underlying set() method.
   */
  setDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.set(key, value as never, options);
  }

  /** Return a deep-readonly snapshot of the full config. Nested objects are immutable. */
  getAll(): DeepReadonly<GoodVibesConfig> {
    return structuredClone(this.config) as DeepReadonly<GoodVibesConfig>;
  }

  /** Return a deep-cloned snapshot of a config category. */
  getCategory<C extends keyof GoodVibesConfig>(category: C): Readonly<GoodVibesConfig[C]> {
    return structuredClone(this.config[category]);
  }

  /** Return a deep-cloned snapshot of the live config. Safe for read-only external consumers. */
  getRaw(): Readonly<GoodVibesConfig> {
    return structuredClone(this.config) as Readonly<GoodVibesConfig>;
  }

  /** Return the full schema. */
  getSchema(): ConfigSetting[] {
    return CONFIG_SCHEMA;
  }

  /** Persist current config to global TUI settings file. */
  save(): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
  }

  /** Persist current config to the project-level surface settings file. */
  saveProject(): void {
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    mkdirSync(dirname(this.projectConfigPath), { recursive: true });
    writeFileSync(this.projectConfigPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
  }

  /** Load config from disk: global then project (project wins). Deep-merges with defaults. */
  load(): void {
    // Load global settings
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const migrated = this.applyLegacySettingsMigration(
          this.applyDangerDaemonMigration(parsed, this.configPath),
          this.configPath,
        );

        this.config = sanitizeConfigShape(deepMerge(cloneDefaultConfig(), migrated) as GoodVibesConfig);
      } catch (err) {
        throw new ConfigError(`Global config load failed for ${this.configPath}: ${summarizeError(err)}`);
      }
    }

    // Load project settings and deep-merge on top (project wins)
    if (this.projectConfigPath && existsSync(this.projectConfigPath)) {
      try {
        const raw = readFileSync(this.projectConfigPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const migrated = this.applyLegacySettingsMigration(
          this.applyDangerDaemonMigration(parsed, this.projectConfigPath),
          this.projectConfigPath,
        );
        this.config = sanitizeConfigShape(deepMerge(this.config, migrated) as GoodVibesConfig);
      } catch (err) {
        throw new ConfigError(`Project config load failed for ${this.projectConfigPath}: ${summarizeError(err)}`);
      }
    }

    // Overlay the surface-root-independent shared tier LAST (it wins over the
    // surface silo) for the shared keys only — so every surface resolves the same
    // voice, while a key absent from the shared file falls back to the local value.
    this.loadSharedTier();
  }

  /**
   * Overlay any shared-tier values for the shared keys onto the resolved config.
   * A shared key absent from the shared file is left at its surface-local value
   * (the fallback that keeps existing setups working). Records which keys were
   * actually sourced from the shared tier so describeConfigKeySource is honest.
   */
  private loadSharedTier(): void {
    this.sharedKeysPresent.clear();
    if (!this.sharedTierPath) return;
    let shared: Record<string, unknown>;
    try {
      shared = readSharedTierFile(this.sharedTierPath);
    } catch (err) {
      throw new ConfigError(`Shared config load failed for ${this.sharedTierPath}: ${summarizeError(err)}`);
    }
    for (const key of SHARED_CONFIG_KEYS) {
      const found = readDotPath(shared, key);
      if (!found.present) continue;
      const { parent, field } = this.resolvePath(key);
      parent[field] = found.value;
      this.sharedKeysPresent.add(key);
    }
  }

  /** The shared-tier settings file path, or null when no shared tier is configured. */
  getSharedTierPath(): string | null {
    return this.sharedTierPath;
  }

  /**
   * Report which tier a key's live value resolves from (shared / project / global
   * / default) and whether it rides the shared tier. Reads the on-disk layers on
   * demand so the resolution order is inspectable, not just documented.
   */
  describeConfigKeySource(key: ConfigKey): ConfigKeySource {
    const value = this.get(key);
    const shareable = isSharedConfigKey(key);
    if (shareable && this.sharedKeysPresent.has(key)) {
      return { key, value, tier: 'shared', shareable, sharedTierPath: this.sharedTierPath };
    }
    if (this.projectConfigPath && this.fileHasKey(this.projectConfigPath, key)) {
      return { key, value, tier: 'project', shareable, sharedTierPath: this.sharedTierPath };
    }
    if (this.fileHasKey(this.configPath, key)) {
      return { key, value, tier: 'global', shareable, sharedTierPath: this.sharedTierPath };
    }
    return { key, value, tier: 'default', shareable, sharedTierPath: this.sharedTierPath };
  }

  /** True when the JSON settings file at `path` carries an explicit value for `key`. */
  private fileHasKey(path: string, key: ConfigKey): boolean {
    if (!existsSync(path)) return false;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return readDotPath(parsed, key).present;
    } catch {
      return false;
    }
  }

  /**
   * Removal-of-`danger.daemon` migration (see CHANGELOG 1.0.0): rewrite an explicit legacy
   * `danger.daemon = false` onto `daemon.enabled = false` before the raw JSON
   * is merged with defaults, so the removed alias's two-year off-switch is
   * honored rather than silently flipped on. Reports honestly via the logger
   * when it actually rewrites a value; a no-op migration (alias absent, or
   * `= true`) stays silent. See migrations.ts for the full contract.
   */
  private applyDangerDaemonMigration(parsed: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
    const result = migrateDangerDaemonAlias(parsed);
    if (result.rewroteDaemonEnabledFalse) {
      logger.info(
        `Migrated deprecated 'danger.daemon: false' to 'daemon.enabled: false' (${sourcePath}). ` +
        `The legacy off-switch is preserved; 'danger.daemon' is no longer read.`,
      );
    }
    return result.config;
  }

  /**
   * Legacy featureFlags-record migration: entries dissolve onto the per-domain
   * settings keys that now own each capability (see migrateLegacyFeatureToggles
   * for the mapping contract). The rewritten file is persisted immediately so
   * the migration runs exactly once, with a one-line receipt.
   */
  private applyLegacySettingsMigration(parsed: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
    const result = migrateLegacyFeatureToggles(parsed);
    if (!result.migrated) return parsed;
    try {
      writeFileSync(sourcePath, JSON.stringify(result.config, null, 2) + '\n', 'utf-8');
    } catch (err) {
      // Keep the in-memory migration even when the write-back fails; it will
      // simply re-run (idempotently) on the next start.
      logger.warn(`Settings migration could not be persisted to ${sourcePath}: ${summarizeError(err)}`);
    }
    const keyList = result.changedKeys.length > 0 ? result.changedKeys.join(', ') : 'no value changes';
    logger.info(
      `Settings migrated: legacy featureFlags entries now live on their domain settings keys (${keyList}) in ${sourcePath}.`,
    );
    if (result.unknownIds.length > 0) {
      logger.warn(`Settings migration dropped unknown legacy entries: ${result.unknownIds.join(', ')} (${sourcePath}).`);
    }
    return result.config;
  }

  /**
   * Merge a partial patch into a config category and auto-save.
   *
   * This is the correct way to update array or object fields within a category
   * that cannot be expressed as a scalar dot-path key (e.g. notifications.webhookUrls).
   * The patch is shallow-merged into the existing category value.
   */
  mergeCategory<C extends keyof GoodVibesConfig>(category: C, patch: Partial<GoodVibesConfig[C]>): void {
    const current = this.config[category]! as Record<string, unknown>;
    const patchObj = patch as Record<string, unknown>;
    for (const key of Object.keys(patchObj)) {
      if (patchObj[key] !== undefined) {
        current[key] = patchObj[key];
      }
    }
    this.save();
  }

  /**
   * Remove a key from an object-shaped category and auto-save.
   *
   * mergeCategory can only set keys (undefined patch values are skipped, and
   * getCategory returns a clone, so delete-then-merge is a silent no-op) —
   * clearing an override, e.g. a feature-flag entry back to its default,
   * requires this explicit removal.
   */
  removeCategoryKey<C extends keyof GoodVibesConfig>(category: C, key: string): void {
    const current = this.config[category]! as Record<string, unknown>;
    if (!(key in current)) return;
    delete current[key];
    this.save();
  }

  /**
   * Reset a specific key to its default, or reset all config.
   * Saves to disk after reset.
   */
  reset(key?: ConfigKey): void {
    if (key === undefined) {
      this.config = cloneDefaultConfig();
    } else {
      const schema = CONFIG_SCHEMA.find(s => s.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const livePath = this.resolvePath(key);
      const defaultPath = resolveArbitraryPath(toRecord(DEFAULT_CONFIG_SNAPSHOT), key);
      livePath.parent[livePath.field] = structuredClone(defaultPath.parent[defaultPath.field]);
    }
    this.save();
    // Reset removes the shared-tier OVERRIDE for any shared key, so the key falls
    // back to its surface-local/default value — otherwise a stale shared value
    // would re-overlay on the next load and defeat the reset.
    if (this.sharedTierPath) {
      const resetKeys = key === undefined ? SHARED_CONFIG_KEYS : (isSharedConfigKey(key) ? [key] : []);
      for (const sharedKey of resetKeys) {
        removeSharedKey(this.sharedTierPath, sharedKey);
        this.sharedKeysPresent.delete(sharedKey);
      }
    }
  }
}

/** Deep-merge source into target. Returns a new object. Source non-objects are ignored — target clone is returned.
 * Non-object source values will not overwrite object target values (type-safe merge). */
function deepMerge(target: unknown, source: unknown): unknown {
  const result: Record<string, unknown> = isObject(target)
    ? structuredClone(target) as Record<string, unknown>
    : {};
  if (!isObject(source)) return result;
  for (const key of Object.keys(source)) {
    const sv = source[key]!;
    const tv = result[key]!;
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined && !isObject(tv)) {
      // Only overwrite non-object target values — never replace an object with a scalar.
      // Clone assigned values so config instances never share mutable references.
      result[key] = structuredClone(sv);
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function resolveArbitraryPath(
  root: Record<string, unknown>,
  key: string,
): { parent: Record<string, unknown>; field: string } {
  const parts = key.split('.');
  let cursor: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as Record<string, unknown>))) {
      throw new Error(`Invalid config path: section '${parts.slice(0, i + 1).join('.')}' does not exist`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor == null || typeof cursor !== 'object') {
    throw new Error(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
  }
  return {
    parent: cursor as Record<string, unknown>,
    field: parts[parts.length - 1]!,
  };
}
