# Error Handling

All public client packages normalize transport failures into structured SDK errors.

## Typed error discrimination

Consumers should switch on `err.kind` rather than `instanceof` chains or message parsing. Every error thrown from the public API surface is a `GoodVibesSdkError` with a stable `kind` discriminant.

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.accounts.snapshot();
} catch (err) {
  if (!(err instanceof GoodVibesSdkError)) throw err;

  switch (err.kind) {
    case 'auth':
      // Redirect to login or surface auth UI
      break;
    case 'rate-limit':
      // Wait retryAfterMs then retry
      await delay(err.retryAfterMs ?? 1000);
      break;
    case 'network':
    case 'server':
      if (err.recoverable) {
        // Retry with backoff
      }
      break;
    case 'config':
      // Fix SDK initialization options — do not retry
      break;
    case 'contract':
    case 'validation':
    case 'not-found':
    case 'unknown':
      // Log and surface to the user
      break;
  }
}
```

See [error-kinds.md](./error-kinds.md) for the full reference on each kind.

## TUI / consumer example

```ts
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk/errors';

async function safeSnapshot(sdk: OperatorSdk): Promise<ControlSnapshot | null> {
  try {
    return await sdk.operator.control.snapshot();
  } catch (err) {
    if (!(err instanceof GoodVibesSdkError)) throw err;
    if (err.kind === 'auth') {
      // surface login prompt in TUI
      return null;
    }
    if (err.kind === 'network' && err.recoverable) {
      // schedule reconnect
      return null;
    }
    throw err;
  }
}
```

## Legacy instanceof pattern (deprecated)

The `HttpStatusError`, `ConfigurationError`, and `ContractError` subclasses are preserved for backward compatibility. Prefer `err.kind` in new code.

```ts
import { HttpStatusError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.accounts.snapshot();
} catch (error) {
  if (error instanceof HttpStatusError) {
    console.error(error.status, error.category, error.hint);
  }
}
```

## Useful fields

- `status`
- `category`
- `source`
- `hint`
- `provider`
- `operation`
- `phase`
- `requestId`
- `retryAfterMs`

Do not parse `message` strings when the structured fields are available.

## Core error classes

- `GoodVibesSdkError`
- `ConfigurationError`
- `ContractError`
- `HttpStatusError`

## Typical handling pattern

```ts
import { HttpStatusError } from '@pellux/goodvibes-sdk/errors';

try {
  await sdk.operator.control.snapshot();
} catch (error) {
  if (error instanceof HttpStatusError && error.status === 401) {
    // redirect to login, refresh token, or surface auth UI
  }
  throw error;
}
```

## Category guidance

- `authentication`
  Missing or invalid credentials.
- `authorization`
  Valid credentials, insufficient scopes/roles.
- `rate_limit`
  Retry after backoff.
- `service`
  Remote failure or server instability.
- `timeout`
  Remote timeout or transport timeout.
- `config`
  Local SDK misconfiguration.
- `contract`
  Contract drift or invalid method/endpoint usage.
