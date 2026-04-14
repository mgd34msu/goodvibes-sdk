# Testing and Validation

The SDK repo validates more than TypeScript build success.

## Main Command

```bash
bun run validate
```

## What It Checks

- contract sync
- transport seam sync
- error seam sync
- daemon seam sync
- generated API docs sync
- docs/examples completeness
- TypeScript build
- type-level usage checks
- browser/runtime-neutral compatibility
- package metadata quality
- SDK tests
- package packability

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
3. rerun `bun run validate`

That keeps the SDK aligned with the actual platform behavior.
