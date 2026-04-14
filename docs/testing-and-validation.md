# Testing and Validation

The SDK repo validates more than TypeScript build success.

## Portable Validation

```bash
bun run validate
```

This is the command CI runs. It does **not** require any external repo checkout.

## Portable Checks

- generated API docs sync
- docs/examples completeness
- TypeScript build
- type-level usage checks
- browser/runtime-neutral compatibility
- package metadata quality
- SDK tests
- package packability

## Internal Refresh

When you changed internal workspace source, refresh the umbrella package:

```bash
bun run sync
```

This rebuilds the umbrella package's internal source tree from the internal workspace packages used to assemble the published SDK.

## Why This Matters

Validation has to catch:
- internal packaging drift
- packaging drift
- broken docs/examples
- browser or mobile bundler regressions
- public API typing regressions

## Recommended Local Sequence

If you changed internal workspace source:
1. run `bun run sync`
2. run `bun run validate`
