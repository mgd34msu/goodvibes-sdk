# Contributing

> **Runtime**: This SDK is developed with Bun 1.0+. Node is not a supported runtime — all scripts, tests, and CI run under Bun.

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

Refresh the umbrella package internals:

```bash
bun run sync
```

Portable SDK validation:

```bash
bun run validate
```

## CI Gates

The following gates were added across 0.19.x releases and run on every PR:

| Gate | Added | Command | Notes |
|------|-------|---------|-------|
| `mirror-drift` | 0.19.0 | `bun run sync:check` | Fails if any `_internal` mirror is stale vs its canonical source |
| `changelog-check` | 0.19.1 | `bun run changelog:check` | Fails if the version bump lacks a matching `## [X.Y.Z]` section in `CHANGELOG.md` |
| `throw-guard` | 0.19.3 | inline in CI | Fails if any raw `throw new Error(` / `throw Error(` variant appears in public surface source |
| `platform-matrix (rn-bundle)` | 0.19.6 | `bun test test/rn-bundle-node-imports.test.ts` | Verifies no Node-only imports leak into the RN companion bundle |
| `version-consistency` | 0.19.6 | `bun run version:check` | Verifies version field is consistent across all workspace `package.json` files |

See [`docs/release-and-publishing.md`](docs/release-and-publishing.md) for authoritative release-gate procedures and the publish checklist.

## Pull Request Standard

Before opening or merging changes:
- update docs/examples when public behavior changes
- keep package README files accurate
- keep the umbrella package self-contained
- run `bun run validate`
