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
bun run validate:source
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

`validate:source` is the local source-sync check against `goodvibes-tui`. It is intended for contributors who are updating extracted seams, not for standalone CI environments.

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
- tags that match the package version, for example `v0.18.6`

Recommended first-release sequence:

```bash
bun run validate
bun run release:dry-run
git tag v0.18.6
git push origin v0.18.6
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

The SDK currently tracks the GoodVibes product/foundation version directly. If shared platform behavior changes, version the source of truth first, then sync the SDK.
