# @goodvibes/errors

Structured GoodVibes SDK error types.

Install:

```bash
npm install @goodvibes/errors
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
import { HttpStatusError } from '@goodvibes/errors';

try {
  // integration code
} catch (error) {
  if (error instanceof HttpStatusError && error.status === 401) {
    // re-authenticate
  }
}
```

The exported fields are intended to replace fragile message parsing in client and daemon integrations.
