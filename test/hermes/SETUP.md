# Hermes Runtime Probe

This directory contains a manual probe for the `@pellux/goodvibes-sdk/react-native`
and `@pellux/goodvibes-sdk/expo` bundles under Hermes. It is not part of the
normal CI matrix because the public standalone Hermes CLI releases lag the
Hermes engine embedded in current React Native releases.

## Files

- `hermes-runner.js`: synchronous runtime assertions bundled for Hermes.
- `bundle-for-hermes.ts`: builds `dist/hermes-test-bundle.js` with esbuild.
- `run-hermes-tests.sh`: runs the bundle with a Hermes CLI binary.
- `setup-hermes.sh`: downloads the latest public standalone CLI for local probes.
- `NOTES.md`: records the current standalone CLI limitations and the manual
  probe expectations.

## Manual Probe

```bash
bun run build
bun run test/hermes/bundle-for-hermes.ts
bash test/hermes/setup-hermes.sh
bash test/hermes/run-hermes-tests.sh --no-build
```

The public standalone CLI may reject modern JavaScript syntax that current
React Native Hermes supports. Treat that result as a CLI limitation unless the
same failure reproduces inside a supported React Native runtime.

## CI Policy

Do not add this probe to required CI unless the runner uses a Hermes binary that
matches the supported React Native runtime. The standard CI matrix already covers
React Native bundle-shape constraints with static bundle checks.
