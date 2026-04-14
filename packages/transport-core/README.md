# @pellux/goodvibes-transport-core

Internal workspace package backing `@pellux/goodvibes-sdk/transport-core`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

Use this surface only when you are composing your own transport/client abstraction.

Exports include:
- event envelope helpers
- runtime event feed primitives
- generic client transport helpers

Most consumers should use `@pellux/goodvibes-sdk`, `@pellux/goodvibes-sdk/operator`, or `@pellux/goodvibes-sdk/peer` instead.
