# Ninth Review: Public API Surface (WRFC:wrfc_9th_surface)

**Scope**: `packages/sdk/package.json` exports map, all workspace `package.json` exports, `etc/goodvibes-sdk.api.md`, `docs/public-surface.md`, `docs/semver-policy.md`, `docs/packages.md`, `test/sdk-runtime-boundaries.test.ts`, `packages/sdk/src/platform/node/capabilities.ts`, `api-extractor.json`, `bundle-budgets.json`, `test/types/typed-client-usage.ts`.

**Methodology**: Reality-checked file existence (every dist target referenced from an exports map), cross-walked capabilities.ts vs package.json exports, scanned dist `.d.ts` for `@internal` leaks on publicly-exported subpaths, audited semver-policy commitments against codebase reality, walked docs vs `platform/index.ts` and `platform/node/index.ts` namespace re-exports, and verified the Hermes/RN bundle test wiring.

Reality checks (5/5 captured):

| Check | Status | Notes |
|---|---|---|
| Files exist | PASS | Every `dist/...` target referenced from `packages/sdk/package.json` exists on disk; `dist/contracts/artifacts/{operator,peer}-contract.json` present. |
| Exports used | WARN | `packages/transport-direct/` workspace directory is referenced by docs but contains no source files (see CRIT-02). |
| Import chain valid | PASS | Root `packages/sdk/src/index.ts` re-exports every other root entry; companion entries (`browser`, `web`, `workers`, `react-native`, `expo`, `auth`) are wired. |
| No placeholders | PASS | No TODO/FIXME stubs in surface code. |
| Integration verified | WARN | `etc/goodvibes-sdk.api.md` only covers the root entry (api-extractor `mainEntryPointFilePath` = `dist/index.d.ts`); subpath surfaces (`./platform/...`, `./events/...`, `./platform/node`, etc.) are NOT enforced for drift. See MAJ-01. |

---

## CRITICAL

### CRIT-01: `./events/*` wildcard exports `domain-map` and `contracts` despite docs labeling them implementation details (release-breaking ambiguity)

- **Location**: `packages/sdk/package.json:63-66`, `docs/public-surface.md:116`
- **Severity**: CRITICAL (Security/Contract)

`packages/sdk/package.json:63-66` defines `"./events/*": { "types": "./dist/events/*.d.ts", "import": "./dist/events/*.js" }` — a wildcard exported subpath. `docs/public-surface.md:116` enumerates 27 supported domain ids and adds: "Internal modules (`domain-map`, `contracts`) are reachable via the wildcard but are considered implementation details; prefer the aggregate `./events` barrel."

This is a release-breaking contradiction:

1. `dist/events/domain-map.{d.ts,js}` and `dist/events/contracts.{d.ts,js}` are reachable via `import x from '@pellux/goodvibes-sdk/events/domain-map'` because the wildcard pattern resolves them.
2. Per `docs/semver-policy.md:13-19`, removing/renaming a public export — including "changing the resolution target of a subpath export in a way that breaks consumers" — is a major bump.
3. Saying "implementation detail" in prose without an enforcement boundary (export map exclusion or `dist/_internal/` location) means a downstream consumer who imports `@pellux/goodvibes-sdk/events/domain-map` is technically using a published path, and any change to its shape will break them on a `patch`/`minor` release.

The SDK is published to npm at `0.30.3`. This must be resolved before further releases — either:
- (a) Replace the wildcard with explicit per-domain entries (27 entries) so `domain-map`/`contracts` cease to be reachable; or
- (b) Update `docs/semver-policy.md` to declare `domain-map` and `contracts` exempt and accept the contractual asterisk; or
- (c) Move them under a sentinel name (e.g. `_domain-map`) and document the underscore prefix as the not-public marker.

Option (a) is the only one that matches the `Sealed paths` model documented at `docs/public-surface.md:228-235`.

### CRIT-02: `packages/transport-direct/` workspace directory has no files but is documented as a workspace package

- **Location**: `docs/transports.md:10`, project index `packages/transport-direct/src/`, root `package.json:28-30`
- **Severity**: CRITICAL (Reality drift)

`docs/transports.md:10` says: "`packages/transport-direct` workspace package." The project index lists `packages/transport-direct/` and `packages/transport-direct/src/` as directories, but `glob packages/transport-direct/**` returns 0 files. This means:

- There is no `packages/transport-direct/package.json` — it is NOT a workspace package, despite the doc.
- Root `package.json:28-30` declares `"workspaces": ["packages/*"]`. An empty `packages/transport-direct/` directory does not break Bun, but tools like `npm`/`yarn`/`pnpm` may emit warnings or fail-on-empty-package.json scans.
- `packages/sdk/src/transport-direct.ts` re-exports `DirectClientTransport`/`createDirectClientTransport` from `@pellux/goodvibes-transport-core` — the actual implementation lives in `packages/transport-core/src/direct.ts` (verified). So the SDK subpath itself is correctly wired; the doc lies.

Fix: either remove the empty directory (preferred — repo hygiene + correct workspace glob) and update `docs/transports.md:10` to say "facade backed by `packages/transport-core`", or stand up a real `packages/transport-direct/package.json` if the intent is a separately-published package.

### CRIT-03: `capabilities.ts` is missing `./transport-*` entrypoints — the runtime-boundary contract has a hole

- **Location**: `packages/sdk/src/platform/node/capabilities.ts:29-62`, `packages/sdk/package.json:179-194`
- **Severity**: CRITICAL (Contract)

`GOODVIBES_CLIENT_SAFE_ENTRYPOINTS` (capabilities.ts:29-36) lists 6 entries; `GOODVIBES_NODE_RUNTIME_ENTRYPOINTS` (capabilities.ts:38-62) lists 24 entries. Combined: 30. Public stable subpaths in `packages/sdk/package.json` (excluding `./events/*` wildcard, `./contracts/*.json`, `./package.json`): 43.

Missing from BOTH client-safe and node-runtime arrays:

- `./auth` (capabilities.ts assumes it's bundled into root, but it has its own subpath at package.json:29-32)
- `./client-auth` (package.json:37-40)
- `./contracts` (package.json:41-44)
- `./contracts/node` (package.json:45-48 — this one is companion-vs-node ambiguous)
- `./daemon` (package.json:51-54)
- `./errors` (package.json:55-58)
- `./events` (package.json:59-62)
- `./observer` (package.json:71-74)
- `./operator` (package.json:75-78)
- `./peer` (package.json:79-82)
- `./transport-core` (package.json:179-182)
- `./transport-direct` (package.json:183-186)
- `./transport-http` (package.json:187-190)
- `./transport-realtime` (package.json:191-194)

`test/sdk-runtime-boundaries.test.ts:42-47` enforces that every entry in `GOODVIBES_CLIENT_SAFE_ENTRYPOINTS` and `GOODVIBES_NODE_RUNTIME_ENTRYPOINTS` exists in the export map, but it does NOT enforce the reverse — that every export-map entry is classified as one of client-safe or node-runtime. So today's test passes while 13 published entry points have no runtime classification.

Consequence: a downstream consumer importing `@pellux/goodvibes-sdk/transport-http` from React Native cannot rely on `isClientSafeGoodVibesEntrypoint('@pellux/goodvibes-sdk/transport-http')` returning `true` — it returns `false`, and the developer must guess. Same for `./auth`, `./errors`, etc.

Fix: either (a) add the 13 missing entrypoints to the appropriate array in `capabilities.ts` (most belong in CLIENT_SAFE; `./contracts/node` and `./daemon` belong in NODE_RUNTIME), or (b) add a new array `GOODVIBES_NEUTRAL_ENTRYPOINTS` for runtime-agnostic libraries (`./contracts`, `./errors`, `./events`, `./observer`, `./operator`, `./peer`, `./transport-*`). Then extend `test/sdk-runtime-boundaries.test.ts` with a backward check that every export-map key is assigned to exactly one classification.

---

## MAJOR

### MAJ-01: `etc/goodvibes-sdk.api.md` only covers root entry — every `./platform/*` subpath is unenforced

- **Location**: `api-extractor.json:6`, `etc/goodvibes-sdk.api.md`, `docs/public-surface.md:175-225`
- **Severity**: MAJOR (API drift enforcement)

`api-extractor.json:6` configures `"mainEntryPointFilePath": "<projectFolder>/packages/sdk/dist/index.d.ts"`. api-extractor only walks symbols reachable from root. Verified by grep: `etc/goodvibes-sdk.api.md` contains zero matches for `GOODVIBES_RUNTIME_CAPABILITIES`, `GoodVibesRuntimeCapability`, `GoodVibesRuntimeSurface`, `platform/node`, or `KnowledgeExtension`. These are all exported through `./platform/node` and `./platform/knowledge/extensions` (real published subpaths) but are entirely absent from the API report.

Consequence: the api-report drift gate (`bun run api:check`) will not catch a breaking change to any symbol that lives under `./platform/...`, `./events/...`, `./client-auth`, or any other non-root subpath. The SDK has 43 public subpaths; the gate covers 1.

Fix options:
- Configure api-extractor multi-entry mode (enable `dtsRollup` per-entry plus separate report files per subpath). At minimum add a second `entryPoint` for `./platform/node` and `./platform/runtime`.
- Or add a custom drift script (`scripts/_internal/check-subpath-api.ts` style) that snapshots each public subpath's `dist/.../index.d.ts` symbol list and diffs on PRs.

Either way, the current configuration documents itself as comprehensive but covers about 5% of the public surface area.

### MAJ-02: `platform/node/index.ts` missing namespaces that `docs/public-surface.md:224` claims are reachable

- **Location**: `packages/sdk/src/platform/node/index.ts:1-23`, `docs/public-surface.md:224`
- **Severity**: MAJOR (Documentation drift)

`docs/public-surface.md:224` claims: "The following subsystems are accessible as namespaces through the aggregate `./platform` or `./platform/node` entry points... `acp`, `adapters`, `artifacts`, `automation`, `batch`, `channels`, `cloudflare`, `companion`, `control-plane`, `discovery`, `hooks`, `mcp`, `media`, `security`, `state`, `watchers`, `web-search`."

Actual `packages/sdk/src/platform/node/index.ts` re-exports these namespaces only:

```
artifacts, automation, channels, controlPlane, discovery, hooks, integrations, intelligence,
knowledge, mcp, media, multimodal, pairing, providers, runtime, state, tools, voice, watchers, webSearch
```

Missing from `./platform/node` (but doc says they're reachable): `acp`, `adapters`, `batch`, `cloudflare`, `companion`, `security`. So importing `import { adapters } from '@pellux/goodvibes-sdk/platform/node'` returns `undefined` despite the doc.

Additionally:
- `controlPlane` is camelCase in code; `control-plane` is hyphenated in doc. Picking either is fine — but they should match. Recommend documenting both names if one is an alias.
- `web-search` in doc → `webSearch` in code (same camelCase issue).
- `state` in doc → present in code (✓).

Fix: either add the 6 missing `export * as` lines to `platform/node/index.ts:1-23`, or revise `docs/public-surface.md:224` to list only what's actually re-exported (and clarify camelCase namespace names).

### MAJ-03: `./platform` exports more namespaces than `docs/public-surface.md:224` documents (partially-undocumented surface)

- **Location**: `packages/sdk/src/platform/index.ts:1-44`, `docs/public-surface.md:224`
- **Severity**: MAJOR (Documentation drift)

`packages/sdk/src/platform/index.ts:1-44` re-exports 44 namespaces. `docs/public-surface.md:224` claims 17 "subsystems available internally via `./platform`". The doc list is incomplete — the following are reachable through `./platform` but not mentioned in line 224:

- `agents` (line 3)
- `bookmarks` (line 7)
- `core` (line 13 — has its own subpath at `./platform/core`, but is also reachable here)
- `daemon` (line 14 — same)
- `exportData` (line 16 — note: namespace name is camelCase even though folder is `export/`)
- `git`, `integrations`, `intelligence`, `knowledge`, `multimodal`, `pairing`, `providers`, `runtime`, `tools`, `utils`, `voice` (all also have dedicated subpaths but reachable here)
- `permissions` (line 27)
- `plugins` (line 28)
- `profiles` (line 29)
- `scheduler` (line 32)
- `sessions` (line 34)
- `templates` (line 36)
- `types` (line 38)
- `workflow` (line 43)
- `workspace` (line 44)

The doc's framing — "subsystems that do not have their own dedicated public subpaths" — is approximately right for the 17 listed, but should also list: `agents`, `bookmarks`, `permissions`, `plugins`, `profiles`, `scheduler`, `sessions`, `templates`, `types`, `workflow`, `workspace`.

Fix: regenerate the line-224 list mechanically from `platform/index.ts`. Recommend a CI check that reads `platform/index.ts` and asserts the doc matches. Also note that `exportData` is a JS-keyword-collision rename (folder is `export`) — call this out in the doc, otherwise consumers will guess wrong.

### MAJ-04: `@internal` annotations on symbols that ARE exported through public subpaths

- **Location**: 9 dist `.d.ts` files; e.g. `packages/sdk/dist/platform/utils/fetch-with-timeout.d.ts:3`, `packages/sdk/dist/platform/runtime/events/index.d.ts:104`, `packages/sdk/dist/platform/intelligence/import-graph.d.ts:47,62,67,78`, `packages/sdk/dist/platform/hooks/chain-engine.d.ts:20`, `packages/sdk/dist/platform/runtime/ops/safe-check.d.ts:8`, `packages/sdk/dist/platform/runtime/diagnostics/panels/tool-{calls,contracts}.d.ts`, `packages/sdk/dist/platform/runtime/permissions/divergence-dashboard.d.ts:156`, `packages/sdk/dist/platform/providers/auto-register.d.ts:54,61,68`
- **Severity**: MAJOR (Contract leak)

Fourteen `@internal` JSDoc tags are emitted into published `.d.ts` files that sit under publicly-exported subpaths (`./platform/utils`, `./platform/intelligence`, `./platform/runtime/observability`, `./platform/runtime/store`, `./platform/tools`, `./platform/providers`, etc.). Examples:

- `packages/sdk/dist/platform/utils/fetch-with-timeout.d.ts:3` exports `sanitizeUrl` with `@internal Exported for testing only.` — but `./platform/utils` is a public stable subpath (per `docs/public-surface.md:221`).
- `packages/sdk/dist/platform/hooks/chain-engine.d.ts:20` exports `safeEvaluate` with `@internal — used directly by safe-evaluate.test.ts; not part of public API.` — `./platform` (which re-exports `hooks`) is public.
- `packages/sdk/dist/platform/providers/auto-register.d.ts:54,61,68` exports three test-only symbols with `@internal Exported for testing.` — `./platform/providers` is a public subpath.

Problem: `@internal` is enforced ONLY by api-extractor's report (which doesn't cover these subpaths — see MAJ-01). So consumers who import the symbol get a real binding, and any future internal-only refactor breaks them at minor/patch — silently violating `docs/semver-policy.md`.

Fix:
- Move test-only utilities into the `_internal/` source tree (already used at `packages/sdk/src/_internal/` per the project index) so they're not built into the public dist. The build script that produces `dist/` already places `_internal` source separately; the leak is that these symbols sit in `packages/sdk/src/platform/...` next to public code.
- Or expose them through dedicated `@pellux/goodvibes-sdk/_test` style sentinel subpath that's excluded from semver.
- Or wrap them in `__esModule` no-export form for tests via a `vitest`-style test helper.

### MAJ-05: `./auth`, `./errors`, `./events`, `./observer`, etc. are not classified as `client-safe` in capabilities.ts but ARE used from RN/browser companion paths

- **Location**: `packages/sdk/src/platform/node/capabilities.ts:29-36`, `packages/sdk/src/index.ts:18-22`, `packages/sdk/src/react-native.ts`, `docs/packages.md:65-75`
- **Severity**: MAJOR (Contract)

`docs/packages.md:65-75` lists "companion-safe entry points" including `./auth`, `./client-auth`, `./errors`, `./contracts`, `./operator`, `./peer`, `./transport-*`. But none of these appear in `GOODVIBES_CLIENT_SAFE_ENTRYPOINTS` (capabilities.ts:29-36). The only client-safe entries in capabilities.ts are `''` (root), `'/browser'`, `'/web'`, `'/workers'`, `'/react-native'`, `'/expo'`.

This intersects with CRIT-03 — capabilities.ts has a hole — but the discrete consequence here is that `docs/packages.md`'s "companion-safe" claim is unenforced. A regression that pulls a `node:fs` import into `./auth` (for example, by re-exporting an Android keystore implementation that uses Node APIs) would NOT be caught by `test/sdk-runtime-boundaries.test.ts` because `./auth` isn't classified.

The CI guard at `test/rn-bundle-node-imports.test.ts:26-34` does cover `auth.js` directly via the `COMPANION_ENTRIES` array — so the bundle-content test catches `node:` leaks. But the entrypoint classification array (capabilities.ts) is the SDK's published runtime contract — and downstream code that programmatically asks `isClientSafeGoodVibesEntrypoint('@pellux/goodvibes-sdk/auth')` gets `false`, contradicting the doc.

Fix: align capabilities.ts CLIENT_SAFE list with `docs/packages.md` companion-safe table.

### MAJ-06: `packages/sdk/package.json` `exports` map omits `default` condition (CJS/ESM resolver risk)

- **Location**: `packages/sdk/package.json:23-202`
- **Severity**: MAJOR (Compatibility)

Every export entry uses ONLY `{"types": "...", "import": "..."}`. There is no `default` (or `require`) condition. Per Node's conditional exports algorithm, if a tool resolves the package without a recognized condition (some bundlers, some test runners under node-without-esm-flag, deno/bun's compatibility shims), the resolution returns `undefined` and fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The package is `"type": "module"` and ships ESM only — that's a deliberate stance, fine. But the conventional dual-publishing pattern is `{"types": ..., "import": ..., "default": ...}` where `default` is the fallback for any non-CJS resolver. The CHANGELOG and docs indicate this is intentional ESM-only, but `attw` (the validator at root `package.json:64`) WILL treat missing `default` as a `cjs-resolves-to-esm` warning — confirmed because root `package.json:64` says `--ignore-rules no-resolution cjs-resolves-to-esm`, i.e., the warning IS being silenced.

This is a deliberate ignore. But the silence means a downstream consumer using `tsconfig` `"moduleResolution": "node"` (still common) can't resolve any subpath — they'd get `Cannot find module '@pellux/goodvibes-sdk/operator'`. Document this constraint explicitly:

Fix: add a section to `docs/semver-policy.md` and `docs/packages.md` stating: "Consumers must use `"moduleResolution": "bundler"`, `"node16"`, or `"nodenext"`. Classic `"node"` resolution is not supported." Also document that `--ignore-rules cjs-resolves-to-esm` is intentional and what it means.

### MAJ-07: `./contracts/operator-contract.json` and `./contracts/peer-contract.json` are exported as raw JSON but the `types` condition is missing

- **Location**: `packages/sdk/package.json:49-50`
- **Severity**: MAJOR (Type resolution)

```
"./contracts/operator-contract.json": "./dist/contracts/artifacts/operator-contract.json",
"./contracts/peer-contract.json": "./dist/contracts/artifacts/peer-contract.json",
```

These entries are raw string targets — no `{"types": ..., "import": ...}` conditional. Consequences:

- TypeScript with `"resolveJsonModule": true` will allow `import contract from '@pellux/goodvibes-sdk/contracts/operator-contract.json'` but the inferred type will be `any` (or whatever shape TS infers from raw JSON), NOT `OperatorContractManifest`.
- The artifacts under `dist/contracts/artifacts/` ARE present (verified). The raw JSON contains the full contract shape. No `.d.json.ts` or sidecar typing exists.

`docs/public-surface.md:55-69` calls these `"Status: stable"` entries. Stable status implies a stable type contract; but the type contract is not exposed.

Fix: provide a `.d.json.ts` sidecar (via a build step that emits `dist/contracts/artifacts/operator-contract.d.json.ts` shaped as `declare const value: OperatorContractManifest; export default value;`). Or change the export to `{"types": "...", "default": "..."}` form. Or document explicitly: "raw JSON; type as `unknown` or import from `./contracts` for the typed manifest."

### MAJ-08: `transport-core/package.json` exports `./otel`, `./uuid`, `./middleware`, etc. but root SDK only re-exports a small subset

- **Location**: `packages/transport-core/package.json:12-46`, `packages/sdk/src/transport-core.ts`
- **Severity**: MAJOR (Dependency surface)

`packages/transport-core/package.json:12-46` exposes 8 subpath exports including `./otel`, `./uuid`, `./middleware`, `./observer`, `./client-transport`, `./event-envelope`, `./event-feeds`. These are all published to npm under `@pellux/goodvibes-transport-core`.

The SDK re-exports `transport-core` as a single subpath (`@pellux/goodvibes-sdk/transport-core`) but does NOT mirror the subpath structure. So a consumer who reads `docs/packages.md:73` ("`/transport-core` for transport/event-feed primitives") cannot use `@pellux/goodvibes-sdk/transport-core/otel` — that path is not in the SDK's exports map.

This is fine if the SDK's stance is "`./transport-core` is the aggregate barrel" — but `packages/sdk/src/transport-core.ts` (verified to be 16 lines) re-exports a subset of `transport-core/src/index.ts` (which is also 16 lines, identical). So the SDK is effectively a passthrough. Why publish both?

If the answer is "transport-core is independently versionable", that's fine — but the doc should explicitly say: "For OTel injection helpers, install `@pellux/goodvibes-transport-core` directly; the SDK re-exports only the high-level transport types."

Fix: clarify in `docs/packages.md` whether the sibling packages are first-class consumer entry points or implementation details. Right now `docs/packages.md:5-7` says "sibling packages are public dependencies and source-of-truth facades, not separate setup steps for most consumers" — but that's contradicted by listing `./transport-core` as a companion-safe entry point. Either: (a) remove direct sibling-package consumption from the consumer story; or (b) extend the SDK's exports map to mirror sibling package subpaths (e.g., add `./transport-core/otel`, `./transport-core/middleware`, etc.).

### MAJ-09: `bundle-budgets.json` does NOT cover `./events/*` wildcard, `./contracts/*.json` static, or `./platform/runtime/observability` is missing from bundle-budget if its entry was added recently

- **Location**: `bundle-budgets.json:1-187`, `packages/sdk/package.json:63-66, 49-50`
- **Severity**: MAJOR (Release gate gap)

Compared `bundle-budgets.json` keys vs `packages/sdk/package.json` exports keys:

- ALL 42 fixed-path entries in bundle-budgets.json correspond to a package.json export entry. ✓
- Wildcard `./events/*` is NOT budgeted. This is intentional per the comment in bundle-budgets.json:1-13 ("JSON artifacts are static and excluded") — but the comment talks about JSON artifacts, not wildcard event subpaths. The wildcard still produces 27 distinct dist files, each unbudgeted. Consequence: a contributor who adds an event domain that pulls in a 50KB dependency will not be caught.
- `./contracts/operator-contract.json` and `./contracts/peer-contract.json` are intentionally excluded (per the budget comment) — that's documented and correct.
- `./package.json` is excluded — fine, it's metadata.

Fix: extend `scripts/bundle-budget.ts` to assert per-domain limits for `./events/*` (e.g., `./events/agents`, `./events/automation`, etc.) — at minimum document the explicit exclusion in `bundle-budgets.json:1-13`.

### MAJ-10: `peerDependencies` for `expo-secure-store` and `react-native-keychain` are declared in `packages/sdk/package.json:259-269` but not surfaced in capabilities.ts dependencyFamilies

- **Location**: `packages/sdk/package.json:259-269`, `packages/sdk/src/platform/node/capabilities.ts:64-160`
- **Severity**: MAJOR (Documentation/Tooling)

The SDK declares peerDependencies on `expo-secure-store` and `react-native-keychain` (as optional). `GOODVIBES_RUNTIME_CAPABILITIES` (capabilities.ts:64-160) defines the full capability/dependency story — but the `client-safe` capability `remote-client` (capabilities.ts:65-77) lists `dependencyFamilies` as `['@pellux/goodvibes-transport-*', '@pellux/goodvibes-operator-sdk', '@pellux/goodvibes-peer-sdk']` only. There is no entry for `expo-secure-store` or `react-native-keychain`, and no surfaced capability for `secure-mobile-storage` (the requirement type IS defined at capabilities.ts:18 but unused).

Downstream tooling that asks "what optional dependencies do I need to run on Hermes?" would not find these in the SDK's capability registry.

Fix: add a 7th capability entry, e.g.:
```
{ id: 'mobile-secure-storage',
  description: 'Secure token storage for iOS/Android via Keychain/Keystore.',
  entrypoints: ['@pellux/goodvibes-sdk/client-auth', '@pellux/goodvibes-sdk/expo'],
  surfaces: ['mobile'],
  requirements: ['secure-mobile-storage'],
  dependencyFamilies: ['expo-secure-store', 'react-native-keychain'],
}
```

---

## MINOR

### MIN-01: `docs/public-surface.md` does not list every subpath in a single canonical table

- **Location**: `docs/public-surface.md`
- **Severity**: MINOR (Discoverability)

The doc structure intermixes prose and a table at line 198-222 (the platform subpaths table). Top-level subpaths (`./auth`, `./browser`, etc.) are described in narrative form scattered through lines 29-172. There's no single table answering: "what are ALL public subpaths and their stability".

Fix: add a top-of-file canonical table mirroring `bundle-budgets.json` keys, then defer narrative explanations to per-subpath subsections. This makes mechanical diff-vs-package.json checks easy.

### MIN-02: `docs/semver-policy.md:19` references runtime matrix; `node` is excluded but `bun` is included — but `engines.node` is `>=22.0.0`

- **Location**: `docs/semver-policy.md:19`, `packages/sdk/package.json:209-212`
- **Severity**: MINOR (Documentation precision)

The semver policy says: "`node` as a standalone target is not a documented supported runtime — the `engines.node` field reflects the build/Bun host requirement." Yet `packages/sdk/package.json:211` declares `"node": ">=22.0.0"` — this is interpreted by npm/yarn as a runtime requirement on the consumer, NOT just the build host. A user installing the SDK on Node 20 will get an `EBADENGINE` warning even if they only use companion entry points (which are pure ESM and node-version-agnostic).

Fix: either drop `engines.node` (signaling no Node consumer support) or document precisely why it's there. The current statement "reflects the build/Bun host requirement" is what the AUTHOR means but is not what npm's `engines` semantics MEAN. Add a comment in package.json or a NOTE in semver-policy.md disambiguating.

### MIN-03: `docs/public-surface.md:147` "Browser-optimized SDK entry. Browser-safe entry with browser-appropriate reconnect/retry defaults." — duplicate phrasing

- **Location**: `docs/public-surface.md:147`
- **Severity**: MINOR (Quality)

The sentence repeats "Browser" three times in 14 words. Refactor to: "Browser-optimized SDK entry. Provides browser-safe defaults for reconnect, retry, and storage."

### MIN-04: `bundle-budgets.json` has no `./contracts/*.json` entry but the comment refers to JSON exclusions in plural

- **Location**: `bundle-budgets.json:1-13`
- **Severity**: MINOR (Documentation)

The top-of-file comment says "JSON artifacts are static and excluded from gzip bundle-budget tracking. See `bundle-budgets.json` comments" — but there are no JSON entries in bundle-budgets.json to refer to. The reader expects a list. Recommend rewording: "`./contracts/*.json` raw artifact subpaths are intentionally not budgeted (static JSON files; their size is governed by the contract refresh process at `scripts/refresh-contract-artifacts.ts`)."

### MIN-05: `bundle-budgets.json` `./platform/voice` rationale reads "public facade" — same string used for 11 entries

- **Location**: `bundle-budgets.json:154-156` (and `./platform/git`, `./platform/integrations`, `./platform/intelligence`, `./platform/knowledge`, `./platform/multimodal`, `./platform/node`, `./platform/pairing`, `./client-auth`, `./events`, `./observer`)
- **Severity**: MINOR (Documentation)

For 11 entries, the `rationale` field is exactly `"public facade; measured X B gzip; max(...)=Y"`. The string `"public facade"` is used as a placeholder when nothing more specific applies. That's acceptable for terseness but loses the auditability described in the file's intent. Recommend specifying what the facade re-exports (e.g., `"public facade re-exporting platform/git surface; ..."`).

### MIN-06: `test/types/typed-client-usage.ts:52-56` uses `using` declarations (TC39 explicit resource management)

- **Location**: `test/types/typed-client-usage.ts:52-56`
- **Severity**: MINOR (TypeScript version sensitivity)

The `using` keyword requires TS 5.2+ AND the consumer's tsconfig has `target: es2022` or later (ideally `esnext`) and the right libs. `docs/semver-policy.md:85` says minimum supported TS is 6.0 — fine. But the `using` syntax may fail in older RN TypeScript setups that haven't bumped past the 5.x line. The type test exists to validate consumer surface — but consumers on TS 5.4 will fail to compile this exact construct.

This isn't a wrong choice (the SDK targets TS 6.0+) — but it should be flagged in the docs that consumers MUST be on TS 5.2+ to get disposal symbol type-checking even though the SDK supports TS 6.0+ for general types.

### MIN-07: `packages/sdk/package.json:204-208` `"files"` array includes `"dist"`, `"README.md"`, `"LICENSE"` but not `"CHANGELOG.md"`

- **Location**: `packages/sdk/package.json:204-208`
- **Severity**: MINOR (Discoverability in published tarball)

Most npm-published SDKs include CHANGELOG.md in the published tarball so consumers can read change history without browsing the repo. The root has CHANGELOG.md; the published SDK should bundle it.

Fix: add `"CHANGELOG.md"` to the `"files"` array.

### MIN-08: `packages/sdk/package.json:259-269` `peerDependencies` versions `>=13.0.0` (expo-secure-store) and `>=8.0.0` (react-native-keychain) have no upper bound

- **Location**: `packages/sdk/package.json:259-269`
- **Severity**: MINOR (Dependency stability)

Unbounded peer-dep ranges (`>=X`) accept any future major version, including breaking ones. Better practice is `>=13.0.0 <X+2` — caps at the next-next major to allow one major bump while gating two. Same for keychain.

Fix: pin to known-tested ranges, or document an SDK→peer-dep compatibility matrix.

### MIN-09: `docs/packages.md:9` references `./surfaces.md` but no link to `./public-surface.md` in the same opening paragraph

- **Location**: `docs/packages.md:9`
- **Severity**: MINOR (Documentation cross-linking)

Readers landing on `docs/packages.md` aren't immediately pointed at the canonical surface listing. Add: "See [Public Surface](./public-surface.md) for the per-subpath stability table" alongside the surfaces.md reference.

### MIN-10: `api-extractor.json:52-57` silences five compiler errors (TS1259, TS2305, TS2307, TS2344, TS2694, TS2707)

- **Location**: `api-extractor.json:52-57`
- **Severity**: MINOR (Tooling debt)

These suppressions hide:
- TS1259: "Module ... can only be default-imported using the `esModuleInterop` flag"
- TS2305: "Module ... has no exported member"
- TS2307: "Cannot find module ... or its corresponding type declarations"
- TS2344: "Type ... does not satisfy the constraint"
- TS2694: "Namespace ... has no exported member"
- TS2707: "Generic type ... requires between N and M type arguments"

These being silenced explains why api-extractor doesn't fail despite the report being incomplete (MAJ-01). Cleanup path: add explicit `tsconfig.api-extractor.json` overrides for resolution; remove silencers as they become unneeded; track in a `// TODO` in `api-extractor.json`.

---

## NITPICK

### NIT-01: `packages/sdk/package.json:5-11` `keywords` array has only 5 entries; competing SDKs use 8-12

Add `"realtime"`, `"sse"`, `"websocket"`, `"react-native"`, `"daemon"`, `"acp"` for npm discoverability. (Currently has: `goodvibes`, `sdk`, `browser`, `react-native`, `control-plane` — but `react-native` is duplicated with `keywords` line 9.)

### NIT-02: `docs/semver-policy.md:15` lists 12 `SDKErrorKind` values inline

The inline list is hard to maintain. Recommend pulling it from `packages/errors/src/index.ts:37-49` at doc generation time so the values can never drift. The current text says "verified against `packages/errors/src/index.ts:37-49`" — but a future renamer must remember to also update this prose, which is the exact human-error mode semver-policy is meant to prevent.

### NIT-03: `etc/goodvibes-sdk.api.md` is 17,489 lines — file size 646 KB

This is an unusually large API report. Fine for tooling but uncomfortable for human review. Consider splitting per-namespace (api-extractor supports that with separate report files per entry point), or at least adding a per-section TOC at the top.

### NIT-04: `bundle-budgets.json` rationale fields use `"max(ceil(X*1.2)=Y, X+50=Z)=W"` syntax — minor inconsistency

Some entries have `"max(ceil(X*1.2)=Y, X+50=Z)=W"` and others have `"max(ceil(X*1.2), X+50)=W"` (without intermediate `=Y` calculations). Standardize on one format for grep-ability.

### NIT-05: `packages/sdk/src/index.ts:46-57` comment is great but doesn't list the actual collision-prone names

The comment explains the indirection rationale and names the collision risk. It would be more actionable if it listed which export-* targets are most at risk (e.g., "events/* and contracts/* both export `RuntimeEventDomain`-related names; explicit re-export at lines 63-110 disambiguates").

### NIT-06: `test/sdk-runtime-boundaries.test.ts:74-89` relies on `clientFiles` hardcoded list

The test hardcodes `['browser.ts', 'web.ts', 'workers.ts', 'react-native.ts', 'expo.ts', 'index.ts']`. If a new client-safe entry is added, the test must be manually updated. Recommend deriving from `GOODVIBES_CLIENT_SAFE_ENTRYPOINTS` (capabilities.ts) — bonus benefit: catches CRIT-03 indirectly.

### NIT-07: `docs/public-surface.md:9-11` stability levels (`stable`, `beta`, `preview`) match `docs/public-surface.md` per-entry status, but the doc never marks any entry as `preview` except `./workers`

`./workers` is marked `preview` (line 157). All `./platform/...` are `beta`. If `preview` only ever applies to `./workers`, drop the level or merge it into `beta` with a per-entry annotation.

### NIT-08: Inconsistent capitalization — "GoodVibes" in code, "Good Vibes" in some docs/keywords

Search for `"good vibes"` (lowercase, two words) in docs to standardize. Brand consistency matters for npm SEO.

---

## Counts by Severity

- **CRITICAL**: 3
- **MAJOR**: 10
- **MINOR**: 10
- **NITPICK**: 8

**Total issues**: 31

## Score: 6.5/10

The public surface is well-documented and largely consistent at the file-existence level — every dist target referenced from the exports map is present. But the gates that should ENFORCE consistency (api-extractor report, runtime-boundary classification, bundle budgets) cover only the root entry. The SDK has 43 published subpaths and the strict drift gate covers 1.

The top blockers are:

1. **CRIT-01** — `./events/*` wildcard exposes implementation modules (`domain-map`, `contracts`) as published paths.
2. **CRIT-02** — empty `packages/transport-direct/` workspace directory referenced as a real package.
3. **CRIT-03** — `capabilities.ts` classifies only 30 of 43 published entrypoints; companion-safe and node-runtime claims in the docs are not backed by code.
4. **MAJ-01/MAJ-04** — api-extractor gate is single-entry; `@internal` annotations leak through public subpaths because no enforcement walks them.

Most MAJOR issues are documentation drift between three sources of truth (`package.json`, `capabilities.ts`, `docs/public-surface.md`) — the fix is mechanical: derive the doc and capabilities arrays from `package.json` at CI time.

The SDK is published; CRIT-01/02/03 must be addressed before the next minor release to avoid release-breaking ambiguity.
