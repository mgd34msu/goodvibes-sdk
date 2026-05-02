# Release And Publishing

This document describes the current release process for the GoodVibes SDK
workspace. Historical release narratives live in `CHANGELOG.md`.

## Release Rules

- Do not publish from a dirty worktree.
- Do not publish unless package versions are aligned.
- Do not publish unless `CHANGELOG.md` has an entry for the package version.
- Do not publish unless generated contracts/docs are in sync.
- Do not publish unless validation passes.
- Do not push or publish when the operator has explicitly said to hold.

The SDK targets Bun for the full surface and browser/Hermes/Workers for the
companion surface. Node.js is not a supported runtime target; see
[Runtime surfaces](./surfaces.md).

## Local Validation

Run the strict local gate before tagging or publishing:

```bash
bun install
bun run validate
bun run test
```

Useful focused checks:

```bash
bun run build
bun run types:check
bun run docs:generate
bun run docs:check
bun run refresh:contracts:check
bun run sync:check
bun run changelog:check
```

## Version Alignment

The root `package.json` and every `packages/*/package.json` must have the same
version. The version sync test enforces this:

```bash
bun run version:check
```

The generated contract artifacts also carry the package version. Refresh
contracts after changing method catalogs, schemas, events, or generated client
types:

```bash
bun run refresh:contracts
bun run sync:internal --scope=daemon,contracts
```

## Changelog Gate

Every release must have a matching section in `CHANGELOG.md`:

```md
## [X.Y.Z] - YYYY-MM-DD

### Breaking
### Added
### Changed
### Fixed
### Security
```

Only include sections that apply. The changelog is the canonical release
narrative and the machine-checked publish gate.

Check it with:

```bash
bun run changelog:check
```

## Generated References

The generated docs are:

- `docs/reference-operator.md`
- `docs/reference-peer.md`
- `docs/reference-runtime-events.md`

Regenerate them with:

```bash
bun run docs:generate
```

Check them without writing:

```bash
bun run docs:check
```

## Sync Guard

The SDK package mirrors selected files from workspace packages under
`packages/sdk/src/_internal/`. Update the package source first, then run:

```bash
bun run sync:internal
bun run sync:check
```

Use scoped sync when the change is intentionally narrow:

```bash
bun run sync:internal --scope=daemon,contracts
```

## Publishing

Publishing is handled by the repo scripts and CI workflow. The normal sequence:

```bash
bun run validate
bun run test
git status --short
git tag vX.Y.Z
git push origin main --tags
```

CI must pass before npm publishing. The publish workflow stages package
manifests before packing so the umbrella package publishes as a self-contained
SDK artifact.

## GitHub Release

The release tag should match the package version exactly:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The GitHub release should use the matching `CHANGELOG.md` section as release
notes and attach generated artifacts when the workflow produces them.

## npm Provenance

The npm publish path should use provenance when available in CI. Local manual
publishing should be reserved for recovery situations and should still run the
same validation, changelog, version, docs, contract, and sync gates.

## SBOM

Generate and validate the CycloneDX SBOM before release:

```bash
bun run sbom:generate
```

The SBOM is a release artifact. It is generated for review and CI/release upload,
but it is not committed or included in the SDK npm package payload.

## Failure Handling

If any release gate fails:

1. Fix the source of truth.
2. Regenerate derived files when needed.
3. Rerun the focused failing check.
4. Rerun `bun run validate`.
5. Do not tag or publish until the worktree is clean and CI is green.
