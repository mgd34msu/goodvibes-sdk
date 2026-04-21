# Migration Registry

This directory contains the schema migration infrastructure for all domain contracts.

## Structure

| File | Purpose |
|------|---------|
| `index.ts` | `MigrationRegistry` class — step storage, path resolution, ordered execution |
| `schemas.ts` | All 5 domain migration step arrays + version re-exports + getter functions |

## Pattern

Each domain contract has three exports in `schemas.ts`:

```ts
// 1. Private steps array (empty at initial v1.0.0)
const MY_DOMAIN_STEPS: MigrationStep[] = [];

// 2. Version constant re-exported for convenience
export const MY_DOMAIN_VERSION = SCHEMA_VERSIONS.myDomain;

// 3. Getter function consumed by the contract registry
export function getMyDomainMigrationSteps(): MigrationStep[] {
  return MY_DOMAIN_STEPS;
}
```

The getters are called in `contracts/index.ts` → `createContractRegistry()`, which
registers each step with the `MigrationRegistry` keyed to its contract name.

## How to Add a Migration Step

When a schema version bumps (e.g. `runtimeState` from `1.0.0` → `1.1.0`):

1. Update `SCHEMA_VERSIONS.runtimeState` in `contracts/version.ts`.
2. Append a `MigrationStep` object to `RUNTIME_STATE_STEPS` in `schemas.ts`:

```ts
{
  from: { major: 1, minor: 0, patch: 0 },
  to:   { major: 1, minor: 1, patch: 0 },
  description: 'Add optional uiSettings field with defaults',
  migrate: (data: unknown): unknown => {
    const d = data as Record<string, unknown>;
    return { ...d, uiSettings: d['uiSettings'] ?? { theme: 'dark' } };
  },
}
```

3. The `MigrationRegistry` will automatically resolve the chain from any stored
   version to the current one via `getMigrationPath()`.

## When to Split Back Out

`schemas.ts` was consolidated from 5 individual stub files for DRY. If any single
domain contract accumulates **more than 10 migration steps**, extract it into its
own file (e.g. `runtime-state.ts`) and update the import in `contracts/index.ts`.

## Types

- `MigrationStep` — `{ from, to, description, migrate }` — defined in `../types.ts`
- `MigrationResult` — `{ data, version }` — returned by `registry.migrate()`
- `SchemaVersion` — `{ major, minor, patch }` — defined in `../types.ts`
