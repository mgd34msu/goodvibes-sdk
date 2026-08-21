# Testing architecture

> Internal source map. For day-to-day validation commands see [Testing and Validation](./testing-and-validation.md).

Tests should protect architecture, not just implementation details.

Key expectations:

- source-of-truth packages and SDK facades resolve through public entrypoints
- client-safe surfaces do not import runtime-heavy dependencies
- base knowledge and Home Graph Ask stay behaviorally aligned for concrete
  subjects
- repair tasks are durable, observable, bounded, and retryable
- generated pages update from promoted graph facts and source links
- route harnesses avoid overlapping long Home Graph runs

## Nothing is allowed to skip

`bun run test-skip:check` (`scripts/no-skipped-tests.ts`) scans every test
file for `describe.skip`, `test.skip`, `it.skip`, `.skipIf`, `.skip.if`,
`.runIf`, and `.todo`, in any combination, and fails the build if it finds
one. This is not limited to plain `.skip`. `skipIf` is caught by the same
pattern and is banned exactly like the others. There is no environment- or
platform-conditional exemption.

Tests that only make sense when an optional local dependency is present (for
example, the live PTY and sandbox tests in `test/exec-interactive.test.ts`,
which need the `script(1)` binary) do not skip. They call a small guard
function at the top of the test body that checks availability, logs an
honest one-line reason to the console, and returns early when the dependency
is absent. The test still reports as passed, its log output says plainly
that the real assertion did not run, and the gate that forbids `.skip` has
nothing to catch. On hosts where the dependency is present (the project's own
dev machines and CI), the guard is a no-op and the test runs for real.

## Release validation

Release validation is broader than any single test run. `bun run validate`
(the `validate` job) covers documentation sync, contract and changelog
checks, the TypeScript build, type-level tests, API-surface and bundle-size
checks, package metadata, and packaging smoke tests, but it deliberately does
not execute the test suite itself. Test execution belongs to the
`platform-matrix` CI job, which builds once and then runs the Bun suite, the
React Native bundle scan, and the two Workers runtime lanes as separate matrix
legs against that same build. See
[Testing and Validation](./testing-and-validation.md) for the full command
and CI-gate reference.
