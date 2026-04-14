# Release and Publishing

The SDK workspace has explicit release automation for local validation, GitHub Actions dry runs, and npm publishing.

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

The publish scripts stage package manifests before packing/publishing so internal `workspace:*` dependencies are replaced with the real SDK version in the published tarballs.

## Publishing

Local commands:

```bash
bun run release:dry-run
bun run release:publish
```

The publish flow:
- publishes packages in dependency order
- supports dry-run rehearsal
- skips already-published versions
- stages normalized publish manifests instead of publishing directly from workspace manifests
- uses npm provenance automatically when running in GitHub Actions

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
- tag pushes publish packages, verify the published versions in npm, then run registry install smoke checks
- the registry install smoke checks cover both `npm install` and `bun add`
- tag pushes also create a GitHub release from `CHANGELOG.md`

Repository setup required for publishing:
- GitHub Actions secret: `NPM_TOKEN`
- npm scope/package ownership for every `@pellux/goodvibes-*` package
- tags that match the package version, for example `v0.18.3`

Recommended first-release sequence:

```bash
bun run validate
bun run release:dry-run
git tag v0.18.3
git push origin v0.18.3
```

Then watch the `Release` workflow and verify that:
- the GitHub release is created
- all packages appear on npm at the tagged version
- `npm install @pellux/goodvibes-sdk@<version>` works
- `bun add @pellux/goodvibes-sdk@<version>` works

The workflow performs the npm/bun install smoke checks automatically after publish, but it is still worth confirming the user-facing install path once from a clean machine.

## Versioning Rule

The SDK currently tracks the GoodVibes product/foundation version directly. If shared platform behavior changes, version the source of truth first, then sync the SDK.
