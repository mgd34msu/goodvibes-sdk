# Published OpenAPI operator contract

The operator contract is published as a real OpenAPI 3.1 document, generated
from the committed contract artifact and kept honest by a drift gate.

## Where to fetch it

- **Package export:** `@pellux/goodvibes-contracts/operator-openapi.json` and
  `@pellux/goodvibes-sdk/contracts/operator-openapi.json`
- **Repo copy:** `docs/operator-openapi.json` (byte-identical to the package
  artifact; the generator writes both)

## What it contains

- Every cataloged operator method. Methods with a dedicated REST binding appear
  as path operations (348 operations across their paths); methods without one
  are reachable through the generic invoke endpoint
  (`POST /api/control/gateway-methods/{methodId}/invoke`) and are listed on it
  under `x-invoke-only-methods`.
- Real JSON Schemas for request/response bodies, embedded directly from the
  contract (OpenAPI 3.1 uses full JSON Schema, so they transfer unmodified).
  A method whose contract schema is absent or a bare object is marked
  `x-schema-coverage: schema-less` instead of being given an invented schema.
- **Honest typed-IO marking.** The methods that lack typed SDK client IO (the
  foundation-io coverage ratchet's untyped set, currently 97) carry
  `x-typed-client-io: false` on their operations and `typedClientIo: false` in
  the `x-operator-methods` index. They are represented, marked, and counted
  (`x-untyped-client-io-count`) — never omitted.
- The auth scheme from the contract's auth block: `bearerAuth` (HTTP bearer) and
  `sessionCookie` (the login-issued cookie), with `access: public` methods
  opting out via an empty `security` array. The full contract auth block rides
  along as `x-auth-contract`.

## Regeneration and drift (the generated-artifact idiom)

```
bun run openapi:generate   # regenerate both copies
bun run openapi:check      # exit 1 on drift
```

`contracts:check` (part of `validate`) runs the drift check, so a change to the
operator contract that is not reflected in the committed OpenAPI document — or a
hand-edit to the document — fails gates. The generator's inputs are themselves
committed artifacts (`operator-contract.json` plus the typed-client-IO ratchet
inputs), so generation is deterministic.
