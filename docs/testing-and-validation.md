# Testing and Validation

The SDK repo validates more than TypeScript build success.

## Portable Validation

```bash
bun run validate
```

This is the command CI runs. It does **not** require a local `goodvibes-tui` checkout.

## Portable Checks

- generated API docs sync
- docs/examples completeness
- TypeScript build
- type-level usage checks
- browser/runtime-neutral compatibility
- package metadata quality
- SDK tests
- package packability

## Source-Sync Validation

When you changed a shared seam in `goodvibes-tui`, also run:

```bash
bun run validate:source
```

This checks that the extracted SDK surfaces are still in sync with the source repo. It requires either:
- `GOODVIBES_TUI_ROOT=/path/to/goodvibes-tui`
- or a sibling checkout at `../goodvibes-tui`

## Why This Matters

The SDK is downstream of `goodvibes-tui`. Validation has to catch:
- source drift
- packaging drift
- broken docs/examples
- browser or mobile bundler regressions
- public API typing regressions

## Source-First Validation Rule

If a shared platform seam changes:
1. validate in `goodvibes-tui`
2. sync the seam into this repo
3. run `bun run validate:source`
4. rerun `bun run validate`

That keeps the SDK aligned with the actual platform behavior.
