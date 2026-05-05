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

## Changelog

Every release has a matching `CHANGELOG.md` section:

```md
## [X.Y.Z] - YYYY-MM-DD

### Breaking
### Added
### Fixed
### Migration
```

Only include sections that apply. The changelog is the canonical release
narrative for users and downstream maintainers.

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
