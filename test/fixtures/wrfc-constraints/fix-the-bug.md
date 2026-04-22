---
expected_min_constraints: 0
expected_max_constraints: 0
---

There's a bug in `src/utils/parse.ts` where `parseDate` returns `null` for valid ISO 8601 strings that include a timezone offset (e.g. `2024-01-15T10:30:00+05:30`). Fix it.
