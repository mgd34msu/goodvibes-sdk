# Migration Guide

Since 0.19.0, per-release migration guidance lives directly in `CHANGELOG.md` under each version's `### Migration` subsection. This is the canonical source; consumers upgrading from any 0.18.x version should read the relevant `## [0.19.x]` entries in order.

## Upgrading from 0.18.x to 0.19.x

0.19.x introduced several breaking changes. In order:

- **0.19.0** — `_internal/platform/*` paths closed; consumers must import via `./platform/*` public barrels. `./react-native`, `./browser`, `./web`, `./expo` entry points are companion-safe. See [Runtime Surfaces](./surfaces.md).
- **0.19.3** — Error types are now typed `GoodVibesSdkError` with an `SDKErrorKind` discriminant. See [Error kinds](./error-kinds.md). Raw `throw new Error` in consumer-reachable SDK source is now gated by the CI `throw-guard`.
- **0.19.5** — `SDKObserver` interface introduced. Opt-in; no consumer action needed for existing code. See [Observability](./observability.md).
- **0.19.6** — `./node` and `./oauth` exports entries removed; `engines.node` replaced with `engines.bun`. `createNodeGoodVibesSdk` / `NodeGoodVibesSdkOptions` removed from root. Migrate to `createGoodVibesSdk` or the runtime-specific factory (`createReactNativeGoodVibesSdk`, `createBrowserGoodVibesSdk`). OAuth flows should now be handled server-side.

For each release's full migration text, run:

```bash
git log --grep "^release: SDK 0.19" -p CHANGELOG.md
```

or open `CHANGELOG.md` directly and find the `## [X.Y.Z]` section of interest.

## Archive

Pre-0.19 per-release detail is in `docs/archive/releases/0.18.x/`. This directory is historical reference only — treat `CHANGELOG.md` as the current source.
