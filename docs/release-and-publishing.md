# Release and Publishing

The SDK workspace has explicit publish automation.

## Local Release Checks

Run:

```bash
bun run validate
bun run validate:source
bun run release:dry-run
```

`validate` ensures:
- generated API docs are up to date
- docs/examples are complete
- TypeScript build passes
- type-level usage checks pass
- tests pass
- every package can be packed cleanly

`validate:source` is the local source-sync check against `goodvibes-tui`. It is intended for contributors who are updating extracted seams, not for standalone CI environments.

## Publishing

The publish script is:

```bash
node scripts/publish-packages.mjs
```

It:
- publishes packages in dependency order
- supports `--dry-run`
- skips already-published versions
- uses `npm publish --access public --provenance`

## GitHub Workflow

The repo includes:
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

The release workflow can be triggered:
- manually with `workflow_dispatch`
- or by pushing a `v*` tag

## Versioning Rule

The SDK currently tracks the GoodVibes product/foundation version directly. If shared platform behavior changes, version the source of truth first, then sync the SDK.
