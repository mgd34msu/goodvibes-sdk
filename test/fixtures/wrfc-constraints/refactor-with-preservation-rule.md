---
expected_min_constraints: 1
expected_max_constraints: 3
---

Refactor the `UserService` class in `src/services/user.ts` to use the repository pattern.

The public API surface of `UserService` must remain identical — all existing callers must continue to work without changes. Internal implementation may change freely.

Prefer dependency injection over direct instantiation of the repository.
