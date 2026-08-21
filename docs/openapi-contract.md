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
  as path operations (435 operations, one per method's declared HTTP verb and
  path); methods without one are reachable only through the generic invoke
  endpoint (`POST /api/control/gateway-methods/{methodId}/invoke`, 72 methods)
  and are listed on it under `x-invoke-only-methods`. `x-operator-methods` is a
  flat index of all 507 cataloged methods, REST-bound or invoke-only, each with
  its category, access level, resolved REST route (or `null` for invoke-only),
  and schema/typed-IO coverage.
- Real JSON Schemas for request/response bodies, embedded directly from the
  contract (OpenAPI 3.1 uses full JSON Schema, so they transfer unmodified).
  A method whose contract schema is absent or a bare object with no declared
  properties is marked `x-schema-coverage: schema-less` instead of being given
  an invented schema.
- **Honest typed-IO marking.** A method lacks typed SDK client IO when its id
  has no entry in the generated `OperatorMethodInputMap`/`OperatorMethodOutputMap`.
  That untyped set is currently empty: every cataloged method carries a
  rendered map entry, so every operation carries `x-typed-client-io: true` and
  `x-untyped-client-io-count` reads `0`. The marking mechanism stays in the
  generator (and in this document) because the ratchet is enforced, not fixed;
  a future method that ships without a map entry would surface here as
  `x-typed-client-io: false` and a nonzero count, not silently.
- For GET and DELETE methods, top-level input-schema properties that are not
  already path parameters are emitted as query parameters instead of a request
  body, since those HTTP verbs carry no body in this contract.
- The auth scheme from the contract's auth block: `bearerAuth` (HTTP bearer) and
  `sessionCookie` (the login-issued cookie), with `access: public` methods
  opting out via an empty `security` array on their own operation (the document
  level still requires one of `bearerAuth`/`sessionCookie` by default). The full
  contract auth block rides along as `x-auth-contract`.

## Regeneration and drift (the generated-artifact idiom)

```
bun run openapi:generate   # regenerate both copies
bun run openapi:check      # exit 1 on drift
```

`contracts:check` (part of `validate`) runs the drift check, so a change to the
operator contract that is not reflected in the committed OpenAPI document, or a
hand-edit to the document, fails gates. The generator's inputs are themselves
committed artifacts (`operator-contract.json` plus the typed-client-IO ratchet
inputs), so generation is deterministic.
