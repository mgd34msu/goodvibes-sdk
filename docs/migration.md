# Migration and Upgrade Guide

## Version Compatibility

### SDK versioning

The SDK uses a single npm package (`@pellux/goodvibes-sdk`) with a monotonic release line. SDK version numbers are directly meaningful to surfaces: a surface must declare a specific SDK version range in `package.json`, and breaking changes are always gated on a minor version bump.

The version line currently tracks `0.18.x`. Breaking changes between patches are not made — if you see a type error after a patch upgrade, that is a bug. Breaking changes happen on minor bumps only, and are listed in the relevant release notes under `docs/releases/`.

### What `surfaceRoot` means

`surfaceRoot` is a single path segment (no slashes, no dots) that a surface host passes to the SDK to scope all on-disk storage under a host-owned subtree.

When you pass `surfaceRoot: 'tui'`, the SDK resolves storage paths like:

```
~/.goodvibes/tui/sessions/
~/.goodvibes/tui/last-session
~/.goodvibes/tui/recovery/
```

Without a `surfaceRoot`, the SDK uses the shared `.goodvibes/` root directly. Hosts that embed the SDK as a named surface should always set `surfaceRoot` to avoid cross-contaminating session, pointer, and recovery files with other surfaces.

The constraint is enforced at runtime: `surfaceRoot` must be a non-empty single path segment. Passing `'tui/sub'` or `'.'` will throw.

```ts
import { resolveSurfaceDirectory } from '@pellux/goodvibes-sdk/platform/runtime/surface-root';

// Resolves to: /home/user/.goodvibes/tui/sessions
const dir = resolveSurfaceDirectory(homeDir, 'tui', 'sessions');
```

---

## Breaking Changes in 0.18.29

### BlockMeta field removal

`BlockMeta` previously included surface-rendering fields that were only meaningful to specific host UIs. These have been removed from the SDK-owned interface to keep the core type minimal.

**Before (0.18.28 and earlier):**

```ts
export interface BlockMeta {
  type: 'tool' | 'code' | 'diff' | 'thinking';
  rawContent: string;
  filePath?: string;
  diffOriginal?: string;
  diffUpdated?: string;
  // surface-specific fields were also on this type
}
```

**After (0.18.29):**

`BlockMeta` retains only the fields listed above (`type`, `rawContent`, `filePath`, `diffOriginal`, `diffUpdated`). Any surface-specific fields that your host previously relied on from `BlockMeta` must now live in a surface-owned extension type:

```ts
import type { BlockMeta } from '@pellux/goodvibes-sdk/platform/core/conversation';

// Define your own extension — do not modify BlockMeta itself
export interface TuiBlockMeta extends BlockMeta {
  renderedHeight?: number;
  syntaxLanguage?: string;
}
```

Typecheck errors on `BlockMeta` after upgrading indicate your surface was relying on removed fields. Move those fields to a surface-local type.

### ConversationManager constructor change

`ConversationManager` now takes no constructor arguments. Any previous positional arguments must be supplied via the new setter methods after construction.

**Before:**

```ts
// No-arg constructor was always the case — if you passed args, those overloads are removed
const manager = new ConversationManager();
```

**After:**

```ts
const manager = new ConversationManager();
// Wire up dependencies via setters:
manager.setSessionMemoryStore(myStore);
manager.setSessionLineageTracker(myTracker);
```

If your surface constructed `ConversationManager` with arguments, remove them. The constructor is now unconditionally no-arg.

### RuntimeState shape changes

Two fields in `RuntimeState` changed in 0.18.29:

**`uiPerf` renamed to `surfacePerf`**

The performance domain was renamed from `uiPerf` to `surfacePerf` to better reflect that it belongs to the surface host, not the core UI layer. This is a breaking rename: any code that reads `state.uiPerf` must be updated to `state.surfacePerf`.

```ts
// Before
const perfState = state.uiPerf;

// After
const perfState = state.surfacePerf;
```

The `SurfacePerfDomainState` type import path is:

```ts
import type { SurfacePerfDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surface-perf';
```

**`panels` is now `Record<string, unknown>`**

Previously `panels` held a typed shape maintained by the SDK. It is now `Record<string, unknown>` — the SDK no longer owns the panel state structure. Each surface is responsible for casting or narrowing panel state as needed.

```ts
// Before — SDK-typed panel state
const panels = state.panels; // typed shape

// After — opaque record, surface owns the shape
const panels = state.panels as Record<string, MyPanelState>;
```

This removes a category of type errors when surfaces add panel state that differed from the SDK's expected shape.

### Health monitoring: panelHealthMonitor → componentHealthMonitor

The health monitoring types and class were renamed from `Panel*` to `Component*` to reflect that the health system is not specific to panel-based UIs.

**Type renames:**

| 0.18.28 (deprecated) | 0.18.29 (canonical) |
| --- | --- |
| `PanelResourceContract` | `ComponentResourceContract` |
| `PanelHealthState` | `ComponentHealthState` |
| `PanelThrottleStatus` | `ComponentThrottleStatus` |
| `PanelHealthStatus` | `ComponentHealthStatus` |
| `createInitialPanelHealthState` | `createInitialComponentHealthState` |
| `PanelHealthMonitor` | `ComponentHealthMonitor` |

The `Panel*` names are still exported as deprecated aliases and will compile without error today. They will be removed in a future release. Update usages to the `Component*` names.

```ts
// Before
import { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf';

// After
import { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf';
```

### Tool LLM config: add `tools.llmEnabled`

The tool-internal LLM feature is now gated by `tools.llmEnabled` in the runtime config. If you previously relied on tool-internal LLM features being always-on (semantic diff, auto-heal, commit message generation), you must ensure this config key is set to `true` in your surface's config defaults:

```ts
// In your surface config defaults:
const config = {
  tools: {
    llmEnabled: true,
    llmProvider: 'anthropic',   // optional: override provider
    llmModel: 'claude-sonnet-4', // optional: override model
  },
};
```

If `tools.llmEnabled` is absent or `false`, `resolveToolLLM()` returns `null` and all tool-internal LLM calls silently return empty strings.

---

## How to Upgrade

Follow these steps when upgrading a surface from an earlier SDK release to 0.18.29.

### 1. Update package.json

```bash
npm install @pellux/goodvibes-sdk@0.18.29
```

Or with Bun:

```bash
bun add @pellux/goodvibes-sdk@0.18.29
```

### 2. Run typecheck to find breaks

Run your surface's typecheck command immediately after updating. Compile errors, not test failures, are the primary signal for breaking changes:

```bash
npm run typecheck
# or
bun run typecheck
```

Most 0.18.29 breaks produce clear type errors. Work through them category by category using the sections below.

### 3. Update BlockMeta usage

If you see type errors on `BlockMeta`, locate every place your surface reads or writes fields on `BlockMeta`. Fields that no longer exist on the SDK type must move to a surface-local extension:

```ts
import type { BlockMeta } from '@pellux/goodvibes-sdk/platform/core/conversation';

export interface SurfaceBlockMeta extends BlockMeta {
  // Your surface-owned fields here
}
```

Replace all uses of the old `BlockMeta` fields with your new extension type.

### 4. Update RuntimeState consumers

Search your surface for `state.uiPerf` and replace with `state.surfacePerf`. If you imported `UiPerfDomainState`, update the import:

```ts
// Before
import type { UiPerfDomainState } from '...';

// After
import type { SurfacePerfDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/surface-perf';
```

Search for `state.panels` accesses that relied on a specific shape. Cast to your surface-owned type:

```ts
const panels = store.getState().panels as Record<string, YourPanelState>;
```

### 5. Update health monitoring imports

Search for `PanelHealthMonitor` and replace with `ComponentHealthMonitor`. Do the same for all `Panel*` type names:

```bash
# Quick find
grep -r 'PanelHealthMonitor\|PanelResourceContract\|PanelHealthState\|PanelThrottleStatus\|PanelHealthStatus\|createInitialPanelHealthState' src/
```

Update each to the corresponding `Component*` name. The deprecated aliases will continue to compile, but IDE warnings and eventual removal make updating now worthwhile.

### 6. Update tool LLM config

If your surface uses tool-internal LLM features, add `tools.llmEnabled: true` to your config initialization. If you do not use tool LLM features, no action is needed — the default-off behavior is correct.

---

## Deprecation Timeline

### Panel* aliases

The following names were deprecated in 0.18.29 and replaced with `Component*` equivalents:

- `PanelResourceContract`
- `PanelHealthState`
- `PanelThrottleStatus`
- `PanelHealthStatus`
- `createInitialPanelHealthState`
- `PanelHealthMonitor`

They remain exported today for backward compatibility. **They will be removed in the next minor release that includes a breaking-change sweep.** No date is set, but the expectation is within the 0.19.x line.

To prepare:
- Replace `Panel*` imports with `Component*` imports today.
- If you have lint rules for deprecated identifiers, add the `Panel*` names to them.

### What will not be removed

The following are stable and will not change in 0.18.x:

- `RuntimeState` field names beyond what is documented above
- `ConversationManager` public method signatures
- SDK package entry points
- `surfaceRoot` semantics

---

## Testing After Upgrade

After completing the steps above, verify the following:

**Type safety**
- Typecheck passes with zero errors under the new SDK version.
- No remaining `Panel*` references (excluding intentional backward-compat tests).

**Runtime behavior**
- Sessions save and restore correctly under your `surfaceRoot`.
- The last-session pointer, session files, and recovery files all land under `.goodvibes/<surfaceRoot>/`.
- Panel state reads from `store.getState().panels` work correctly with your surface-owned cast.
- Health monitor subscribers receive `ComponentHealthState` updates as expected.

**Tool LLM (if used)**
- Tool-internal LLM operations (semantic diff, commit messages) work when `tools.llmEnabled: true` is set.
- They silently degrade (return empty string) when the config key is absent — verify no hard failures in that path.
