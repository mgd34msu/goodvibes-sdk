# Testing architecture

> Internal source map. For commands, layers and what runs where see [Testing and Validation](./testing-and-validation.md).

Tests protect behavior, not text. Key expectations:

- source-of-truth packages and SDK facades resolve through public entrypoints
- client-safe surfaces do not import runtime-heavy dependencies
- base knowledge and Home Graph Ask stay behaviorally aligned for concrete
  subjects
- repair tasks are durable, observable, bounded, and retryable
- generated pages update from promoted graph facts and source links
- route harnesses avoid overlapping long Home Graph runs

## Where things live

- `test/*.test.ts`: unit and wire tests, run by `scripts/test.ts`.
- `test/integration/`: whole-composition tests (real daemon, real runtime
  services, real git).
- `test/toolchain/`: the `@pellux/goodvibes-toolchain` suites.
- `test/workers/`, `test/workers-wrangler/`, `test/rn-bundle-node-imports.test.ts`:
  runtime legs, run by the release gates.
- `test/types/`: consumer-vantage type tests, compiled by
  `tsconfig.type-tests.json`.
- `test/_helpers/`: shared fakes and harnesses (fake IMAP server, orchestration
  harness, temp registries).

## Optional host dependencies

A test that needs a binary the host may not have (the PTY and sandbox cases in
`test/exec-interactive.test.ts` need `script(1)`) checks for it at the top of
the test body, logs a one-line reason, and returns early. Where the dependency
exists, including CI, it runs for real.

## Clocks and timers

Tests do not depend on wall-clock speed. Code that reads time takes a `now`
seam, or the test pins time with bun's `setSystemTime` / fake timers
(`test/llm-instrumentation.test.ts`, `test/approvals-raise-verb.test.ts`).
