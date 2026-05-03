# Error Architecture

> Internal source map. For consumer guidance see [Error Handling](./error-handling.md) and [SDK Error Kinds](./error-kinds.md).

GoodVibes errors use shared categories and kinds from
`@pellux/goodvibes-errors`.

Important rules:

- retryable status codes are defined once in the errors package
- transport failures preserve URL, method, status, retry hints, and event fields
- contract validation failures are `ContractError`
- configuration failures are `ConfigurationError`
- HTTP failures are `HttpStatusError`
- unknown values are normalized without losing the original cause

Do not introduce parallel error taxonomies in extension packages.
