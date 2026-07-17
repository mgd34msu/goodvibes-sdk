# Release Policy

This document describes the public release quality policy for the GoodVibes SDK
workspace. Historical release narratives live in `CHANGELOG.md`.

## Platform Support

Release validation is supported on macOS and Linux. Windows users should use a
Linux CI runner or WSL2 for release validation because the validation scripts
use POSIX process management and filesystem behavior.

## Release Rules

- Package versions must be aligned across the workspace.
- `CHANGELOG.md` must contain the release narrative for the package version.
- Generated contracts and generated docs must match source.
- Validation must pass before a release is cut.
- Releases must not be cut while the operator has explicitly placed a hold.

The SDK targets Bun for daemon/platform surfaces and browser, Hermes, and
Workers for companion-safe surfaces. Node.js is not a documented consumer
runtime target; see [Runtime surfaces](./surfaces.md).

## By-Reference Release Flow

A commit is validated exactly once — on its push-CI run, per-job green.
Everything downstream verifies *that run's* conclusions instead of re-executing
work. Local release tooling never re-runs gates; it prepares, commits, and tags.

1. **Land the release commit on `main`.** Push-CI (`ci.yml`) builds the
   workspace once, uploads the `workspace-build-output` artifact, and runs every
   gate. The matrix legs and the eval gate restore that one artifact rather than
   rebuilding — build once, restore everywhere.
2. **Cut locally.** With CI green, run the local release cut (bump every
   workspace `package.json`, refresh generated version surfaces, prepend the
   `CHANGELOG.md` section, commit, and create the annotated tag). This step runs
   **no gates** — validation already happened in step 1. See *Release Commands*.
3. **Push the tag.** `release.yml` runs:
   - `verify-tag-version` — the tag equals `packages/sdk` version.
   - `release-verify` — the reusable `reusable-release-verify.yml` confirms the
     tagged commit's push-CI run concluded with **every job green** (the
     toolchain `per-job-green` tool, with a 503-resilient check-suites
     fallback). This replaces the former 45-minute `validate-release` re-run.
   - `publish-npm` — restores the **CI build artifact for the recorded run id**,
     asserts the run's head SHA equals the tagged SHA (the artifact-integrity
     handoff), verifies the registry is empty-or-complete, publishes with
     provenance from the `production` environment, and polls propagation.
   - `github-release` — SBOM asset plus the tag's `CHANGELOG.md` excerpt.

Because tagging is gated on push-CI green, the tag-redo dance is structurally
retired. The SDK release wall drops from ~45–70m to ~15–20m, dominated by the
publish itself.

## Validation Scope

Release validation covers:

- package build output
- TypeScript type checks
- unit and integration tests
- generated API reference docs
- generated contract artifacts
- changelog/version alignment
- bundle budgets
- SBOM generation

Contributors should run the focused check that matches their change before
opening a pull request. Maintainers run the full release gate before cutting a
release.

## Release Commands

Each release step has a dedicated script in the root `package.json`:

| Command | Purpose |
|---------|---------|
| `bun run release:dry-run` | Dry-run publish — runs `scripts/publish-packages.ts --dry-run` without publishing anything |
| `bun run release:publish` | Publishes all workspace packages to npm (`scripts/publish-packages.ts`) |
| `bun run release:publish:ci` | Publishes from CI with npm provenance attestations (`--provenance`) |
| `bun run release:tag` | Creates the git release tag (`scripts/create-release-tag.ts`) |
| `bun run release:verify` | Full local release gate: `validate`, `security:audit`, the `test`/`test:rn`/`test:workers`/`test:workers:wrangler` suites, `release:dry-run`, and `install:smoke` |
| `bun run release:verify:published` | Verifies already-published packages and runs a registry install smoke check (`--registry`) |
| `bun run release:verify:verdaccio` | End-to-end publish/install dry-run against a local Verdaccio registry (`scripts/verdaccio-dry-run.ts`) |

Before opening a PR, run the focused check that matches the change rather than the full gate:

| Change type | Focused check |
|-------------|---------------|
| Public API / type surface | `bun run api:check` (and `bun run types:check`) |
| Contract schemas, method catalogs, or events | `bun run refresh:contracts` then `bun run contracts:check` |
| Generated reference docs | `bun run refresh:docs` (or `bun run docs:check`) |
| Error taxonomy (`SDKErrorKind`) | `bun run error:check` |
| Changelog / version bump | `bun run changelog:check` and `bun run version:check` |
| Bundle size | `bun run bundle:check` |
| Dependencies / licenses | `bun run sbom:check` and `bun run security:audit` |
| Packaging / `exports` map | `bun run publint:check` and `bun run types:resolution-check` |

## Shared Toolchain (`@pellux/goodvibes-toolchain`)

The release, publish, and verification scripts shared across the GoodVibes repos
live in one published workspace package, `@pellux/goodvibes-toolchain`. Each tool
is a policy function with injectable I/O plus a thin CLI (`bin`) entry. Repos
keep only their repo-specific values in a `toolchain.config.json` at the repo
root; the behavior lives in the package.

Tools: `sdk-pin-gate`, `build-binaries`, `release-cut`, `coverage-gate`,
`verification-ledger`, `post-build-smoke`, `package-install-check`,
`publish-package`, `per-job-green`, `changelog-gate`, `sha256sums`.

### `toolchain.config.json` contract

All sections are optional — a repo declares only the tools it uses. Import the
`ToolchainConfig` type from the package for editor help.

| Field | Purpose |
|-------|---------|
| `packageName` (required) | The repo's primary npm package name. |
| `sdkPin` | `{ sdkPackage, pinSource: "dependencies"｜"devDependencies", lockfile, overlayMarker, sourceRoots[], enforceExportsMap }` — parameterizes the SDK-pin tri-agreement. The agent bundles the SDK as a `devDependencies` pin; webui sets `enforceExportsMap: true`. |
| `build` | `{ appEntrypoint, daemonEntrypoint?, outDir, addonOutDir, targets[], prebuild[][] }`. A target carries `{ key, bunTarget, appArtifact, daemonArtifact?, nativeAddonPackage?, nativeAddonFile? }`. Presence of `daemonEntrypoint` + a target's `daemonArtifact` builds the daemon leg. |
| `coverage` | `{ funcsFloor, linesFloor, command[] }` — the aggregate-coverage ratchet. |
| `smoke` | `{ bannerPrefix, forbiddenStrings[], binaryDefault }` — post-build binary smoke. |
| `releaseCut` | `{ branch, versionFiles[], syncCommands[][], commitPaths[], changelogHeading: "bracket"｜"plain", changelogInsertMarker: "first-separator"｜"top" }`. |
| `publish` | `{ packageName, defaultRegistry, requiredTarballPaths[], forbiddenTarballPrefixes[], maxTarballBytes }`. |
| `perJobGreen` | `{ owner, repo, workflow, event, pollIntervalMs, deadlineMs }` (the CLI also accepts `--repo/--sha/--workflow` and `GITHUB_REPOSITORY`/`GITHUB_SHA`). |

### Reusable workflows

Hosted in this repo's `.github/workflows` and consumed cross-repo via
`uses: mgd34msu/goodvibes-sdk/.github/workflows/<name>.yml@main`:
`reusable-release-verify.yml` (by-reference per-job-green, emits `run_id` +
`head_sha`), `reusable-npm-publish.yml` (provenance + propagation poll),
`reusable-gh-release.yml` (release body from an optional `notes-file` override —
`{version}` expands to the un-prefixed tag; when the file exists at the
checked-out ref its prose is the body, e.g. the TUI's `docs/releases/<version>.md`,
otherwise the CHANGELOG excerpt — plus `SHA256SUMS`), and
`reusable-binary-matrix.yml` (build-binaries + post-build-smoke). The composite
`./.github/actions/setup` action is the single Bun setup (one `bun-version`
source, frozen-lockfile + cache always on).

## Changelog

Every release has a matching `CHANGELOG.md` section:

```md
## [X.Y.Z] - YYYY-MM-DD

### Breaking
### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security
### Migration
```

This block is illustrative, not a closed list. The full [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
section set (`### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`) is
permitted, plus the project-specific `### Breaking` and `### Migration` sections. Only include sections that
apply. The changelog is the canonical release narrative for users and downstream maintainers.

## Generated References

The generated docs are:

- `docs/reference-operator.md`
- `docs/reference-peer.md`
- `docs/reference-runtime-events.md`

These files are derived from source contracts and must not be edited by hand
except as part of the documented generation workflow.

## Contract Artifacts

The SDK package embeds generated contract JSON artifacts for public contract
subpaths. Contract artifacts must be refreshed when method catalogs, schemas,
events, or generated client types change.

## SBOM

The CycloneDX SBOM is a release artifact used for review and release upload. It
is not committed and is not included in the SDK npm package payload.

## Failure Handling

If a release gate fails:

1. Fix the source of truth.
2. Regenerate derived files when needed.
3. Rerun the focused failing check.
4. Rerun the release gate before cutting a release.

Common release-gate failures and their fixes:

- **Contract drift** — `contracts:check` fails when SDK-embedded contract JSON diverges from `packages/contracts/artifacts`. Run `bun run refresh:contracts`, then re-validate.
- **Bundle overage** — `bundle:check` fails when a JavaScript export exceeds its gzip ceiling. If the growth is legitimate, update `bundle-budgets.json` using `max(ceil(actual * 1.2), actual + 50)` and record the new measurement.
- **SBOM / license policy** — `sbom:check` fails when `sbom.cdx.json` is empty or schema-invalid, or when a dependency carries a blocked license family. Resolve the dependency or update the license policy.
- **Types resolution (attw)** — `types:resolution-check` fails when the `exports` map does not resolve cleanly for a published subpath. Fix the `exports`/types wiring in `packages/sdk/package.json`.
