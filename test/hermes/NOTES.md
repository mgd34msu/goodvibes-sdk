# Hermes Runtime Notes

This note documents the current status of the manual Hermes runtime probe in
`test/hermes`. The probe remains useful for local React Native engine checks, but
public standalone Hermes CLI binaries do not represent the supported runtime
closely enough to gate CI.

## Current Standalone CLI Limits

The public `github.com/facebook/hermes/releases` CLI and the `hermes-engine`
package are older than the Hermes engine embedded in current React Native
releases. They can reject source-mode `async` functions, class inheritance, or
private-field syntax even when the bundled code is valid for a modern React
Native Hermes runtime.

## Probe Expectations

The bundled runner checks:

- React Native and Expo SDK entry creation.
- SDK error class behavior.
- selected engine APIs such as `Object.hasOwn`, `Array.prototype.at`,
  `structuredClone`, `WeakRef`, and `Error.cause`.
- absence of Node/Bun runtime dependencies in the Hermes bundle.

A standalone CLI syntax failure is actionable only when it also reproduces under
the supported React Native runtime. Otherwise it should be treated as a probe
runtime limitation, not an SDK failure.

## CI Policy

Keep Hermes execution manual until CI has a modern Hermes binary that matches the
supported React Native runtime. Required CI should continue to rely on the React
Native and browser/workers bundle checks that run against maintained runtime
targets.
