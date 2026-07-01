# @pellux/goodvibes-errors

Public GoodVibes error package for structured SDK, transport, and daemon failures.

Most applications should install `@pellux/goodvibes-sdk` and import `@pellux/goodvibes-sdk/errors`. Install this package directly when you only need the shared error model.

## Install

```sh
npm install @pellux/goodvibes-errors
```

## The error model

Every error thrown from the SDK's public surface is a `GoodVibesSdkError`. The `kind` field is the primary discriminant — switch on it instead of `instanceof` chains or message parsing:

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

try {
  await callIntegration();
} catch (err) {
  if (err instanceof GoodVibesSdkError) {
    switch (err.kind) {
      case 'auth':       /* re-authenticate */ break;
      case 'rate-limit': await delay(err.retryAfterMs ?? 1000); break;
      case 'network':
      case 'service':    if (err.recoverable) { /* retry with backoff */ } break;
      default:           /* log and surface */ break;
    }
  } else {
    throw err;
  }
}
```

Concrete subclasses (`ConfigurationError`, `ContractError`, `HttpStatusError`) remain available for class-specific handling:

```ts
import { HttpStatusError } from '@pellux/goodvibes-errors';

try {
  // integration code
} catch (error) {
  if (error instanceof HttpStatusError && error.status === 401) {
    // re-authenticate
  }
}
```

The same symbols are re-exported from the SDK facade, so SDK consumers can import them from `@pellux/goodvibes-sdk/errors` instead:

```ts
import { HttpStatusError } from '@pellux/goodvibes-sdk/errors';
```

## Branch on structured fields

Use the structured fields instead of fragile message parsing:

- HTTP status (`status`)
- error category (`category`) and source (`source`)
- recovery hints (`recoverable`, `hint`, `retryAfterMs`)
- request correlation (`requestId`)
- typed code (`code`) — match it with `isErrorCode(err, SDKErrorCodes.RATE_LIMITED)`

## Daemon wire contract

The `./daemon-error-contract` subpath exports the daemon-side wire types, independent of the runtime error classes:

```ts
import {
  DaemonErrorCategory,
  type DaemonErrorSource,
  type StructuredDaemonErrorBody,
} from '@pellux/goodvibes-errors/daemon-error-contract';
```

`DaemonErrorCategory` is both a string-literal union and a runtime const; `StructuredDaemonErrorBody` is the JSON shape the daemon returns in HTTP error responses.

The exported fields are intended to replace fragile message parsing in client and daemon integrations.

## Documentation

- [SDK Error Kinds](../../docs/error-kinds.md) — per-kind consumer reference
- [Error Handling](../../docs/error-handling.md) — handling patterns
- [Error Architecture](../../docs/errors.md) — internal source map
