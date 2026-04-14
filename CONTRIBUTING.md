# Contributing

`goodvibes-sdk` is a published TypeScript SDK workspace, but the product/source of truth still lives in `goodvibes-tui`.

That means contribution rules are slightly stricter than a normal standalone SDK repo.

## Source-First Rule

If a change affects any shared platform seam, do it in `goodvibes-tui` first, then sync it into this repo.

That includes:
- contract artifacts
- generated ids and typed request/response maps
- daemon route seams
- transport seams
- shared structured error seams
- shared auth/session/realtime protocol behavior

Do **not** fix a shared platform problem only in `goodvibes-sdk` and leave `goodvibes-tui` behind.

## SDK-Only Changes

These are safe to implement directly in this repo:
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

Sync from `goodvibes-tui`:

```bash
bun run sync
```

Portable SDK validation:

```bash
bun run validate
```

Source-sync validation against `goodvibes-tui`:

```bash
bun run validate:source
```

`validate:source` requires either:
- `GOODVIBES_TUI_ROOT=/path/to/goodvibes-tui`
- or a sibling checkout at `../goodvibes-tui`

## Pull Request Standard

Before opening or merging changes:
- keep synced surfaces in sync
- update docs/examples when public behavior changes
- keep package README files accurate
- run `bun run validate`
- run `bun run validate:source` when shared source-first seams changed

If the change required a source-first adjustment in `goodvibes-tui`, link or describe that source change clearly.
