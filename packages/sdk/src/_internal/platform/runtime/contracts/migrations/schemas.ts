/**
 * Compatibility Contracts — Consolidated Migration Schemas
 *
 * All domain migration steps in one place. Each schema section:
 *   - Declares a private `_STEPS` array (MigrationStep[])
 *   - Exports a `_VERSION` constant (re-exported from SCHEMA_VERSIONS)
 *   - Exports a `get…MigrationSteps()` function for the contract registry
 *
 * Previously split across 5 stub files; consolidated here for DRY.
 * Split back out if any individual contract accumulates > 10 migration steps.
 *
 * All migration functions must be pure — no mutations, no side effects.
 *
 * @module contracts/migrations/schemas
 */

import type { MigrationStep } from '../types.js';
import { SCHEMA_VERSIONS } from '../version.js';

// ─── EventEnvelope ────────────────────────────────────────────────────────────

/**
 * All registered EventEnvelope migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `agentId` becomes required in v1.1.0, a migration step would
 * backfill it with a sentinel value for older persisted envelopes.
 */
const EVENT_ENVELOPE_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Backfill missing agentId with null sentinel',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, agentId: d['agentId'] ?? null };
  //   },
  // },
];

/** The current EventEnvelope schema version (re-exported for convenience). */
export const EVENT_ENVELOPE_VERSION = SCHEMA_VERSIONS.eventEnvelope;

/** Returns all EventEnvelope migration steps. Used by the contract registry. */
export function getEventEnvelopeMigrationSteps(): MigrationStep[] {
  return EVENT_ENVELOPE_STEPS;
}

// ─── PluginManifest ───────────────────────────────────────────────────────────

/**
 * All registered PluginManifest migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `capabilities` becomes an explicit array in v1.1.0, a migration
 * step would synthesize it from `registerCommand`/`registerTool` declarations.
 */
const PLUGIN_MANIFEST_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add capabilities array to plugin manifest',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, capabilities: d['capabilities'] ?? [] };
  //   },
  // },
];

/** The current PluginManifest schema version (re-exported for convenience). */
export const PLUGIN_MANIFEST_VERSION = SCHEMA_VERSIONS.pluginManifest;

/** Returns all PluginManifest migration steps. Used by the contract registry. */
export function getPluginManifestMigrationSteps(): MigrationStep[] {
  return PLUGIN_MANIFEST_STEPS;
}

// ─── RuntimeState ─────────────────────────────────────────────────────────────

/**
 * All registered RuntimeState migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `uiSettings` is added in v1.1.0, a step would backfill it with
 * default values for existing persisted snapshots.
 */
const RUNTIME_STATE_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add optional uiSettings field with defaults',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, uiSettings: d['uiSettings'] ?? { theme: 'dark' } };
  //   },
  // },
];

/** The current RuntimeState schema version (re-exported for convenience). */
export const RUNTIME_STATE_VERSION = SCHEMA_VERSIONS.runtimeState;

/** Returns all RuntimeState migration steps. Used by the contract registry. */
export function getRuntimeStateMigrationSteps(): MigrationStep[] {
  return RUNTIME_STATE_STEPS;
}

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * All registered Session migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if session files gain a `tags` array in v1.1.0, a migration step
 * would backfill it as an empty array for existing sessions.
 */
const SESSION_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add empty tags array to session meta',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     const meta = d['meta'] as Record<string, unknown>;
  //     return { ...d, meta: { ...meta, tags: meta['tags'] ?? [] } };
  //   },
  // },
];

/** The current Session schema version (re-exported for convenience). */
export const SESSION_VERSION = SCHEMA_VERSIONS.session;

/** Returns all Session migration steps. Used by the contract registry. */
export function getSessionMigrationSteps(): MigrationStep[] {
  return SESSION_STEPS;
}

// ─── TaskRecord ───────────────────────────────────────────────────────────────

/**
 * All registered TaskRecord migration steps.
 *
 * Currently empty — the schema is at its initial version (1.0.0).
 * Future steps must be appended here and registered via the contract registry.
 *
 * Example: if `metadata` map is added to RuntimeTask in v1.1.0, a migration
 * step would backfill it as an empty object for existing persisted records.
 */
const TASK_RECORD_STEPS: MigrationStep[] = [
  // Example structure for future use:
  // {
  //   from: { major: 1, minor: 0, patch: 0 },
  //   to: { major: 1, minor: 1, patch: 0 },
  //   description: 'Add metadata object to task records',
  //   migrate: (data: unknown): unknown => {
  //     const d = data as Record<string, unknown>;
  //     return { ...d, metadata: d['metadata'] ?? {} };
  //   },
  // },
];

/** The current TaskRecord schema version (re-exported for convenience). */
export const TASK_RECORD_VERSION = SCHEMA_VERSIONS.taskRecord;

/** Returns all TaskRecord migration steps. Used by the contract registry. */
export function getTaskRecordMigrationSteps(): MigrationStep[] {
  return TASK_RECORD_STEPS;
}
