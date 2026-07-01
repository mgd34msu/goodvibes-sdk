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
