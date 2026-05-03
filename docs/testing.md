# Testing Architecture

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
- browser-only tests may use `skipIf` for non-browser runtimes, but ordinary
  `describe.skip`, `test.skip`, and todos are forbidden

Release validation runs build, docs checks, type checks, examples typecheck,
metadata checks, package checks, install smoke, and the platform test matrix.
