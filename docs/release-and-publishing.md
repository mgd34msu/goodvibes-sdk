# Release and Publishing

The SDK workspace has explicit release automation for local validation, GitHub Actions dry runs, and npm publishing.

Public npm surface:
- one published package: `@pellux/goodvibes-sdk`
- consumer-facing pieces are exposed through subpath exports such as `@pellux/goodvibes-sdk/operator`
- the other workspace packages are internal build units and are not published independently

Registry targets:
- primary public registry: `https://registry.npmjs.org` as `@pellux/goodvibes-sdk`
- GitHub Packages mirror: `https://npm.pkg.github.com` as `@mgd34msu/goodvibes-sdk`

The GitHub Packages mirror uses the GitHub repository owner namespace. If the repository moves under a different owner or org, update the GitHub package name override in the release workflow and docs.

## Local Release Checks

Run:

```bash
bun run validate
bun run release:verify
```

`validate` ensures:
- generated API docs are up to date
- docs/examples are complete
- TypeScript build passes
- type-level usage checks pass
- tests pass
- every package can be packed cleanly
- the staged tarballs can be installed into a clean npm consumer

`bun run sync` refreshes the umbrella package internals from the workspace source before validation or release when needed.

> **Runtime note**: The SDK targets Bun (full surface) and Hermes/browser (companion surface). Node.js is not a supported consumer runtime — `engines.node` and the `./node` exports entry were removed in 0.19.6. See `docs/surfaces.md`.

`release:verify` is the full pre-publish local rehearsal:
- `bun run validate`
- `bun run release:dry-run`
- `bun run install:smoke`

For local dry runs and local publishing, the scripts can use either:
- `NODE_AUTH_TOKEN`
- `NPM_TOKEN`

The publish scripts stage package manifests before packing/publishing so the umbrella package publishes as a self-contained flat SDK artifact.

## Publishing

Local commands:

```bash
bun run release:dry-run
bun run release:publish
```

The publish flow:
- publishes one package: `@pellux/goodvibes-sdk`
- supports dry-run rehearsal
- skips already-published versions
- stages normalized publish manifests instead of publishing directly from workspace manifests
- uses npm provenance automatically when running in GitHub Actions

To publish or verify against GitHub Packages locally:

```bash
GOODVIBES_PUBLIC_PACKAGE_NAME=@mgd34msu/goodvibes-sdk \
GOODVIBES_PUBLISH_REGISTRY=https://npm.pkg.github.com \
GITHUB_PACKAGES_TOKEN=<classic-pat-or-workflow-token> \
bun run release:dry-run
```

The same environment overrides work for:
- `bun run release:publish`
- `bun run release:verify:published`

## GitHub Workflow

The repo includes:
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

The release workflow can be triggered:
- manually with `workflow_dispatch`
- or by pushing a `v*` tag

Workflow behavior:
- `CI` runs `bun run validate`
- `Release` runs `bun run validate` again before any publish step
- manual dispatch defaults to dry-run mode
- tag pushes publish the umbrella SDK to npmjs and GitHub Packages, verify both, then run registry install smoke checks
- the registry install smoke checks cover both `npm install` and `bun add`
- tag pushes also create a GitHub release from `CHANGELOG.md`

Repository setup required for publishing:
- GitHub Actions secret: `NPM_TOKEN`
- GitHub Actions built-in `GITHUB_TOKEN` with `packages:write` for GitHub Packages
- npm scope/package ownership for `@pellux/goodvibes-sdk`
- GitHub Packages install/auth if using the mirror:
  - package name `@mgd34msu/goodvibes-sdk`
  - `.npmrc` line `@mgd34msu:registry=https://npm.pkg.github.com`
  - auth line `//npm.pkg.github.com/:_authToken=TOKEN`
- tags that match the package version, for example `v0.18.14`

Recommended first-release sequence:

```bash
bun run validate
bun run release:dry-run
git tag v0.18.14
git push origin v0.18.14
```

Then watch the `Release` workflow and verify that:
- the GitHub release is created
- `@pellux/goodvibes-sdk` appears on npm at the tagged version
- `@mgd34msu/goodvibes-sdk` appears on GitHub Packages at the tagged version
- `npm install @pellux/goodvibes-sdk@<version>` works
- `bun add @pellux/goodvibes-sdk@<version>` works
- `npm install @mgd34msu/goodvibes-sdk@<version>` works with the GitHub Packages `.npmrc` mapping

The workflow performs the npm/bun install smoke checks automatically after publish, but it is still worth confirming the user-facing install path once from a clean machine.

## Versioning Rule

Version the SDK according to SDK changes and published behavior.

## Changelog Gate

Every release of `@pellux/goodvibes-sdk` **must** have a `## [X.Y.Z]` section in `CHANGELOG.md` at the repo root. The publish script and CI enforce this as a hard blocking condition.

### Format

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions:

```markdown
## [0.19.0] - 2026-04-17

### Breaking
- ...

### Added
- ...

### Fixed
- ...

### Migration
- ...
```

All four sub-sections (`Breaking`, `Added`, `Fixed`, `Migration`) are required. Use `- none` under any section that has no content for the release.

### Check command

```bash
bun run changelog:check
```

This reads the version from `packages/sdk/package.json` and greps `CHANGELOG.md` for a matching `## [X.Y.Z]` header. Exit 0 when found; exit 1 with a descriptive error when missing.

The check runs automatically:
- In CI via the `changelog-check` job on every push/PR to `main`.
- In the publish script (`scripts/publish-packages.ts`) before any staging or npm publish call.

### Adding an entry

Before bumping the version and running `bun run release:publish`, add the CHANGELOG section:

1. Open `CHANGELOG.md`.
2. Add a new `## [NEW_VERSION] - YYYY-MM-DD` section at the top of the version list.
3. Fill in `Breaking`, `Added`, `Fixed`, `Migration`. Use `- none` for empty sections.
4. Run `bun run changelog:check` to confirm.

Long-form per-release notes remain in `docs/releases/<version>.md` — the CHANGELOG entry is the machine-verifiable summary.

## Version Consistency

All `package.json` files in the monorepo workspace must carry the same version. The single source of truth is the **root `package.json`** — the `version` field there is what `version-consistency-check.ts` validates against all `packages/*/package.json` files.

> `packages/sdk/package.json` drives the published artifact version (read by `publish-packages.ts` for the changelog gate), and must match the root. Both are bumped together.

When bumping versions, all of the following files must be updated to the same version in a single commit:
- `package.json` (root)
- `packages/contracts/package.json`
- `packages/daemon-sdk/package.json`
- `packages/errors/package.json`
- `packages/operator-sdk/package.json`
- `packages/peer-sdk/package.json`
- `packages/sdk/package.json`
- `packages/transport-core/package.json`
- `packages/transport-direct/package.json`
- `packages/transport-http/package.json`
- `packages/transport-realtime/package.json`

### Check command

```bash
bun run version:check
```

This reads the version from root `package.json` and checks every `packages/*/package.json` against it. Exit 0 when all match; exit 1 with a divergence report when any differ.

The check runs automatically in CI via the `version-consistency` job on every push/PR to `main`.

## CI Gates

| Job | Command | Purpose |
|-----|---------|----------|
| `validate` | `bun run validate` | Full workspace validation: docs, TypeScript build, type-level checks, tests, pack, install smoke |
| `mirror-drift` | `bun run sync:check` | Ensures transport-http mirror parity — catches body divergence between source and mirror |
| `platform-matrix` | `bun run build && bun test test` / `bun run test:rn` | Runs test suite on bun and rn-bundle platforms |
| `throw-guard` | inline rg scan | Prevents raw throws from shipping in public SDK source |
| `changelog-check` | `bun run changelog:check` | Blocks releases when CHANGELOG.md is missing a section for the current version |
| `version-consistency` | `bun run version:check` | Ensures all workspace package.json files carry the same version |
| `types-check` | `bun run types:check` | Compiles type-level usage tests to catch public API type regressions |

### Root cause of the 0.19.6 divergence

Prior per-wave bumps (0.19.3 through 0.19.6) touched only `packages/sdk/package.json`. The publish script reads the SDK version for the changelog gate but does not propagate it to sibling packages — each package publishes its own `manifest.version` from `stagePackages()`. With no CI gate in place, the divergence went undetected across multiple waves.

## Mirror Drift Guard

`packages/transport-http/src/**` is mirrored byte-for-byte into `packages/sdk/src/_internal/transport-http/**`. The sync script (`bun run sync`) applies two allowed transforms per file: a leading `// Synced from …` header comment, and import-path rewrites (package specifiers rewritten to relative paths, `.ts` → `.js` extensions).

The drift guard catches any body divergence beyond those two transforms:

```bash
bun run sync:check
```

This runs on every PR via the `mirror-drift` CI job in `.github/workflows/ci.yml`. A non-zero exit prints the drifted file(s) and the first diverging line.

If the check fails, regenerate the mirror and re-check:

```bash
bun run sync
bun run sync:check
```

### Optional pre-commit hook

To catch drift locally before push, add the following to `.git/hooks/pre-commit` (create it if absent, and make it executable with `chmod +x .git/hooks/pre-commit`):

```bash
#!/usr/bin/env bash
bun run sync:check
```

The hook is opt-in and not installed automatically. Omit it if you prefer to rely solely on the CI gate.
