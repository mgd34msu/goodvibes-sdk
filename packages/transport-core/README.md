# @pellux/goodvibes-transport-core

Public GoodVibes transport-core package for shared transport, event-feed, observer, and middleware primitives.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/transport-core`. Install this package directly when you only need the transport primitives.

Use this surface only when you are composing your own transport/client abstraction.

Exports include:
- event envelope helpers
- runtime event feed primitives
- generic client transport helpers

Most consumers should use `@pellux/goodvibes-sdk`, `@pellux/goodvibes-sdk/operator`, or `@pellux/goodvibes-sdk/peer` instead.
