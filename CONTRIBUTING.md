# Contributing

> **Runtime**: This SDK is developed with Bun 1.3.10 (exact). Node is not a supported runtime — all scripts, tests, and CI run under Bun. Install the pinned version: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10"`.

`goodvibes-sdk` is a standalone TypeScript SDK workspace.

## SDK-Only Changes

Implement changes directly in this repo:
- platform/runtime internals that are part of the SDK
- package composition
- publish automation
- package metadata
- package-level README files
- consumer-facing docs
- examples
- validation scripts that check the extracted surfaces

## Local Workflow

Install:

```bash
bun install
```

Refresh generated contract artifacts:

```bash
bun run refresh:contracts
```

Portable SDK validation:

```bash
bun run validate
```

## CI Gates

The current CI suite runs these gates on every PR:

| Gate | Command | Notes |
|------|---------|-------|
| `validate` | `bun run validate` | Docs, examples, TypeScript, runtime environment, metadata, package, and install-smoke checks |
| `contract-artifact-check` | `bun run contracts:check` | Fails if generated contract artifacts drift from the canonical contracts package |
| `changelog-check` | `bun run changelog:check` | Fails if the version bump lacks a matching `## [X.Y.Z]` section in `CHANGELOG.md` |
| `error-contract-check` | `bun run error:check` | Fails if the public error taxonomy, retry contract, or consumer docs drift |
| `todo-check` | `bun run todo:check` | Fails if public source contains TODO/FIXME/XXX/HACK/STUB markers |
| `platform-matrix` | `bun run test`, `bun run test:rn`, `bun run test:workers`, `bun run test:workers:wrangler` | Exercises Bun, React Native bundle, Workers, and Wrangler surfaces |
| `examples-typecheck` | `bun --cwd examples run typecheck` | Keeps quickstarts aligned with the public SDK signatures |
| `version-consistency` | `bun run version:check` | Verifies version field consistency across workspace packages |
| `api-surface-check` | `bun run api:check` | Verifies the API Extractor snapshot matches the committed public surface baseline |
| `types-resolution-check` | `attw --pack packages/sdk` | Verifies exported types resolve from the package surface |
| `publint-check` | `bun run publint:check` | Verifies package metadata and published entry points |
| `bundle-budget-check` | `bun run bundle:check` | Verifies every JavaScript export has an explicit gzip budget and stays within it |
| `sbom-check` | `bun run sbom:generate` | Generates and validates the CycloneDX SBOM and blocks disallowed license families |

See [`docs/release-and-publishing.md`](docs/release-and-publishing.md) for authoritative release-gate procedures and the publish checklist.

## Pull Request Standard

Before opening or merging changes:
- update docs/examples when public behavior changes
- keep package README files accurate
- keep the umbrella package self-contained
- run `bun run validate`

## Conduct and Sign-off

Contributors are expected to keep technical discussion focused on the work,
respect project maintainers and users, and avoid personal attacks. Commits must
be authored by the person submitting the change. Add a `Signed-off-by:` trailer
when a downstream project or employer requires DCO-style tracking; the SDK does
not reject unsigned commits by default.
