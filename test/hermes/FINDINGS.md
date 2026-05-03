# Hermes Compatibility Findings

Findings from Wave 3 Hermes real-runtime harness investigation.
Date: 2026-04-17

## Summary

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| F1 | BLOCKER | Open | No publicly available standalone Hermes binary supports async/await |
| F2 | Finding | Documented | SDK uses private class fields (#field) — downlevel required for pre-0.12 Hermes CLI |
| F3 | Finding | Documented | SDK's error taxonomy (class inheritance) requires es2015+ — pre-ES2015 Hermes CLI unsupported |
| F4 | Advisory | Open | Several ES2021 APIs (structuredClone, Array.at, Object.hasOwn) absent in bare Hermes CLI |

---

## F1 — BLOCKER: Standalone Hermes CLI does not support async/await

**Severity**: Blocker (prevents full VM execution of the SDK bundle)

**Affected feature**: SDK auth and `@pellux/goodvibes-transport-http`
modules use `async/await`
pervasively for token resolution and HTTP fetch wrapping.

**Root cause**:

The only standalone Hermes binaries publicly available are from
`github.com/facebook/hermes/releases` (latest: v0.13.0, 2024-08-16) and the
npm package `hermes-engine@0.11.0`. Both are 2021-2022 era builds:

- `hermes-cli-linux.tar.gz` from `v0.13.0` release: Combined compiler+runner,
  internal version `0.12.0`, **rejects async/await** with:
  `error: async functions are unsupported`

- `hermes-engine@0.11.0` npm package (`hermesc` binary): Bytecode compiler only
  (no VM execution), **rejects async/await** and `class extends` syntax.

Modern Hermes (the engine embedded in React Native 0.71+) fully supports async/await
but is only available as part of RN's native build system — not as a standalone
npm-installable CLI binary.

**Evidence**:
```
$ test/hermes/bin/hermes test/hermes/dist/hermes-test-bundle.js
test/hermes/dist/hermes-test-bundle.js:57954:14: error: async functions are unsupported
      return async () => void 0;
             ^~~~~~~~~~~~~~~~~~
```

The offending code resolves through the HTTP transport bundle:
```js
// normalizeAuthToken - transport-http internal
function normalizeAuthToken(input) {
  if (input === void 0) {
    return async () => void 0;  // <-- Hermes CLI rejects this
  }
  ...
}
```

**Proposed resolution**:

Option A (recommended for CI): Build Hermes from source in the CI job:
```yaml
- name: Build Hermes from source
  run: |
    git clone --depth=1 --branch main https://github.com/facebook/hermes
    cmake -S hermes -B hermes-build \
      -DHERMES_ENABLE_TEST_SUITE=OFF \
      -DCMAKE_BUILD_TYPE=MinSizeRel
    cmake --build hermes-build --target hermes -j$(nproc)
    cp hermes-build/bin/hermes test/hermes/bin/hermes
```
Estimated CI time: 8-12 minutes on `ubuntu-latest`. Should be done in a
reusable workflow or cached artifact.

Option B: Extract Hermes from React Native's npm tarball. RN 0.76.9 ships
`hermes-android-debug.aar` and platform-specific `.xcframework` bundles —
none of these are easily extractable as a standalone Linux binary for CI.

Option C: Use `ghcr.io/facebook/hermes` Docker image — the image exists but
requires GHCR authentication and is not publicly accessible without RN org
membership.

**Architectural impact**: None to the SDK itself. The async/await usage in the
transport layer is correct for all real Hermes environments. This is purely a
tooling gap in the test harness setup.

---

## F2 — Private class fields (#field) not supported in pre-0.12 Hermes CLI

**Severity**: Finding (downlevel tooling handles this; not a runtime bug)

**Affected files**:
- `packages/sdk/dist/client-auth/permission-resolver.js`
- `packages/sdk/dist/client-auth/token-store.js`
- `packages/sdk/dist/client-auth/session-manager.js`
- `packages/sdk/dist/platform/runtime/auth/oauth-client.js`
- (7 more files)

**Root cause**: The SDK's TypeScript `tsconfig.base.json` targets `ES2023`, which
preserves private class field syntax (`#field`) in emitted JS. Hermes CLI 0.12.0
and older reject this syntax with:
```
error: private properties are not supported
```

**Evidence**:
```
$ test/hermes/bin/hermes test/hermes/dist/hermes-test-bundle.js
test/hermes/dist/hermes-test-bundle.js:59023:5: error: private properties are not supported
    #snapshot;
```

**Resolution** (implemented in this harness):

The `bundle-for-hermes.ts` script uses esbuild with `--target=es2019`, which
downlevels private class fields to WeakMap-based equivalents before handing
the bundle to Hermes. This is the correct approach — the same transformation
that Metro applies when bundling for older Hermes targets.

**No SDK changes required.** The downlevel is a bundler responsibility, not
an SDK change. Metro and Expo's bundler perform this automatically.

---

## F3 — hermesc@0.11.0 rejects class extends syntax

**Severity**: Finding (tooling limitation, not an SDK bug)

**Affected code**: All error classes (`GoodVibesSdkError`, `ConfigurationError`,
etc.) use `class extends`.

**Root cause**: `hermesc@0.11.0` npm package is from 2022 and predates
ES2015 class support. Even with `--target=es2015` esbuild downlevel:
```
$ hermesc -emit-binary test/hermes/dist/hermes-test-bundle.js -out test.hbc
test/hermes/dist/hermes-test-bundle.js:102:27: error: Invalid expression encountered
  var GoodVibesSdkError = class extends Error {
```

**Resolution**: Do not use `hermes-engine@0.11.0` npm package for SDK validation.
This binary is too old to validate any modern JS SDK. Use the modern Hermes
binary from source build (see F1 resolution) instead.

**No SDK changes required.**

---

## F4 — Advisory: ES2021 API availability varies by Hermes version

**Severity**: Advisory (affects specific RN version ranges, not modern RN)

The test runner in `hermes-runner.js` probes for the following APIs that have
version-specific availability in Hermes:

| API | Added in Hermes | Equivalent RN version |
|-----|----------------|----------------------|
| `Object.hasOwn` | 0.11.0 | RN 0.70 |
| `Array.prototype.at` | 0.11.0 | RN 0.70 |
| `structuredClone` | 0.12.0 | RN 0.73 |
| `Error.cause` | 0.12.0 | RN 0.73 |
| `WeakRef` | 0.11.0 | RN 0.70 |
| `Promise.allSettled` | 0.11.0 | RN 0.70 |
| `AbortController` | Not in CLI | RN 0.71 (via JSI polyfill) |
| `queueMicrotask` | Not in CLI | RN 0.71 (via JSI polyfill) |

The SDK's stated minimum Hermes version should be documented. If the SDK targets
RN 0.71+, it can safely use all APIs in the table above except `structuredClone`
and `Error.cause` (which require RN 0.73+).

**Recommendation**: Confirm the minimum supported RN version in SDK documentation
and add a semver guard in the README. The test runner probes will catch regressions
when the harness runs under a sufficiently modern Hermes (F1 resolved).

---

## Testing performed

```
Environment:
  Platform: Linux x86-64
  Bun: 1.3.10
  esbuild: 0.28.0 (via bunx)
  Hermes binary: test/hermes/bin/hermes (from github.com/facebook/hermes v0.13.0)
    Internal version: 0.12.0 (2022-era)
  hermesc: hermes-engine@0.11.0 npm (compiler only, 2022-era)

Bundle:
  Entry: test/hermes/hermes-runner.js
  Bundler: esbuild --target=es2019 --format=iife --platform=browser
  Bundle size: ~1.9MB (includes full SDK dist chain)
  Private field downlevel: YES (esbuild es2019 target)
  async/await downlevel: NO (preserved in bundle, rejected by Hermes CLI)

Results:
  Hermes CLI (v0.13.0/0.12.0) execution: BLOCKED by async/await rejection (F1)
  hermesc@0.11.0 compilation: BLOCKED by async/await + class extends rejection (F2, F3)
  esbuild bundle generation: SUCCESS (es2019 target, private fields downleveled)
```

## Next steps

1. **F1 resolution** (blocker): Add Hermes build-from-source step to CI, or find
   a publicly accessible modern Hermes binary. Once resolved, the existing test
   runner (`hermes-runner.js`) should execute cleanly under modern Hermes — all
   SDK features used in the runner are synchronous-safe after bundling.

2. After F1 is resolved, run the full harness and document actual runtime findings
   (F4 API availability checks will produce real results at that point).

3. Add the `hermes` platform dimension to `ci.yml` (see `SETUP.md`).
