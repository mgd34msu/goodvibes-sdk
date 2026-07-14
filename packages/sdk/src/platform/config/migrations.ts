/**
 * One-shot config migrations applied to raw on-disk JSON before it is
 * deep-merged with defaults in {@link ConfigManager.load}.
 *
 * CHANGELOG 1.0.0 removes the deprecated `danger.daemon` alias from the schema
 * (see docs/decisions/2026-07-05-daemon-by-default.md). Once the key leaves
 * `CONFIG_SCHEMA`/`ConfigKey`, a stray `danger.daemon` value in an existing
 * settings.json would otherwise be silently ignored by the deep-merge (the
 * default config's `danger` object no longer declares a `daemon` field to
 * merge onto) — which would flip a user's explicit two-year off-switch
 * (`danger.daemon = false`) back to daemon-ON the moment they upgrade. This
 * migration closes that hazard by rewriting the explicit choice onto
 * `daemon.enabled` BEFORE the merge, so the alias is honored exactly once
 * and then retired.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface DangerDaemonMigrationResult {
  /** True if the raw config carried a `danger.daemon` key that this migration touched. */
  readonly migrated: boolean;
  /** The (possibly rewritten) raw config, safe to deep-merge with defaults. */
  readonly config: Record<string, unknown>;
  /**
   * Present only when an explicit `danger.daemon = false` was rewritten onto
   * `daemon.enabled = false` — the one case that changes resolved behavior.
   * Callers can use this to report the migration honestly (e.g. a log line).
   */
  readonly rewroteDaemonEnabledFalse: boolean;
}

/**
 * Migrate a raw parsed settings object: `danger.daemon` (a deprecated alias
 * for `daemon.enabled`, removed in CHANGELOG 1.0.0) is removed, and if it was
 * explicitly `false`, that choice is preserved onto `daemon.enabled = false`.
 *
 * Precedence mirrors the alias it replaces (see the removed
 * `resolveDaemonEnabled` alias branch): an explicit `danger.daemon` value
 * always wins over whatever `daemon.enabled` currently holds in the same
 * file, because the alias historically took precedence.
 *
 * Idempotent: config that has already been migrated (or never had the alias)
 * comes back unchanged — `migrated: false`, same reference.
 *
 * - `danger.daemon === false` -> `daemon.enabled = false` (rewritten), alias removed.
 * - `danger.daemon === true`  -> alias removed, no rewrite (daemon.enabled
 *   already defaults `true`; nothing to preserve).
 * - non-boolean junk under the key -> alias removed, no rewrite.
 * - absent / not an object -> unchanged.
 */
export function migrateDangerDaemonAlias(parsed: Record<string, unknown>): DangerDaemonMigrationResult {
  const danger = parsed['danger'];
  if (!isPlainObject(danger) || !('daemon' in danger)) {
    return { migrated: false, config: parsed, rewroteDaemonEnabledFalse: false };
  }

  const alias = danger['daemon'];
  const { daemon: _removedAlias, ...restDanger } = danger;
  const nextConfig: Record<string, unknown> = { ...parsed, danger: restDanger };

  if (alias === false) {
    const existingDaemon = isPlainObject(parsed['daemon']) ? parsed['daemon'] : {};
    nextConfig['daemon'] = { ...existingDaemon, enabled: false };
    return { migrated: true, config: nextConfig, rewroteDaemonEnabledFalse: true };
  }

  // alias === true, or non-boolean junk: nothing to preserve — daemon.enabled
  // already defaults true, and a non-boolean value was never a valid override.
  return { migrated: true, config: nextConfig, rewroteDaemonEnabledFalse: false };
}

// ── Legacy featureFlags record -> domain settings ───────────────────────────

export interface LegacySettingsMigrationResult {
  /** True when the raw config carried legacy keys this migration rewrote. */
  readonly migrated: boolean;
  /** The (possibly rewritten) raw config, safe to deep-merge with defaults. */
  readonly config: Record<string, unknown>;
  /** Dot-path keys this migration wrote (for the one-line receipt). */
  readonly changedKeys: readonly string[];
  /** Legacy ids that mapped to nothing (unknown or stale). */
  readonly unknownIds: readonly string[];
}

function cloneShallowPath(config: Record<string, unknown>, segments: readonly string[]): Record<string, unknown> {
  // Ensure every object along the path is a fresh copy on `config` so writes
  // never mutate the caller's parsed object.
  let cursor = config;
  for (const segment of segments) {
    const existing = cursor[segment];
    const copy = isPlainObject(existing) ? { ...existing } : {};
    cursor[segment] = copy;
    cursor = copy;
  }
  return cursor;
}

function writeDotPath(config: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split('.');
  const field = segments.pop() as string;
  const parent = segments.length > 0 ? cloneShallowPath(config, segments) : config;
  parent[field] = value;
}

function readDot(config: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = config;
  for (const segment of key.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

type LegacyToggleState = 'enabled' | 'disabled' | 'killed';

function isLegacyToggleState(value: unknown): value is LegacyToggleState {
  return value === 'enabled' || value === 'disabled' || value === 'killed';
}

/** Legacy ids whose OFF state forces a boolean domain key false; ON defers to the key. */
const LEGACY_OFF_FORCES_FALSE: Readonly<Record<string, string>> = {
  'automation-domain': 'automation.enabled',
  'web-surface': 'web.enabled',
  'watcher-framework': 'watchers.enabled',
  'service-management': 'service.enabled',
  'exec-sandbox': 'sandbox.enabled',
  'relay-connect': 'relay.enabled',
  'control-plane-gateway': 'controlPlane.gateway',
  'slack-surface': 'surfaces.slack.enabled',
  'discord-surface': 'surfaces.discord.enabled',
  'ntfy-surface': 'surfaces.ntfy.enabled',
  'webhook-surface': 'surfaces.webhook.enabled',
  'homeassistant-surface': 'surfaces.homeassistant.enabled',
};

/** Legacy ids that map 1:1 onto a boolean domain key (both states written). */
const LEGACY_BOOLEAN_KEYS: Readonly<Record<string, string>> = {
  'permissions-simulation': 'permissions.simulation',
  'permission-divergence-dashboard': 'permissions.divergenceDashboard',
  'policy-signing': 'policy.requireSignedBundles',
  'policy-as-code': 'policy.registryEnabled',
  'unified-runtime-task': 'runtime.unifiedTasks',
  'plugin-lifecycle': 'runtime.pluginLifecycle',
  'mcp-lifecycle': 'runtime.mcpLifecycle',
  'runtime-tools-budget-enforcement': 'runtime.toolBudget.enforced',
  'tool-contract-verification': 'tools.contractVerification',
  'output-schema-fingerprint': 'tools.outputSchemaFingerprints',
  'local-provider-context-ingestion': 'provider.localContextIngestion',
  'adaptive-execution-planner': 'planner.adaptive',
  'token-scope-rotation-audit': 'security.tokenAudit.enabled',
  'adaptive-notification-suppression': 'notifications.adaptiveSuppression',
  'integration-delivery-slo': 'integrations.delivery.sloEnforced',
  'route-binding': 'integrations.routeBinding',
  'delivery-engine': 'integrations.deliveryTracking',
  'agent-passive-knowledge-injection': 'agents.passiveInjection.knowledge',
  'agent-passive-code-injection': 'agents.passiveInjection.code',
  'agent-context-window-awareness': 'agents.contextWindowGuard',
};

/**
 * Migrate the legacy `featureFlags` record (and the renamed
 * `sandbox.judgmentAutoApprove` key) onto the per-domain settings keys that
 * now own each capability. Runs on the raw parsed settings object before the
 * defaults merge; the caller persists the rewritten file so this happens once.
 *
 * Mapping rules preserve the user's EXPLICIT choices, not old defaults:
 * - A legacy 'disabled' (or 'killed') entry writes the feature's domain key
 *   off (e.g. behavior.compactionStrategy = 'off', sandbox.enabled = false).
 * - A legacy 'enabled' entry defers to the domain key where one already
 *   existed (automation.enabled, web.enabled, ...), because the legacy
 *   effective state was the AND of both switches; for keys that replaced the
 *   toggle outright it writes the on value.
 * - Related toggles collapse into their real option shape: the compaction
 *   pair -> behavior.compactionStrategy, the otel pair -> telemetry.otelMode,
 *   judgment + judgmentAutoApprove -> sandbox.judgment.
 *
 * Idempotent: a config with no legacy keys comes back unchanged, same reference.
 */
export function migrateLegacyFeatureToggles(parsed: Record<string, unknown>): LegacySettingsMigrationResult {
  const legacyRecord = isPlainObject(parsed['featureFlags']) ? parsed['featureFlags'] : null;
  const sandboxSection = isPlainObject(parsed['sandbox']) ? parsed['sandbox'] : null;
  const hasLegacyJudgment = sandboxSection !== null && 'judgmentAutoApprove' in sandboxSection;
  const hasLegacyRecord = legacyRecord !== null && 'featureFlags' in parsed;
  if (!hasLegacyRecord && !hasLegacyJudgment) {
    return { migrated: false, config: parsed, changedKeys: [], unknownIds: [] };
  }

  const config: Record<string, unknown> = { ...parsed };
  const changedKeys: string[] = [];
  const unknownIds: string[] = [];
  const write = (key: string, value: unknown): void => {
    writeDotPath(config, key, value);
    changedKeys.push(key);
  };

  const states = new Map<string, LegacyToggleState>();
  if (legacyRecord) {
    for (const [id, value] of Object.entries(legacyRecord)) {
      if (isLegacyToggleState(value)) states.set(id, value);
      else unknownIds.push(id);
    }
    delete config['featureFlags'];
  }
  const on = (id: string): boolean => states.get(id) === 'enabled';
  const off = (id: string): boolean => {
    const s = states.get(id);
    return s === 'disabled' || s === 'killed';
  };

  const handled = new Set<string>();
  const handle = (id: string): void => { handled.add(id); };

  for (const [id, key] of Object.entries(LEGACY_BOOLEAN_KEYS)) {
    if (!states.has(id)) continue;
    handle(id);
    write(key, on(id));
  }
  for (const [id, key] of Object.entries(LEGACY_OFF_FORCES_FALSE)) {
    if (!states.has(id)) continue;
    handle(id);
    if (off(id)) write(key, false);
  }

  // permissions-policy-engine -> permissions.engine
  if (states.has('permissions-policy-engine')) {
    handle('permissions-policy-engine');
    write('permissions.engine', on('permissions-policy-engine') ? 'policy-engine' : 'baseline');
  }
  // shell-ast-normalization -> permissions.commandParser
  if (states.has('shell-ast-normalization')) {
    handle('shell-ast-normalization');
    write('permissions.commandParser', on('shell-ast-normalization') ? 'ast' : 'flat');
  }
  // tool-result-reconciliation -> behavior.toolResultReconciliation
  if (states.has('tool-result-reconciliation')) {
    handle('tool-result-reconciliation');
    write('behavior.toolResultReconciliation', on('tool-result-reconciliation') ? 'reconcile' : 'warn-only');
  }
  // hitl-ux-modes: only an explicit OFF maps (mode off); ON keeps the configured mode.
  if (states.has('hitl-ux-modes')) {
    handle('hitl-ux-modes');
    if (off('hitl-ux-modes')) write('behavior.hitlMode', 'off');
  }
  // Compaction pair -> behavior.compactionStrategy.
  if (states.has('session-compaction') || states.has('compaction-distiller-strategy')) {
    handle('session-compaction');
    handle('compaction-distiller-strategy');
    if (off('session-compaction')) {
      write('behavior.compactionStrategy', 'off');
    } else if (on('compaction-distiller-strategy')) {
      write('behavior.compactionStrategy', 'distiller');
    } else if (off('compaction-distiller-strategy') && readDot(parsed, 'behavior.compactionStrategy') === 'distiller') {
      // Legacy resolved a distiller selection back to structured while the
      // distiller toggle was off — preserve that resolution explicitly.
      write('behavior.compactionStrategy', 'structured');
    }
  }
  // fetch-sanitization: only an explicit OFF maps (content sanitization off).
  if (states.has('fetch-sanitization')) {
    handle('fetch-sanitization');
    if (off('fetch-sanitization')) write('fetch.sanitizeMode', 'none');
  }
  // overflow-spill-backends: OFF meant the configured backend was not honored.
  if (states.has('overflow-spill-backends')) {
    handle('overflow-spill-backends');
    const configured = readDot(parsed, 'tools.overflowSpillBackend');
    if (off('overflow-spill-backends') && typeof configured === 'string' && configured !== 'file') {
      write('tools.overflowSpillBackend', 'file');
    }
  }
  // provider-optimizer -> provider.optimizerMode gains 'off'.
  if (states.has('provider-optimizer')) {
    handle('provider-optimizer');
    if (off('provider-optimizer')) {
      write('provider.optimizerMode', 'off');
    } else if (readDot(parsed, 'provider.optimizerMode') === undefined) {
      write('provider.optimizerMode', 'manual');
    }
  }
  // OTel pair -> telemetry.otelMode.
  if (states.has('otel-foundation') || states.has('otel-remote-export')) {
    handle('otel-foundation');
    handle('otel-remote-export');
    const foundationOn = on('otel-foundation');
    write('telemetry.otelMode', foundationOn ? (on('otel-remote-export') ? 'remote-export' : 'in-process') : 'off');
  }
  // sandbox-model-judgment + sandbox.judgmentAutoApprove -> sandbox.judgment.
  {
    const flagState = states.get('sandbox-model-judgment');
    if (flagState !== undefined) handle('sandbox-model-judgment');
    const legacyAuto = hasLegacyJudgment ? sandboxSection['judgmentAutoApprove'] === true : false;
    if (hasLegacyJudgment) {
      const sandboxCopy = cloneShallowPath(config, ['sandbox']);
      delete sandboxCopy['judgmentAutoApprove'];
      if (!changedKeys.includes('sandbox.judgment')) changedKeys.push('sandbox.judgmentAutoApprove');
    }
    if (flagState === 'disabled' || flagState === 'killed') {
      write('sandbox.judgment', 'off');
    } else if (legacyAuto) {
      write('sandbox.judgment', 'auto-approve');
    } else if (flagState === 'enabled') {
      write('sandbox.judgment', 'annotate');
    }
  }

  for (const id of states.keys()) {
    if (!handled.has(id)) unknownIds.push(id);
  }

  return { migrated: true, config, changedKeys, unknownIds };
}

/** Outcome of the fleet.maxSize rename migration (orchestration.maxActiveAgents -> fleet.maxSize). */
export interface FleetMaxSizeMigrationResult {
  readonly config: Record<string, unknown>;
  /** True when a legacy value was actually moved (the receipt fires only then). */
  readonly migrated: boolean;
  readonly movedValue?: number | undefined;
}

/**
 * Invisible key migration for the owner-named cap ("Maximum fleet size"):
 * an explicit legacy `orchestration.maxActiveAgents` moves onto
 * `fleet.maxSize` (which wins if BOTH are present — the new key is the one
 * the user can see) and the legacy key is removed. Idempotent; a file with
 * no legacy key is returned untouched.
 */
export function migrateFleetMaxSizeRename(parsed: Record<string, unknown>): FleetMaxSizeMigrationResult {
  const orchestration = parsed.orchestration;
  if (orchestration === null || typeof orchestration !== 'object' || Array.isArray(orchestration)) {
    return { config: parsed, migrated: false };
  }
  const legacy = (orchestration as Record<string, unknown>).maxActiveAgents;
  if (typeof legacy !== 'number') return { config: parsed, migrated: false };
  const config = structuredClone(parsed);
  const orch = config.orchestration as Record<string, unknown>;
  delete orch.maxActiveAgents;
  if (Object.keys(orch).length === 0) delete config.orchestration;
  const fleet = (config.fleet !== null && typeof config.fleet === 'object' && !Array.isArray(config.fleet))
    ? config.fleet as Record<string, unknown>
    : {};
  if (fleet.maxSize === undefined) fleet.maxSize = legacy;
  config.fleet = fleet;
  return { config, migrated: true, movedValue: legacy };
}
