# @pellux/goodvibes-errors

Public GoodVibes error package for structured SDK, transport, and daemon failures.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/errors`. Install this package directly when you only need the shared error model.

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
