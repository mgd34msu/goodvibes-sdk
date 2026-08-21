# Release policy

This document describes the public release quality policy for the GoodVibes SDK
workspace. Historical release narratives live in `CHANGELOG.md`.

## Platform support

Release validation is supported on macOS and Linux. Windows users should use a
Linux CI runner or WSL2 for release validation because the validation scripts
use POSIX process management and filesystem behavior.

## Release rules

- Package versions must be aligned across the workspace.
- `CHANGELOG.md` must contain the release narrative for the package version.
- Generated contracts and generated docs must match source.
- Validation must pass before a release is cut.
- The automatic release path only fires once the `RELEASE_ARMED` repository
  variable is deliberately set to `true`; leaving it unset holds every green
  push on `main` without tagging or publishing.

The SDK targets Bun for daemon/platform surfaces and browser, Hermes, and
Workers for companion-safe surfaces. Node.js is not a documented consumer
runtime target; see [Runtime surfaces](./surfaces.md).

## By-reference release flow

A commit is validated exactly once, on its push-CI run, per-job green.
Everything downstream verifies *that run's* conclusions instead of re-executing
work. Two paths reach a published release: an automatic zero-touch path gated
on the repository variable `RELEASE_ARMED`, and a manual path for everything
else, including holding a release back or redoing a failed dispatch.

### Landing on `main`

Every push to `main` runs the full `ci.yml` gate set once: the consolidated
`validate` job, the eval gate, the security audit, the platform test matrix
(`bun`, React Native bundling, Workers, Workers with Wrangler), the
packaged-artifact conformance lane, and the packaging checks (`publint`, SBOM
generation, exports-map resolution). A single `build` job produces the
workspace `dist` output once and uploads it as the `workspace-build-output`
artifact; every other job restores that artifact rather than rebuilding, so
every gate tests the exact bytes a release would publish.

### Automatic path (`RELEASE_ARMED`)

An `auto-release` job runs after every gating job above succeeds, but only for
a push to `main`, and only when the `RELEASE_ARMED` repository variable is
`true`. Unset, or any other value, means CI finishes green without tagging or
publishing, which is how work can accumulate across several merges before
someone deliberately arms the next release.

When armed and green, the job reads the version out of the root
`package.json`, creates the annotated tag `v<version>` at that commit, and
pushes it. A tag pushed with the workflow's own token does not trigger
`release.yml`, since GitHub does not fire workflow events for token-authored
pushes, so the job also dispatches `release.yml` directly at that tag ref with
`mode=release`.

If the tag already exists, from a re-run of this job or a tag pushed by hand,
the job checks whether `release.yml` has ever run for it. A run in any state,
including a failed one, is left alone, since re-running a failed release is a
human decision. A tag with genuinely no run gets re-dispatched.

### Manual path

When `RELEASE_ARMED` is not set, or to redo a specific tag, cut and push the
tag by hand. Bump the workspace package versions, prepend the `CHANGELOG.md`
section, run `bun run sync:version` to refresh the generated version fallback,
commit, then run `bun run release:tag --push` (or tag locally and `git push
origin <tag>` separately). This step runs **no gates**; validation already
happened on the push-CI run for that commit. A pushed `v*` tag triggers
`release.yml` directly through its own tag-push trigger, the same workflow the
automatic path dispatches.

A `workflow_dispatch` run of `release.yml` with `mode=release` re-runs the
publish steps for an already-tagged commit, the redo path the automatic job
prints when it cannot resolve whether a release run exists. `mode=dry-run`,
the default for a manual dispatch, only packs and previews; it never
publishes and it is the only mode a manual dispatch outside `mode=release` can
run.

### What `release.yml` does, either way

1. `verify-tag-version` confirms the tag equals `packages/sdk`'s version.
2. `release-verify` (the reusable `reusable-release-verify.yml`, run in
   `workspace` mode so the SDK verifies itself with its own toolchain rather
   than a published one) confirms the tagged commit's push-CI run concluded
   with **every job green**, using the toolchain `per-job-green` tool with a
   check-suites fallback. It reports the resolved run id and head SHA. This
   replaces the former 45-minute `validate-release` re-run.
3. `generate-sbom` builds the CycloneDX SBOM for the release assets.
4. `publish-npm` requires all three jobs above to be green. It asserts the
   recorded head SHA equals the tagged SHA (the artifact-integrity handoff),
   then downloads the push-CI run's build artifact by that run id instead of
   rebuilding. It checks the registry state for this version, proceeding on
   empty, complete, or a resumable partial, and refuses only when an
   already-published package records a different commit than the one being
   released. It publishes with provenance from the `production` environment,
   polls propagation, and aligns the `latest` dist-tag across every published
   package with `scripts/align-dist-tags.ts`, needed because a plain `npm
   publish` moves `latest` to whatever it just published, which two
   overlapping releases can leave pointing backward.
5. `github-release` creates the GitHub release from the tagged
   `CHANGELOG.md` excerpt plus the SBOM, once publish and SBOM generation both
   succeed.

Because tagging is gated on push-CI green either way, the tag-redo dance is
structurally retired. The SDK release wall drops from ~45-70m to ~15-20m,
dominated by the publish itself.

## Validation scope

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

## Release commands

Each release step has a dedicated script in the root `package.json`:

| Command | Purpose |
|---------|---------|
| `bun run release:dry-run` | Dry-run publish: runs `scripts/publish-packages.ts --dry-run` without publishing anything |
| `bun run release:publish` | Publishes all workspace packages to npm (`scripts/publish-packages.ts`) |
| `bun run release:publish:ci` | Publishes from CI with npm provenance attestations (`--provenance`) |
| `bun run release:tag` | Creates the git release tag (`scripts/create-release-tag.ts`) |
| `bun run release:verify` | Full local release gate: `validate`, `flags:graduation`, `security:audit`, the `test`/`test:rn`/`test:workers`/`test:workers:wrangler` suites, `release:dry-run`, and `install:smoke` |
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

## Shared toolchain (`@pellux/goodvibes-toolchain`)

The release, publish, and verification scripts shared across the GoodVibes repos
live in one published workspace package, `@pellux/goodvibes-toolchain`. Each tool
is a policy function with injectable I/O plus a thin CLI (`bin`) entry. Repos
keep only their repo-specific values in a `toolchain.config.json` at the repo
root; the behavior lives in the package.

Tools: `sdk-pin-gate`, `build-binaries`, `release-cut`, `coverage-gate`,
`verification-ledger`, `post-build-smoke`, `package-install-check`,
`publish-package`, `per-job-green`, `changelog-gate`, `sha256sums`, and
`train-status`. `train-status` is read-only: given a `train-manifest.json`
listing the family's repos, it reports each one's release-train cycle state
across their local checkouts without pushing, tagging, or installing
anything. It takes its own `--manifest` flag rather than reading
`toolchain.config.json`.

### `toolchain.config.json` contract

All sections are optional. A repo declares only the tools it uses. Import the
`ToolchainConfig` type from the package for editor help.

| Field | Purpose |
|-------|---------|
| `packageName` (required) | The repo's primary npm package name. |
| `sdkPin` | `{ sdkPackage, pinSource: "dependencies"｜"devDependencies", lockfile, overlayMarker, sourceRoots[], enforceExportsMap }`: parameterizes the SDK-pin tri-agreement. The agent bundles the SDK as a `devDependencies` pin; webui sets `enforceExportsMap: true`. |
| `build` | `{ appEntrypoint, daemonEntrypoint?, outDir, addonOutDir, targets[], prebuild[][] }`. A target carries `{ key, bunTarget, appArtifact, daemonArtifact?, nativeAddonPackage?, nativeAddonFile? }`. Presence of `daemonEntrypoint` + a target's `daemonArtifact` builds the daemon leg. |
| `coverage` | `{ funcsFloor, linesFloor, command[] }`: the aggregate coverage floor that only rises. |
| `smoke` | `{ bannerPrefix, forbiddenStrings[], binaryDefault }`: post-build binary smoke. |
| `releaseCut` | `{ branch, versionFiles[], syncCommands[][], commitPaths[], changelogHeading: "bracket"｜"plain", changelogInsertMarker: "first-separator"｜"top" }`. |
| `publish` | `{ packageName, defaultRegistry, requiredTarballPaths[], forbiddenTarballPrefixes[], maxTarballBytes }`. |
| `perJobGreen` | `{ owner, repo, workflow, event, pollIntervalMs, deadlineMs }` (the CLI also accepts `--repo/--sha/--workflow` and `GITHUB_REPOSITORY`/`GITHUB_SHA`). |

### Reusable workflows

Hosted in this repo's `.github/workflows` and consumed cross-repo via
`uses: mgd34msu/goodvibes-sdk/.github/workflows/<name>.yml@main`:

- `reusable-release-verify.yml`: by-reference per-job-green, emits `run_id` +
  `head_sha`.
- `reusable-npm-publish.yml`: provenance + propagation poll.
- `reusable-gh-release.yml`: release body from an optional `notes-file`
  override, `{version}` expands to the un-prefixed tag; when the file exists
  at the checked-out ref its prose is the body, e.g. the TUI's
  `docs/releases/<version>.md`, otherwise the CHANGELOG excerpt, plus
  `SHA256SUMS`.
- `reusable-binary-matrix.yml`: build-binaries + per-leg post-build-smoke:
  each smoke leg declares its own `binary` in the targets JSON, since matrix
  legs only build their own suffixed artifact. `smoke.binaryDefault` serves
  local CLI runs only.

The glob inputs (`assets-glob`, `artifact-glob`) accept spaces or newlines as
separators; the workflows normalize them to the newline-separated form their
sinks require. The composite `./.github/actions/setup` action is the single
Bun setup (one `bun-version` source, frozen-lockfile + cache always on).

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

## Generated references

The generated docs are:

- `docs/reference-operator.md`
- `docs/reference-peer.md`
- `docs/reference-runtime-events.md`

These files are derived from source contracts and must not be edited by hand
except as part of the documented generation workflow.

## Contract artifacts

The SDK package embeds generated contract JSON artifacts for public contract
subpaths. Contract artifacts must be refreshed when method catalogs, schemas,
events, or generated client types change.

## SBOM

The CycloneDX SBOM is a release artifact used for review and release upload. It
is not committed and is not included in the SDK npm package payload.

## Failure handling

If a release gate fails:

1. Fix the source of truth.
2. Regenerate derived files when needed.
3. Rerun the focused failing check.
4. Rerun the release gate before cutting a release.

Common release-gate failures and their fixes:

- **Contract drift.** `contracts:check` fails when SDK-embedded contract JSON diverges from `packages/contracts/artifacts`. Run `bun run refresh:contracts`, then re-validate.
- **Bundle overage.** `bundle:check` fails when a JavaScript export exceeds its gzip ceiling. If the growth is legitimate, update `bundle-budgets.json` using `max(ceil(actual * 1.2), actual + 50)` and record the new measurement.
- **SBOM and license policy.** `sbom:check` fails when `sbom.cdx.json` is empty or schema-invalid, or when a dependency carries a blocked license family. Resolve the dependency or update the license policy.
- **Types resolution (attw).** `types:resolution-check` fails when the `exports` map does not resolve cleanly for a published subpath. Fix the `exports`/types wiring in `packages/sdk/package.json`.
