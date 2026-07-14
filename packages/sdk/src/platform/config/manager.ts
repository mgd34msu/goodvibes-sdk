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
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { migrateDangerDaemonAlias, migrateLegacyFeatureToggles } from './migrations.js';
import {
  SHARED_CONFIG_KEYS,
  isSharedConfigKey,
  persistSharedKey,
  readDotPath,
  readSharedTierFile,
  removeSharedKey,
} from './shared-config-tier.js';
import {
  deleteRawDotPath,
  isFrozenDefaultDump,
  readRawSettingsFile,
  stripFrozenDefaults,
  writeRawDotPath,
} from './settings-io.js';
import { watchConfigFiles, reloadAndNotifyChanges, type ConfigFileWatchHandle } from './config-file-watcher.js';

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

/** Ensure the shared ~/.goodvibes/<surface>.json exists (empty object if not). */
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
  /** Active config-file watch handle (external-edit live reload), or null. */
  private _fileWatch: ConfigFileWatchHandle | null = null;

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
    // settings.json. A configDir-only construction (no homeDir) has no shared tier.
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
        this.persistGlobalKey(key, value);
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
   * Set a single key and persist it to the PROJECT settings overlay (merged
   * into the raw on-disk shape, keeping only explicit keys), leaving the global
   * file untouched — so an approval like fetch.allowLocalhost scopes to this
   * project and survives restarts. Falls back to set() with no project path.
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

  /** Subscribe to changes on a config key; returns an unsubscribe function. */
  subscribe<K extends ConfigKey>(key: K, cb: ConfigChangeCallback<K>): ConfigUnsubscribe {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    // Cast via unknown to avoid deeply-recursive ConfigValue<K> comparison that
    // exceeds TypeScript's stack depth on the 100-entry conditional type.
    const wrapped = (newVal: unknown, oldVal: unknown) => (cb as (n: unknown, o: unknown) => void)(newVal, oldVal);
    this._listeners.get(key)?.add(wrapped);
    return () => {
      this._listeners.get(key)?.delete(wrapped);
    };
  }

  /**
   * Watch the on-disk config files (global, project, shared-tier) for EXTERNAL
   * edits and apply them live through the same subscribe() pipeline an
   * in-process set() uses — no restart. Returns a stop function.
   */
  watchConfigFiles(options: { intervalMs?: number } = {}): () => void {
    this.stopWatchingConfigFiles();
    const paths = [this.configPath, this.projectConfigPath, this.sharedTierPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    this._fileWatch = watchConfigFiles(paths, () => this.reloadFromDiskAndNotify(), options.intervalMs);
    return () => this.stopWatchingConfigFiles();
  }

  /** Stop watching all config files opened by watchConfigFiles(). */
  stopWatchingConfigFiles(): void {
    this._fileWatch?.stop();
    this._fileWatch = null;
  }

  /** Re-read config from disk and fire subscribers for every watched key that changed. */
  private reloadFromDiskAndNotify(): void {
    reloadAndNotifyChanges({
      listenerKeys: this._listeners.keys(),
      get: (key) => this.get(key as ConfigKey),
      load: () => this.load(),
      notify: (key, oldValue, newValue) => {
        this.notifyListeners(key as ConfigKey, oldValue, newValue);
        this.emitConfigHook(key as ConfigKey, oldValue, newValue);
      },
    });
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

  /** Fire the Change:config hook for a config key change. */
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
   * Set a config value from a validated ConfigKey with unknown value type (when
   * iterating schema entries). Runtime validation still applies via set().
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

  /** Return a deep-cloned snapshot of the live config (read-only consumers). */
  getRaw(): Readonly<GoodVibesConfig> {
    return structuredClone(this.config) as Readonly<GoodVibesConfig>;
  }

  /** Return the full schema. */
  getSchema(): ConfigSetting[] {
    return CONFIG_SCHEMA;
  }

  /**
   * Persist a single key to the global settings file by read-merge-write, so
   * hand edits and other keys survive and no default reaches disk unless set.
   */
  private persistGlobalKey(key: ConfigKey, value: unknown): void {
    const raw = readRawSettingsFile(this.configPath);
    writeRawDotPath(raw, key, value);
    this.writeRawGlobal(raw);
  }

  private writeRawGlobal(raw: Record<string, unknown>): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  }

  /**
   * Persist current config to the global settings file, writing only the keys
   * that differ from the shipped defaults (plus unknown keys) — no default is
   * frozen onto disk; resolved config is unchanged on reload.
   */
  save(): void {
    const { config: minimal } = stripFrozenDefaults(
      structuredClone(this.config) as unknown as Record<string, unknown>,
    );
    this.writeRawGlobal(minimal);
  }

  /** Persist current config to the project-level surface settings file. */
  saveProject(): void {
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    const { config: minimal } = stripFrozenDefaults(
      structuredClone(this.config) as unknown as Record<string, unknown>,
    );
    mkdirSync(dirname(this.projectConfigPath), { recursive: true });
    writeFileSync(this.projectConfigPath, JSON.stringify(minimal, null, 2) + '\n', 'utf-8');
  }

  /** Load config from disk: global then project (project wins). Deep-merges with defaults. */
  load(): void {
    // Load global settings
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const migrated = this.applyDefaultStripMigration(
          this.applyLegacySettingsMigration(
            this.applyDangerDaemonMigration(parsed, this.configPath),
            this.configPath,
          ),
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
        const migrated = this.applyDefaultStripMigration(
          this.applyLegacySettingsMigration(
            this.applyDangerDaemonMigration(parsed, this.projectConfigPath),
            this.projectConfigPath,
          ),
          this.projectConfigPath,
        );
        this.config = sanitizeConfigShape(deepMerge(this.config, migrated) as GoodVibesConfig);
      } catch (err) {
        throw new ConfigError(`Project config load failed for ${this.projectConfigPath}: ${summarizeError(err)}`);
      }
    }

    // Overlay the shared tier LAST (it wins over the surface silo) for the
    // shared keys only; an absent shared key falls back to the local value.
    this.loadSharedTier();
  }

  /**
   * Overlay shared-tier values for the shared keys onto the resolved config; a
   * shared key absent from the file is left at its surface-local value. Records
   * which keys were sourced from the shared tier so describeConfigKeySource is
   * honest.
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
   * Report which tier a key's live value resolves from (shared / project /
   * global / default) and whether it rides the shared tier. Reads the on-disk
   * layers on demand so the resolution order is inspectable.
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
   * Removal-of-`danger.daemon` migration (see CHANGELOG 1.0.0): rewrite an
   * explicit legacy `danger.daemon = false` onto `daemon.enabled = false`
   * before the raw JSON is merged, so the removed alias's off-switch is honored
   * rather than flipped on. Logs only when it rewrites; see migrations.ts.
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
      // Keep the in-memory migration; it re-runs idempotently on the next start.
      logger.warn(`Settings migration could not be persisted to ${sourcePath}: ${summarizeError(err)}`);
    }
    const keyList = result.changedKeys.length > 0 ? result.changedKeys.join(', ') : 'no value changes';
    const receiptText = `Settings migrated: legacy featureFlags entries now live on their domain settings keys (${keyList}) in ${sourcePath}.`;
    logger.info(receiptText);
    // The receipt rides the announce-once queue, once per migrated file.
    try {
      new FeatureAnnouncementStore(featureAnnouncementsPath(this)).record(
        `settings-migration-feature-toggles:${sourcePath}`,
        receiptText,
      );
    } catch (err) {
      logger.warn(`Settings-migration receipt could not be queued: ${summarizeError(err)}`);
    }
    if (result.unknownIds.length > 0) {
      logger.warn(`Settings migration dropped unknown legacy entries: ${result.unknownIds.join(', ')} (${sourcePath}).`);
    }
    return result.config;
  }

  /**
   * One invisible pass that strips previously-frozen defaults (leaves equal to
   * the shipped default) from an existing whole-config dump, keeping genuine
   * user values and unknown keys. Drops a one-line receipt through the
   * announce-once queue exactly once per file.
   */
  private applyDefaultStripMigration(parsed: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
    // Conservative: only a whole-config dump (the frozen-defaults artifact) is
    // minimized; a sparse hand-authored file is left untouched (deliberate intent).
    if (!isFrozenDefaultDump(parsed)) return parsed;
    const { config: stripped, changed } = stripFrozenDefaults(parsed);
    if (!changed) return parsed;
    try {
      writeFileSync(sourcePath, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
    } catch (err) {
      // Resolved config is identical either way; the strip re-runs idempotently.
      logger.warn(`Settings default-strip could not be persisted to ${sourcePath}: ${summarizeError(err)}`);
      return stripped;
    }
    const receiptText = `Settings tidied: previously-frozen default values were removed from ${sourcePath}; only your explicit settings remain on disk.`;
    logger.info(receiptText);
    try {
      new FeatureAnnouncementStore(featureAnnouncementsPath(this)).record(
        `settings-defaults-stripped:${sourcePath}`,
        receiptText,
      );
    } catch (err) {
      logger.warn(`Settings default-strip receipt could not be queued: ${summarizeError(err)}`);
    }
    return stripped;
  }

  /**
   * Merge a partial patch into a config category and auto-save — the correct
   * way to update array/object fields that cannot be expressed as a scalar
   * dot-path key (e.g. notifications.webhookUrls). Shallow-merged.
   */
  mergeCategory<C extends keyof GoodVibesConfig>(category: C, patch: Partial<GoodVibesConfig[C]>): void {
    const current = this.config[category]! as Record<string, unknown>;
    const patchObj = patch as Record<string, unknown>;
    const raw = readRawSettingsFile(this.configPath);
    const categoryName = String(category);
    let rawCategory = raw[categoryName];
    if (rawCategory === null || typeof rawCategory !== 'object' || Array.isArray(rawCategory)) {
      rawCategory = {};
      raw[categoryName] = rawCategory;
    }
    const rawCat = rawCategory as Record<string, unknown>;
    // Only the patched keys reach disk — the category's defaults are never frozen in.
    for (const key of Object.keys(patchObj)) {
      if (patchObj[key] !== undefined) {
        current[key] = patchObj[key];
        rawCat[key] = patchObj[key];
      }
    }
    if (Object.keys(rawCat).length === 0) delete raw[categoryName];
    this.writeRawGlobal(raw);
  }

  /**
   * Remove a key from an object-shaped category and auto-save. mergeCategory
   * can only set keys, so clearing an override (e.g. a feature-flag entry back
   * to its default) requires this explicit removal.
   */
  removeCategoryKey<C extends keyof GoodVibesConfig>(category: C, key: string): void {
    const current = this.config[category]! as Record<string, unknown>;
    if (!(key in current)) return;
    delete current[key];
    const raw = readRawSettingsFile(this.configPath);
    const categoryName = String(category);
    const rawCategory = raw[categoryName];
    if (rawCategory !== null && typeof rawCategory === 'object' && !Array.isArray(rawCategory)) {
      const rawCat = rawCategory as Record<string, unknown>;
      delete rawCat[key];
      if (Object.keys(rawCat).length === 0) delete raw[categoryName];
    }
    this.writeRawGlobal(raw);
  }

  /**
   * Reset a specific key to its default, or reset all config.
   * Saves to disk after reset.
   */
  reset(key?: ConfigKey): void {
    if (key === undefined) {
      this.config = cloneDefaultConfig();
      // A full reset means no explicit keys remain — clear the file to defaults.
      this.writeRawGlobal({});
    } else {
      const schema = CONFIG_SCHEMA.find(s => s.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const livePath = this.resolvePath(key);
      livePath.parent[livePath.field] = structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value);
      // Remove the explicit on-disk value so the key falls back to its default.
      const raw = readRawSettingsFile(this.configPath);
      deleteRawDotPath(raw, key);
      this.writeRawGlobal(raw);
    }
    // Reset removes the shared-tier OVERRIDE for any shared key, else a stale
    // shared value would re-overlay on the next load and defeat the reset.
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
