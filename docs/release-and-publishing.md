# Release And Publishing

This document describes the current release process for the GoodVibes SDK
workspace. Historical release narratives live in `CHANGELOG.md`.

## Platform Support

The release tooling is supported on **macOS** and **Linux** only. Windows is
not supported: the release scripts rely on POSIX process management (`SIGTERM`,
`SIGKILL`), `mkdtemp`, Unix paths, and shell invocations that do not translate
to Windows. If you need to run the release pipeline on Windows, use WSL2 or a
Linux CI runner.

## Release Rules

- Do not publish from a dirty worktree.
- Do not publish unless package versions are aligned.
- Do not publish unless `CHANGELOG.md` has an entry for the package version.
- Do not publish unless generated contracts/docs are in sync.
- Do not publish unless validation passes.
- Do not push or publish when the operator has explicitly said to hold.

The SDK targets Bun **1.3.10** for the full surface and browser/Hermes/Workers for the
companion surface. Node.js is not a supported runtime target; see
[Runtime surfaces](./surfaces.md). (See also `CONTRIBUTING.md` for the pinned runtime requirement.)

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
bun run contracts:check
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
```

## Changelog Gate

Every release must have a matching section in `CHANGELOG.md`:

```md
## [X.Y.Z] - YYYY-MM-DD

### Breaking
### Added
### Fixed
### Migration
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

## Contract Artifact Check

The SDK package embeds generated contract JSON artifacts for published
contract subpaths. Update the contracts package artifacts first, then run:

```bash
bun run contracts:check
```

`contracts:check` verifies generated contract artifacts without writing.

## Publishing

Publishing is handled by the repo scripts and CI workflow. The normal sequence:

```bash
bun run validate
bun run test
git status --short
git tag vX.Y.Z
git push origin main --tags
```

CI must pass before npm publishing. The publish workflow stages every public
workspace package, resolves workspace ranges to the release version, and
publishes source-of-truth packages before the main SDK facade.

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
same validation, changelog, version, docs, and contract-artifact gates.

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
