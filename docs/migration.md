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

---

## ProviderRegistry canonical accessors (0.18.45) {#providerregistry-canonical-accessors-01845}

### Why this changed

`get()` was the only accessor on `ProviderRegistry`, but its throwing behavior was implicit. Callers that wanted to check existence first had to catch or do a separate lookup. Three explicit accessors make intent unambiguous at every call site.

### Before

```ts
// Existence check — awkward, forces try/catch
let provider: Provider | undefined;
try {
  provider = registry.get('my-provider');
} catch {
  provider = undefined;
}

// Guaranteed access — same as above
const provider = registry.get('my-provider'); // throws ProviderNotFoundError if absent
```

### After

```ts
// Existence check
if (registry.has('my-provider')) {
  // ...
}

// Guaranteed access (throwing)
const provider = registry.require('my-provider'); // throws ProviderNotFoundError if absent

// Safe nullable access
const provider = registry.tryGet('my-provider'); // returns Provider | undefined

// get() still works but is @deprecated — migrate to require() at your own pace
const provider = registry.get('my-provider'); // @deprecated
```

### Automated migration

No automated migration. Callers of `get()` continue to compile — the method is deprecated, not removed. Migrate to `require()` (identical throwing semantics) or `tryGet()` (nullable) when you touch those call sites.

---

## RuntimeEventRecord discriminated union (0.18.45 / 0.18.46) {#runtimeeventrecord-discriminated-union-01845--01846}

### Why this changed

Previously `RuntimeEventRecord` was a wide structural type and consumers narrowed `event.payload` with casts (`event.payload as AgentCompletedPayload`). The cast was necessary because the type system had no way to connect `event.type` to the payload shape. The discriminated union eliminates the cast: after a `switch (event.type)`, TypeScript knows the exact payload type.

### Before

```ts
bus.subscribe((event: RuntimeEventRecord) => {
  if (event.type === 'agent.completed') {
    const payload = event.payload as AgentCompletedPayload; // cast required
    handleCompletion(payload.agentId, payload.exitCode);
  }
});
```

### After

```ts
bus.subscribe((event: RuntimeEventRecord) => {
  switch (event.type) {
    case 'agent.completed':
      // event.payload is AgentCompletedPayload — no cast needed
      handleCompletion(event.payload.agentId, event.payload.exitCode);
      break;
    case 'session.closed':
      // event.payload is SessionClosedPayload — no cast needed
      handleClose(event.payload.sessionId, event.payload.reason);
      break;
  }
});
```

`RuntimeEventRecord` now aliases `AnyRuntimeEvent`. Code that references `RuntimeEventRecord` as a type annotation continues to compile. The 0.18.46 patch fixed a CI-only variance issue in the union definition under `--strict --exactOptionalPropertyTypes`; no further consumer changes needed.

### Automated migration

No automated migration. Existing `event.payload as X` casts remain valid TypeScript — they produce no error. Removing them after adding a `switch` on `event.type` is a quality-of-life improvement, not a requirement.

---

## `ChatResponse.stopReason` canonical vocab (0.18.47) {#chatresponsestopreason-canonical-vocab-01847}

### Why this changed

Each provider leaked its own stop-reason strings into `ChatResponse.stopReason` (`'end_turn'` from Anthropic, `'stop'` from OpenAI, `'STOP'` from Gemini, etc.). Consumer `switch` statements had to enumerate provider-specific strings and broke silently when a new provider was added. The canonical vocab lets consumers branch once and cover all providers correctly.

### Before

```ts
// Had to enumerate every provider's strings
switch (response.stopReason) {
  case 'end_turn':      // Anthropic
  case 'stop':          // OpenAI
  case 'STOP':          // Gemini
  case 'endoftext':     // some open-weight models
    handleNormalEnd();
    break;
  case 'max_tokens':
  case 'length':        // OpenAI alternative
    handleTruncated();
    break;
  // easy to miss new providers
}
```

### After

```ts
// Single canonical switch covers all providers
switch (response.stopReason) {
  case 'completed':
    handleNormalEnd();
    break;
  case 'max_tokens':
    handleTruncated();
    break;
  case 'tool_call':
    handleToolCall();
    break;
  case 'stop_sequence':
    handleStopSequence();
    break;
  case 'content_filter':
    handleFiltered();
    break;
  case 'error':
  case 'unknown':
    handleUnexpected();
    break;
}

// Raw provider value still available if needed
console.log(response.providerStopReason); // e.g. 'end_turn', 'stop', 'STOP'
```

### Automated migration

No automated migration. TypeScript will surface a type error on any `case` branch that uses a value not present in `ChatStopReason` — those errors are the migration checklist. Replace each with the corresponding canonical value from the table below:

| Provider string | Canonical value |
| --- | --- |
| `end_turn`, `stop`, `STOP`, `endoftext` | `completed` |
| `max_tokens`, `length`, `MAX_TOKENS` | `max_tokens` |
| `tool_use`, `tool_calls`, `TOOL` | `tool_call` |
| `stop_sequence` | `stop_sequence` |
| `content_filter`, `SAFETY` | `content_filter` |

---

## authToken normalization (0.18.47) {#authtoken-normalization-01847}

### Why this changed

Consumers that accept auth tokens from multiple sources (env var string, config object, async factory function) were each writing their own resolution logic. The helper centralizes that pattern so the behavior is consistent and tested in one place.

### Before

```ts
// Ad hoc resolution — repeated across multiple surfaces
async function resolveToken(
  token: string | (() => string | Promise<string>) | { token: string } | undefined
): Promise<string | undefined> {
  if (!token) return undefined;
  if (typeof token === 'string') return token;
  if (typeof token === 'function') return token();
  return token.token;
}
```

### After

```ts
import { normalizeAuthToken } from '@pellux/goodvibes-sdk/transport-http';

// normalizeAuthToken returns an AuthTokenResolver — it normalizes the input,
// it does not resolve the token itself. Invoke the resolver to get the value.
const resolver = normalizeAuthToken(token); // returns AuthTokenResolver
const resolved = await resolver();          // resolves string | null | undefined
```

The full signature:

```ts
export type AuthTokenResolver = () => MaybePromise<string | null | undefined>;
export type AuthTokenInput =
  | string
  | { readonly token: string }
  | AuthTokenResolver
  | (() => string | null | undefined | Promise<string | null | undefined>)
  | undefined;

export function normalizeAuthToken(input: AuthTokenInput): AuthTokenResolver;
```

Consumers that already pass the right shape to their provider do not need to adopt the helper. It is opt-in for those who want the canonical resolver. No breaking change — this is a new export only.

### Automated migration

None required. Existing token-resolution code continues to work. Adopting `normalizeAuthToken()` is a voluntary refactor.

---

## Orchestrator options-object constructor (0.18.50) {#orchestrator-options-object-constructor-01850}

### Why this changed

`Orchestrator` previously took 11 positional arguments. Adding a twelfth required a positional-breaking change; all callsites had to be updated in lockstep; and optional arguments could not be given sensible defaults without the caller omitting trailing undefineds. An options object solves all three problems: new optional fields are zero-migration, defaults live in one place, and named fields make each argument self-documenting.

### Before

```ts
new Orchestrator(
  conversation,
  getViewportHeight,
  scrollToEnd,
  toolRegistry,
  permissionManager,
  getSystemPrompt,
  hookDispatcher,
  flagManager,
  requestRender,
  runtimeBus,
  services
);
```

### After

```ts
new Orchestrator({
  // Required
  conversation,
  getViewportHeight,
  scrollToEnd,
  toolRegistry,
  permissionManager,
  services,
  // Optional — sensible defaults apply if omitted
  getSystemPrompt,
  hookDispatcher,
  flagManager,
  requestRender,
  runtimeBus,
});
```

### Automated migration

No automated migration. TypeScript will produce a compile error at every `new Orchestrator(arg1, arg2, ...)` call site because the signature changed. Work through each call site and convert to the options-object form. The field names are identical to the old positional names — the transformation is mechanical.

---

## SDKErrorKind tagged union (0.18.50) {#sdkerrorkind-tagged-union-01850}

### Why this changed

Previous error handling required catching and `instanceof`-checking concrete subclasses (`HttpStatusError`, `ConfigurationError`, `ContractError`). This pattern requires importing the subclass type and breaks down for errors thrown by new code paths that callers have not anticipated. A `kind` discriminant on the base class lets callers branch by category without knowing the concrete subclass.

### Before

```ts
try {
  await client.getSession(id);
} catch (err) {
  if (err instanceof HttpStatusError && err.statusCode === 404) {
    // handle not-found
  } else if (err instanceof HttpStatusError && err.statusCode >= 500) {
    // handle server error
  }
}
```

### After

```ts
try {
  await client.getSession(id);
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'not-found':  handleNotFound();  break;
      case 'server':     handleServer();    break;
      case 'network':    handleNetwork();   break;
      case 'auth':       handleAuth();      break;
      case 'rate-limit': handleRateLimit(); break;
    }
  }
}
```

`SDKErrorKind` values: `auth | config | contract | network | not-found | rate-limit | server | validation | unknown`.

Existing `instanceof HttpStatusError` / `instanceof ConfigurationError` / `instanceof ContractError` checks remain valid — those subclasses are preserved as deprecated aliases.

### Automated migration

No automated migration. Existing `instanceof` chains continue to work. The `kind` discriminant is an additive improvement; adopt it where it simplifies error-handling code.

---

## Auth client split (0.18.50) {#auth-client-split-01850}

### Why this changed

`GoodVibesAuthClient` had grown to own token persistence, session lifecycle, PKCE OAuth flows, and permission checks — four unrelated responsibilities in one class. Splitting into focused classes makes each testable in isolation and makes the dependency surface of each consumer explicit.

### Split classes

| Class | Responsibility | Import path |
|---|---|---|
| `TokenStore` | Token persistence (`hasToken`, `getToken`, `setToken`, `clearToken`) | `platform/auth/token-store` |
| `SessionManager` | Login lifecycle, persist-on-login semantics | `platform/auth/session-manager` |
| `OAuthClient` | PKCE flow, code exchange, token refresh, JWT decode | `platform/auth/oauth-client` |
| `PermissionResolver` | Role and scope checks over `ControlPlaneAuthSnapshot` | `platform/auth/permission-resolver` |

### Before

```ts
import { GoodVibesAuthClient } from '@pellux/goodvibes-sdk/platform/auth';

// Monolithic client
const auth = new GoodVibesAuthClient(config);
const token = await auth.getToken();
await auth.login(credentials);
const hasScope = auth.hasScope('admin');
```

### After

```ts
import { GoodVibesAuthClient } from '@pellux/goodvibes-sdk/platform/auth'; // facade still works

// Or use focused classes directly:
import { TokenStore } from '@pellux/goodvibes-sdk/platform/auth/token-store';
import { PermissionResolver } from '@pellux/goodvibes-sdk/platform/auth/permission-resolver';

const store = new TokenStore(config);
const resolver = new PermissionResolver(snapshot);
```

### Automated migration

None required. `GoodVibesAuthClient` remains the thin facade over the split classes. The aggregated token methods (`getToken`/`setToken`/`clearToken`) on the facade are now `@deprecated` but functional. Prefer the focused classes for new code.

---

## Async cascade: beginAuthorization, beginOpenAICodexLogin, beginOAuthLogin (0.18.51) {#async-cascade-01851}

### Why this changed

These three functions previously generated a PKCE code verifier using `Math.random()`, which is not cryptographically secure. The 0.18.51 Web Crypto migration switches to `globalThis.crypto.getRandomValues()`, which is `async` in some environments (notably React Native Hermes). All three functions therefore became `async` to accommodate the async crypto call.

### Functions affected

| Function | Owner |
|---|---|
| `OAuthClient.beginAuthorization(params)` | `platform/auth/oauth-client` |
| `beginOpenAICodexLogin(...)` | `platform/config/openai-codex-auth` |
| `SubscriptionManager.beginOAuthLogin(...)` | `platform/config/subscriptions` |

### Before

```ts
// All three were synchronous
const { authorizationUrl } = client.beginAuthorization(params);
const { url, state } = beginOpenAICodexLogin(config);
const loginUrl = manager.beginOAuthLogin();
```

### After

```ts
// All three are now async — must be awaited
const { authorizationUrl } = await client.beginAuthorization(params);
const { url, state } = await beginOpenAICodexLogin(config);
const loginUrl = await manager.beginOAuthLogin();
```

### Impact

Callers that do not `await` receive a `Promise<OAuthStartState>` instead of an `OAuthStartState`. TypeScript surfaces this as a type error when the return value is used. Non-awaited call sites that discard the return value will compile silently but will not open the authorization URL at runtime — a silent no-op.

### Automated migration

No automated migration. TypeScript will surface type errors at any call site that uses the return value without `await`. Scan for `beginAuthorization`, `beginOpenAICodexLogin`, and `beginOAuthLogin` and add `await`. Each caller must be in an `async` function (or top-level `await` context) — propagate `async` up the call stack as needed.

---

## OAuthClient moved to /oauth subpath (0.18.51) {#oauthclient-subpath-01851}

### Why this changed

The 0.18.50 auth barrel split placed `OAuthClient` in the main `platform/auth` barrel. The 0.18.51 RN bundling fix determined that this caused React Native bundlers to pull in Node-only crypto code through the barrel. Moving `OAuthClient` to its own `/oauth` subpath lets RN bundlers tree-shake the auth barrel without encountering the PKCE crypto path.

### Before

```ts
import { OAuthClient } from '@pellux/goodvibes-sdk/auth';
```

### After

```ts
import { OAuthClient } from '@pellux/goodvibes-sdk/oauth';
```

### Automated migration

No automated migration. Update all import sites that reference `OAuthClient` from the `/auth` subpath to use `/oauth` instead. The main `/auth` barrel no longer re-exports `OAuthClient`.

---

## Node.js minimum version raised to 19 (0.18.51) {#node-minimum-version-01851}

### Why this changed

Node 18 reached EOL in April 2025. The Web Crypto migration in 0.18.51 relies on `globalThis.crypto` being available natively, which requires Node 19+. The `engines` field in `packages/sdk/package.json` now declares `"node": ">=19"`.

### Action required

Update your CI and production environments to Node 20 LTS or 22 LTS if you are currently running Node 18. No code changes are needed — this is an environment-level requirement.

### Automated migration

None. Update your `.nvmrc`, `.node-version`, CI job images, and container base images as appropriate.
