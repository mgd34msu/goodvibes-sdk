---
expected_min_constraints: 3
expected_max_constraints: 6
---

Build a simple key-value cache module in TypeScript with the following requirements:

- Must support TTL (time-to-live) per entry, in milliseconds
- Must support a maximum capacity; when full, evict the least-recently-used entry
- The cache must be type-safe using generics — no `any` types anywhere
- All public methods must have JSDoc comments
- Must export a named `createCache<K, V>` factory function (not a class)
- No external runtime dependencies
