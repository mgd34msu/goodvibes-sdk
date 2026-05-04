# Semver Policy

This document defines what constitutes a breaking change, a minor addition, or a patch fix for `@pellux/goodvibes-sdk` and its published sub-packages. It is the authoritative reference used when tagging releases and reviewing CHANGELOG entries.

Violations of this policy are a release gate failure — a version bump that misclassifies a breaking change as minor or patch must be corrected before publish.

---

## Major bump — breaking changes

The following changes require a major version bump:

- **Removing a public export** from any subpath export entry (e.g. removing `createGoodVibesSdk` from `@pellux/goodvibes-sdk` or any equivalent factory from a named subpath)
- **Changing a public export's type signature in a narrowing direction**: removing a property from a public interface or type, narrowing an accepted parameter type, making an optional field required, or removing a union member from a parameter type
- **Renaming or changing the value of an `SDKErrorKind` union member** (e.g. renaming `'auth'` to `'authentication'`, or `'not-found'` to `'notFound'`). The full current union is: `'auth' | 'config' | 'contract' | 'network' | 'not-found' | 'protocol' | 'rate-limit' | 'service' | 'internal' | 'tool' | 'validation' | 'unknown'` (12 values, verified against `packages/errors/src/index.ts:37-49`)
- **Renaming an SDK factory function** (e.g. renaming `createGoodVibesSdk`, `createBrowserGoodVibesSdk`, `createWebGoodVibesSdk`, `createReactNativeGoodVibesSdk`, `createExpoGoodVibesSdk`, `createPeerSdk`, or `createGoodVibesAuthClient`)
- **Changing the resolution target of a subpath export** in a way that breaks consumers (e.g. moving `./browser` to resolve to a different module without a redirect, or replacing `./web` with `./browser` in the exports map)
- **Changing wire-format or transport defaults** in a way that breaks existing consumers without opt-in (e.g. reducing the default HTTP timeout from 30 s to 5 s, changing default retry counts)
- **Removing a supported runtime from the runtime matrix** (currently: `bun`, `browser`, `react-native` / Hermes, `workers`). Note: `node` as a standalone target is not a documented supported runtime — the `engines.node` field in `packages/sdk/package.json` reflects the build/Bun host requirement, not a tested Node consumer surface. See `docs/packages.md` for the full surface split.
- **Adding a new required config field** to `GoodVibesSdkOptions` or any public options interface, or promoting an existing optional field to required

---

## Minor bump — additive, non-breaking changes

The following changes require a minor version bump:

- Adding a new public export to any subpath entry
- Adding a new optional field to a public options interface or type
- Adding a new `SDKErrorKind` union member value
- Adding a new subpath export entry (e.g. a new `./workers` entry)
- Widening a return type in a direction that does not remove or narrow existing members (e.g. adding a new property to a returned object type)
- Adding a new runtime to the supported runtime matrix
- Bumping the minimum supported TypeScript version — see [TypeScript support](#typescript-support)

---

## Patch bump — fixes and internal changes

The following changes are patch-level:

- Bug fixes that do not alter the public API surface
- Documentation corrections
- Internal refactors that do not affect the observable behavior of any public export
- Dependency version updates that do not affect the public API
- Performance improvements with no behavioral change

---

## What is NOT covered by semver

The following are explicitly out of scope and may change at any time without a major or minor bump:

- **Repository source file paths** — these are not part of the public surface and are subject to change without notice. Do not bypass the package export map.
- **`dist/` internal file paths** — consume the SDK via the package exports map (e.g. `@pellux/goodvibes-sdk`, `@pellux/goodvibes-sdk/browser`), not by importing from `dist/` file paths directly.
- **Error `.message` strings** — these are human-readable and may be improved across releases. Use `err.kind` (an `SDKErrorKind` value) and `err.code` for programmatic handling, not `err.message`.
- **`GoodVibesSdkError` subclass identity** — do not use `instanceof ConfigurationError`, `instanceof ContractError`, etc. for control flow; use `err.kind` instead. Subclass structure is internal.

---

## Removal process

For pre-1.0 releases, the project may remove or rename public exports when the
owner accepts the breaking change and `CHANGELOG.md` documents it. For 1.0 and
later releases, removals require a major bump and a replacement path when one
exists.

When a replacement exists, document the replacement in the changelog and the
affected feature doc.

Example:

```ts
/**
 * Use `createWebGoodVibesSdk` for browser/web clients.
 */
export function createBrowserGoodVibesSdk(/* ... */) { /* ... */ }
```

---

## TypeScript support

The minimum supported TypeScript version is **6.0**. This is the lowest version against which the SDK's type signatures are tested. The repository ships `typescript: ^6.0.3`; CI validates types against that range.

Bumping the minimum supported TypeScript version is treated as a **minor bump**, not a major bump. This follows common practice in the TypeScript ecosystem (see e.g. the DefinitelyTyped policy) — most consumers upgrade TypeScript frequently and a minimum TypeScript bump rarely requires application code changes.

If a TypeScript version bump requires consumers to change their application-level type annotations, that case will be assessed individually and may be treated as major.

---

## Enforcement

The CHANGELOG gate (`bun run changelog:check`) verifies that every release has a properly labeled section. Version bump classification is a required part of the PR description for any release PR. Misclassified bumps are caught in review before merge.

API surface checks and changelog review are the enforcement mechanisms for
unintended public-surface drift.
