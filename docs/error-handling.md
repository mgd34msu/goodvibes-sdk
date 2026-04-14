# Error Handling

All public client packages normalize transport failures into structured SDK errors.

## Example

```ts
import { HttpStatusError } from '@goodvibes/errors';

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
import { HttpStatusError } from '@goodvibes/errors';

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
