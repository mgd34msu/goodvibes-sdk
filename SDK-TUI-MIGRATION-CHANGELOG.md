# SDK/TUI Boundary Migration Changelog

All changes made during the SDK/TUI separation effort. Every change is tracked here for the final CHANGELOG update.

---

## Phase 1A — Remove TUI Leakage from SDK

### 1. Delete terminal rendering primitives
- **Deleted** `packages/sdk/src/_internal/platform/types/grid.ts`
  - Contained: `Cell` interface, `Line` type alias, `createEmptyCell()`, `createEmptyLine()`, `createStyledCell()`
  - Reason: Terminal grid primitives belong in the TUI, not the SDK
  - Impact: Zero — no SDK file imported this module (orphaned)
  - TUI already has its own copy at `src/types/grid.ts`

- **Deleted** `packages/sdk/src/_internal/platform/core/history.ts`
  - Contained: `InfiniteBuffer` class (manages `Line[]` scroll buffer)
  - Reason: Terminal scroll buffer belongs in the TUI
  - Impact: Zero — no SDK file imported this module (orphaned)
  - TUI already has its own copy at `src/core/history.ts`

### 2. Clean BlockMeta interface (conversation.ts)
- **Modified** `packages/sdk/src/_internal/platform/core/conversation.ts`
  - Removed rendering fields from `BlockMeta`: `blockIndex`, `startLine`, `lineCount`, `collapseKey`
  - Kept platform fields: `type`, `rawContent`, `filePath`, `diffOriginal`, `diffUpdated`
  - Removed unused constructor params: `_getWidth: () => number`, `_configManager?: unknown`
  - Reason: Rendering coordinates and collapse state are TUI concerns. The TUI extends `BlockMeta` with its own rendering fields.

### 3. Decouple conversation-diff.ts from BlockMeta
- **Modified** `packages/sdk/src/_internal/platform/core/conversation-diff.ts`
  - Created standalone `DiffParseResult` interface replacing `Pick<BlockMeta, ...>`
  - Removed import of `BlockMeta` from `conversation.ts`
  - Reason: `parseDiffForApply` only uses diff fields, shouldn't be coupled to the full `BlockMeta` type

### 4. Fix orchestrator-runner constructor call
- **Modified** `packages/sdk/src/_internal/platform/agents/orchestrator-runner.ts`
  - Changed `new ConversationManager(() => 80)` to `new ConversationManager()`
  - Reason: Constructor params were removed from ConversationManager in change #2

### 6. Fix TUI hardcoding in surface registry
- **Modified** `packages/sdk/src/_internal/platform/channels/surface-registry.ts`
  - Site A: Replaced `if (surface === 'tui') return true;` with config-driven check (defaults to enabled for backward compat)
  - Site B: Made fallback TUI entry in `syncConfiguredSurfaces()` config-driven instead of hardcoded `enabled: true`
  - Reason: TUI was the only surface unconditionally enabled regardless of config. Now treated like all other surfaces.

---

## Phase 1B — Add Missing Platform Code to SDK

### 1. API key resolution
- **Created** `packages/sdk/src/_internal/platform/config/api-keys.ts`
  - Contains `loadEnvApiKeys()` (private), `getConfiguredApiKeys()`, `resolveApiKeys()`
  - 30+ provider-to-env-var mapping (openai, anthropic, gemini, inceptionlabs, etc.)
  - Three-tier resolution: env vars → SecretsManager → skip
  - Imports `SecretsManager` from SDK's own `config/secrets.ts`
- **Modified** `packages/sdk/src/_internal/platform/config/index.ts`
  - Replaced inline implementations with re-exports from `api-keys.ts`
  - Removed unused `SecretsManager` import

### 2. ConversationManager undo/redo
- **Modified** `packages/sdk/src/_internal/platform/core/conversation.ts`
  - Added `undoStack` property (array of message turn snapshots)
  - Added `undo()` method — splices from last user message, pushes turn to stack
  - Added `redo()` method — pops stack, appends turn back
  - `addUserMessage()` clears undo stack (can't redo past new input)
  - `resetAll()` clears undo stack
  - Exact behavioral parity with TUI implementation, zero rendering dependencies

### 3. Plugin loader extensibility
- **Modified** `packages/sdk/src/_internal/platform/plugins/loader.ts`
  - Added `additionalDirectories?: readonly string[]` to `PluginPathOptions`
  - Added `entryDefault?: string` to `PluginPathOptions`
  - `getPluginDirectories()` appends additional directories after standard search paths
  - `loadPlugin()` accepts optional `entryDefault` param (default: `'index.js'`)
  - Fully backward-compatible — all existing call sites work unchanged
  - TUI can now pass `additionalDirectories: ['.goodvibes/tui/plugins']` and `entryDefault: 'index.ts'`

### 4. Platform selectors
- **Modified** `packages/sdk/src/_internal/platform/runtime/store/selectors/index.ts`
  - Added 8 missing platform domain selectors: `selectOrchestration`, `selectCommunication`, `selectAutomation`, `selectRoutes`, `selectControlPlane`, `selectDeliveries`, `selectWatchers`, `selectSurfaces`
  - SDK already had all other platform selectors matching TUI's file
  - Note: `selectPanels`/`selectUiPerf` remain in SDK — flagged for Phase 2 review (surface-layer concerns)

### 5. Service query interfaces
- **Created** `packages/sdk/src/_internal/platform/runtime/service-queries.ts`
  - Re-exports all 12 interfaces and 2 factory functions from existing `ui-service-queries.ts`
  - Provides platform-appropriate import path (no "ui" prefix)
  - SDK already had `ui-service-queries.ts` with all interfaces — this adds the canonical non-UI name

### 6. Generalize health monitoring infrastructure
- **Created** `packages/sdk/src/_internal/platform/runtime/perf/component-contracts.ts`
  - Generic types: `ComponentResourceContract`, `ComponentHealthState`, `ComponentThrottleStatus`, `ComponentHealthStatus`
  - `CATEGORY_CONTRACTS` keys are already generic (`development`, `agent`, `monitoring`, `session`, `ai`, `default`)
  - Deprecated `Panel*` type aliases for backward compat
- **Created** `packages/sdk/src/_internal/platform/runtime/perf/component-health-monitor.ts`
  - `ComponentHealthMonitor` class (renamed from `PanelHealthMonitor`)
  - Re-exports `PanelHealthMonitor` as deprecated alias
- **Modified** `packages/sdk/src/_internal/platform/runtime/perf/panel-contracts.ts` — shim re-exporting from `component-contracts.ts`
- **Modified** `packages/sdk/src/_internal/platform/runtime/perf/panel-health-monitor.ts` — shim re-exporting from `component-health-monitor.ts`
- **Modified** `packages/sdk/src/_internal/platform/runtime/perf/index.ts` — exports both `Component*` (canonical) and `Panel*` (deprecated)
- **Modified** `packages/sdk/src/_internal/platform/runtime/diagnostics/types.ts` — uses `ComponentThrottleStatus`/`ComponentHealthStatus`
- **Modified** `packages/sdk/src/_internal/platform/runtime/diagnostics/panels/panel-resources.ts` — uses `ComponentHealthMonitor`, maps `componentId` to `panelId` in view model
- **Modified** `packages/sdk/src/_internal/platform/runtime/shell-command-services.ts` — `componentHealthMonitor: ComponentHealthMonitor`
- **Modified** `packages/sdk/src/_internal/platform/runtime/shell-command-workspace.ts` — `componentHealthMonitor: ComponentHealthMonitor`

---

## Phase 1C — Verify and Release

*(Pending)*

---

## Phase 2 — TUI Changes (after SDK release)

*(Pending — will be tracked after Phase 1 completes)*

### Deletions (dead code / forks)
- `src/daemon/facade.ts` (639L) — dead, nothing imports it
- `src/daemon/facade-composition.ts` (399L) — dead
- `src/daemon/surface-policy.ts` (61L) — dead
- `src/daemon/types.ts` (192L) — dead
- `src/core/orchestrator.ts` (736L) — fork of SDK, replace with import
- `src/plugins/loader.ts` (305L) — fork of SDK, replace with import
- `src/tools/index.ts` (187L) — outdated fork, use SDK's registerAllTools
- `src/config/subscription-providers.ts` (128L) — near-exact copy of SDK
- `src/config/service-registry.ts` (2L) — pointless re-export
- `src/runtime/services.ts` (549L) — duplicate of SDK's createRuntimeServices
- `src/runtime/store/domains/conversation.ts` (182L) — duplicate
- `src/runtime/store/domains/permissions.ts` (144L) — duplicate
- `src/runtime/store/helpers/reducers/conversation.ts` (229L) — duplicate
- `src/runtime/store/helpers/reducers/lifecycle.ts` (441L) — duplicate
- `src/runtime/ui-read-model-helpers.ts` (33L) — duplicate / dead
- `src/runtime/ui-read-models-core.ts` (96L) — likely dead
- `src/runtime/ui-read-models-operations.ts` (204L) — likely dead

### Modifications (replace forks with SDK imports)
- `src/config/index.ts` — remove loadEnvApiKeys/resolveApiKeys after SDK has them
- `src/config/secrets.ts` — may simplify to direct SDK usage
- `src/permissions/prompt.ts` — import 4 type definitions from SDK instead of redefining
- `src/core/conversation.ts` — extend SDK's ConversationManager, define TUI BlockMeta extension
- `src/runtime/bootstrap-core.ts` — split: parameterize surface descriptor, extract Compositor/SelectionManager creation
- `src/runtime/bootstrap-command-parts.ts` — split: extract platform model switching from TUI logging
- `src/runtime/bootstrap-hook-bridge.ts` — split: extract session load/resume from panel restoration
- `src/runtime/store/selectors/index.ts` — import platform selectors from SDK, keep only TUI panel/perf selectors
