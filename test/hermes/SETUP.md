# Hermes Real-Runtime Test Harness — Setup Guide

This directory contains the Wave 3 Hermes test harness for `@pellux/goodvibes-sdk`.
It proves the companion `react-native.js` bundle runs under the Hermes JS engine
that powers React Native, catching engine-specific quirks that bundle-shape checks
cannot (private field support, regex lookbehind, `Object.hasOwn`, `Array.at`, etc.).

## Architecture

```
test/hermes/
  hermes-runner.js          # Test entry point (import SDK + run assertions)
  bundle-for-hermes.ts      # Bun script: bundles runner via esbuild (es2019 target)
  setup-hermes.sh           # Downloads Hermes CLI binary (meta/hermes releases)
  run-hermes-tests.sh       # End-to-end: build -> bundle -> execute
  dist/                     # Generated: hermes-test-bundle.js (gitignored)
  bin/                      # Generated: hermes binary (gitignored)
  SETUP.md                  # This file
  FINDINGS.md               # Hermes runtime findings
```

## Critical Context: Hermes Binary Availability

> **IMPORTANT** — Read before integrating into CI.

The Hermes standalone CLI binary available from `github.com/facebook/hermes/releases`
(latest: v0.13.0, published 2024-08-16, internal version 0.12.0) is **2022-era** and
**does not support async/await or ES2017+ class syntax** in source-mode execution.

Modern Hermes (the engine that actually powers React Native 0.71+) is only available:
- Embedded inside React Native's native build system (Gradle/CocoaPods)
- As part of the `react-native` npm package's platform-specific build artifacts
- Built from source via the Hermes GitHub repo

See `FINDINGS.md` for the full analysis and proposed fix.

## Local Setup

### Prerequisites

- Bun 1.3.x (`bun --version`)
- SDK built: `bun run build` (generates `packages/sdk/dist/`)

### Option A: Syntax-only validation (hermesc compiler, no VM execution)

This validates that the bundle is parseable by Hermes without runtime execution.
Available today with no additional setup.

```bash
# Install hermesc from npm (compiler only, no VM)
bun add --dev hermes-engine@0.11.0

# Build SDK
bun run build

# Bundle the test runner (esbuild downlevels to es2015 for hermesc compat)
bun x esbuild --bundle --target=es2015 --format=iife --platform=browser \
  --outfile=test/hermes/dist/hermes-test-bundle.js \
  test/hermes/hermes-runner.js

# Compile to Hermes bytecode (validates parse + compilation, not execution)
node_modules/hermes-engine/linux64-bin/hermesc \
  -emit-binary test/hermes/dist/hermes-test-bundle.js \
  -out test/hermes/dist/hermes-test-bundle.hbc
```

If hermesc exits 0, the bundle compiles to Hermes bytecode cleanly.
If it fails, there is a Hermes syntax-level runtime issue.

**CURRENT STATUS**: `hermesc@0.11.0` rejects `class extends` (ES2015 class inheritance)
and `async/await`. The SDK requires both. See `FINDINGS.md` for the fix path.

### Option B: Full VM execution (requires modern Hermes binary)

This is the goal state. Blocked until a modern Hermes binary is available.
See `FINDINGS.md` — Finding F1 for the resolution path.

```bash
# Build Hermes from source (the only reliable path to a Linux CLI binary):
git clone --depth=1 --branch v0.13.0 https://github.com/facebook/hermes
cmake -S hermes -B hermes-build -DHERMES_ENABLE_TEST_SUITE=OFF -DCMAKE_BUILD_TYPE=MinSizeRel
cmake --build hermes-build --target hermes -j$(nproc)
cp hermes-build/bin/hermes test/hermes/bin/hermes

# Then run the harness
bash test/hermes/run-hermes-tests.sh
```

> **NOTE**: The `hermes-runtime-android.tar.gz` artifact from React Native releases
> contains Android `.so` shared libraries, NOT a Linux-executable `hermes` CLI binary.
> Extracting it produces unrunnable artifacts on Linux. Do not use it for CI.
> The build-from-source path above is the correct approach.

## Package.json changes (orchestrator action required)

Add the following to the **root `package.json`** `scripts` section:

```json
"test:hermes": "bun run build && bun run test/hermes/bundle-for-hermes.ts && bash test/hermes/run-hermes-tests.sh --no-build",
"hermes:setup": "bash test/hermes/setup-hermes.sh",
"hermes:bundle": "bun run test/hermes/bundle-for-hermes.ts"
```

Do NOT add `hermes-engine` as a devDependency at this time — it provides only a
2022-era compiler that cannot execute async/await (see FINDINGS.md F1).

## Proposed CI Additions

Do NOT modify `.github/workflows/ci.yml` directly (agent constraint). The orchestrator
should apply the following diff:

```yaml
# Add to the platform-matrix job's matrix.include section:

  - platform: hermes
    node-version: "22"
    test-cmd: |
      # Step 1: Build SDK dist
      bun run build

      # Step 2: Obtain modern Hermes binary
      # Option A (preferred): download from Meta's CDN via RN release
      bash test/hermes/setup-hermes.sh

      # Step 3: Bundle test runner
      bun run test/hermes/bundle-for-hermes.ts

      # Step 4: Execute under Hermes
      bash test/hermes/run-hermes-tests.sh --no-build
```

**BLOCKED**: The CI step above is ready in structure but BLOCKED on F1 (async/await
support in standalone Hermes binary). Do not add the `hermes` matrix dimension to
`ci.yml` until F1 is resolved.

### Full proposed diff for `ci.yml` platform-matrix (apply when F1 resolved)

```yaml
      matrix:
        platform:
          - bun
          - rn-bundle
+         - hermes
        include:
          - platform: bun
            node-version: "22"
            test-cmd: bun run build && bun test test
          - platform: rn-bundle
            node-version: "22"
            test-cmd: bun run build && bun run test:rn
+         - platform: hermes
+           node-version: "22"
+           test-cmd: |
+             bun run build
+             bash test/hermes/setup-hermes.sh
+             bun run test/hermes/bundle-for-hermes.ts
+             bash test/hermes/run-hermes-tests.sh --no-build
```

Additionally, add a setup step to the platform-matrix job to install the Hermes
binary before the test command:

```yaml
      - name: Install Hermes binary (hermes platform only)
        if: matrix.platform == 'hermes'
        run: |
          # Download Hermes binary from Meta's GitHub releases
          # When F1 is resolved, this step will use the modern Hermes binary
          bash test/hermes/setup-hermes.sh
```

## Hermes Version Target

This harness targets **Hermes 0.12.0** (shipped in RN 0.71–0.73) as the minimum
supported version, with the goal of validating against RN 0.76+ (Hermes 0.13+).

Key ES feature support by Hermes version:

| Feature | Hermes (standalone CLI) | Modern Hermes (RN 0.73+) |
|---------|------------------------|---------------------------|
| async/await | NOT supported in CLI | Supported |
| private class fields (#x) | NOT supported | Supported |
| `class extends` | NOT supported (hermesc@0.11) | Supported |
| `Object.hasOwn` | NOT supported (< 0.11) | Supported |
| `Array.prototype.at` | NOT supported (< 0.12) | Supported |
| `structuredClone` | NOT supported (< 0.12) | Supported |
| regex lookbehind | Supported (0.12+) | Supported |
| `WeakRef` | Supported (0.11+) | Supported |
| `Error.cause` | Supported (0.12+) | Supported |
| `Promise.allSettled` | NOT supported (< 0.11) | Supported |

## What the harness validates

When running under a modern Hermes VM:

1. **Engine feature parity** — confirms all ES2021 APIs the SDK relies on are
   available in the Hermes version under test (guards against RN upgrades breaking
   things by detecting missing APIs at test time, not user runtime).

2. **SDK factory shape** — `createReactNativeGoodVibesSdk` constructs successfully,
   returns correct API surface (`auth`, `realtime`, `operator`, `peer`).

3. **Error taxonomy under Hermes** — validates that `class extends` chains for
   `GoodVibesSdkError` → `ConfigurationError` etc. maintain `instanceof` correctness
   under Hermes's prototype chain implementation (different from V8 in subtle ways).

4. **ConfigurationError paths** — factory throws on missing `baseUrl`, `realtime.runtime()`
   throws on missing `WebSocket` — all validated without network access.

5. **No node: builtins in bundle** — enforced by esbuild `--platform=browser`;
   any node: leak causes a bundle failure, preventing the test from even running.
