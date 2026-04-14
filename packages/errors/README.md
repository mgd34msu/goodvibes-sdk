# @pellux/goodvibes-errors

Internal workspace package backing `@pellux/goodvibes-sdk/errors`.

Consumers should install `@pellux/goodvibes-sdk` and import this surface from the umbrella package.

Consumer import:

```ts
import { HttpStatusError } from '@pellux/goodvibes-sdk/errors';
```

Use this package when you need to branch on:
- HTTP status
- error category
- error source
- recovery hints
- request ids
- retry timing

Example:

```ts
import { HttpStatusError } from '@pellux/goodvibes-sdk/errors';

try {
  // integration code
} catch (error) {
  if (error instanceof HttpStatusError && error.status === 401) {
    // re-authenticate
  }
}
```

The exported fields are intended to replace fragile message parsing in client and daemon integrations.
