# @pellux/goodvibes-toolchain

Shared GoodVibes CI/CD toolchain. One published home for the release, publish,
and verification scripts that used to live as 2–3 parallel copies across the
`goodvibes-tui`, `goodvibes-agent`, `goodvibes-webui`, and `goodvibes-sdk`
repos. Repo-specific values live in each repo's `toolchain.config.json`; the
behavior lives here, so every repo maintains one implementation instead of
several drifting ones.

## Tools

Each tool ships as a library policy function (with injectable I/O for testing)
and a thin CLI (`bin` entry):

- **sdk-pin-gate** — pin ⇄ lockfile ⇄ installed tri-agreement plus a non-npm
  import sweep and an optional exports-map check.
- **build-binaries** — `bun build --compile` across a target matrix, with an
  optional daemon leg and native-addon copy/cross-fetch, all config-driven.
- **release-cut** — prepare/bump/changelog/tag only. Never re-runs gates (CI
  owns validation).
- **coverage-gate** — aggregate coverage ratchet against per-repo floors.
- **verification-ledger** — totals math and JSON/Markdown rendering of a
  repo-collected verification inventory.
- **post-build-smoke** — boots a compiled binary and checks its version banner.
- **package-install-check** — static `npm pack` tarball + bin-shim policy check.
- **publish-package** — idempotent `npm publish` plus a propagation poll.
- **per-job-green** — verifies a commit's push-CI run concluded with every job
  green, with a 503-resilient check-suites fallback. The by-reference
  validation primitive.
- **changelog-gate** — asserts CHANGELOG carries a section for a version.
- **sha256sums** — generate/verify a `SHA256SUMS` manifest over release assets.

## Config

See `docs/release-and-publishing.md` in the SDK repo for the full
`toolchain.config.json` contract and per-repo examples. Import the
`ToolchainConfig` type from `@pellux/goodvibes-toolchain` for editor help.

## Usage

```ts
import { runSdkPinGate, realFsReader, loadToolchainConfig } from '@pellux/goodvibes-toolchain';

const config = loadToolchainConfig();
const results = runSdkPinGate(realFsReader(process.cwd()), config.sdkPin);
```

Every function accepts its effects (exec, fs, http, sleep, logger) as
parameters, so unit tests drive them with in-memory stubs — no network and no
real git mutations.
