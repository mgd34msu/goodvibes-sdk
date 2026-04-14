# Contributing

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

## Pull Request Standard

Before opening or merging changes:
- update docs/examples when public behavior changes
- keep package README files accurate
- keep the umbrella package self-contained
- run `bun run validate`
