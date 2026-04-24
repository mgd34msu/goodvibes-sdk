# Vendored uuid CJS Shim

This package exists only for the repo's Verdaccio dry-run tooling.

Current stable Verdaccio depends on `@cypress/request@3.0.10`, which depends on
`uuid@^8.3.2`. That keeps `uuid` below the `14.0.0` advisory fix for
`GHSA-w5hq-g745-h8pq` in the dependency graph. `@cypress/request` only uses
`uuid.v4`, so this checked-in shim provides that CommonJS `v4` surface using
Node's crypto APIs and a bounds check for caller-provided output buffers.

Do not expand this package into a general-purpose `uuid` replacement. Remove it
when Verdaccio no longer pulls the legacy `@cypress/request` path.
