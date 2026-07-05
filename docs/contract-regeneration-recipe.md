# Contract regeneration recipe — adding an operator namespace end to end

This is the **load-bearing, follow-it-cold** procedure for adding a new operator method or
namespace (e.g. Wave-3 `fleet.*`, `checkpoints.*`) to the SDK's control-plane contract and
having it reachable across **every** transport, documented, and gated.

The checked-in contract artifacts are **generated, never hand-edited**. You describe a method
in a catalog module, regenerate, and the JSON/TS artifacts, the method-id list, the metadata
counts, and the API docs all follow. Editing a generated file by hand is always wrong — the
`refresh:contracts:check` gate will revert your intent on the next regenerate.

## The transport map (what is automatic, what is hand-wired)

| Transport | Reachability | Cost to add a method |
| --- | --- | --- |
| HTTP (operator-sdk remote client) | **Automatic** — `createOperatorRemoteClient` enumerates from the contract and dispatches on the method's `http` binding. | Zero client code; just declare an `http` binding. |
| WebSocket `call` frames | **Automatic** — same `invokeGatewayMethodCall` dispatch path. | Zero. |
| DirectTransport (the TUI's in-process path) | **HAND-WIRED** in `packages/sdk/src/platform/runtime/operator-client.ts`. A new method is invisible in-process until you add it to `OperatorSessionsClient` (or the relevant namespace surface) **and** the `createOperatorClient` factory. | Explicit code + a manifest entry (see step 4). |
| Business logic | Written **once** in the daemon route handler; both HTTP and WS/invoke re-enter the same `dispatchApiRoutes`. | One handler. |

The asymmetry in the DirectTransport row is the parity trap: a method can pass every existing
HTTP test while being unreachable in the TUI. `test/transport-parity.test.ts` is the gate that
makes that fail loudly (see "The parity gate" below).

## The recipe

### 1. Describe the method

Add a `methodDescriptor(...)` to the right catalog module under
`packages/sdk/src/platform/control-plane/`:

- `sessions.*` live in `method-catalog-control-core.ts`.
- For a **new** namespace (e.g. `fleet.*`) create `method-catalog-fleet.ts` and wire its
  exported descriptor array into `BUILTIN_GATEWAY_METHODS` in `method-catalog.ts` (the
  aggregation array around lines 63-72).

Required fields (`GatewayMethodDescriptor`, see `method-catalog-shared.ts`): `id`, `title`,
`description`, `category`, `scopes`, and — **critically** — an `http` binding
`{ method, path }`. Without an `http` binding the method is not HTTP/DirectTransport-invokable
(it 501s as "not invokable"), only internal. Use the `methodDescriptor()` helper for the
`source` / `transport` / `access` defaults (`'builtin'` / `['http','ws']` / `'authenticated'`).

Pick scopes with the `read:` / `write:` prefix convention (`getGrantedGatewayScopes` filters on
`read:`). Example:

```ts
methodDescriptor({
  id: 'fleet.list',
  title: 'List Fleet Processes',
  description: 'Snapshot of the process/agent fleet the daemon is supervising.',
  category: 'fleet',
  scopes: ['read:fleet'],
  http: { method: 'GET', path: '/api/fleet' },
  outputSchema: listOutputSchema('processes', FLEET_PROCESS_SCHEMA),
})
```

### 2. Schema (only if a new shape is needed)

Add the JSON-schema constant to the matching `operator-contract-schemas-*.ts`. Reuse existing
shapes where possible (`SHARED_SESSION_RECORD_SCHEMA`, etc.). Use the `objectSchema` /
`arraySchema` / `bodyEnvelopeSchema` helpers from `method-catalog-shared.ts`. Avoid cyclic
schemas — the regenerator's `safeStringify` collapses cycles to `{}`.

### 3. Implement the handler (the ONLY place real logic lives)

Add the route path-match + handler in `packages/sdk/src/platform/control-plane/routes/*.ts`
(mirror the sessions steer/follow-up handlers) and the handler implementation that calls the
broker / registry. `invokeGatewayMethodCall` resolves the descriptor's `http` template and
re-enters `dispatchApiRoutes`, so this handler is reused by HTTP **and** WS/invoke.

### 4. DirectTransport surface (only if an in-process consumer needs it)

If the TUI (or any in-process consumer) must call the method locally, add it to the namespace
client interface and the `createOperatorClient` factory in `runtime/operator-client.ts`,
delegating to the broker/registry. **For `fleet.*` this step is NOT optional** — the TUI fleet
panel reads in-process.

Then record the decision in the parity manifest `DIRECT_TRANSPORT_COVERAGE` in
`test/transport-parity.test.ts`: map the contract id to the new client method name, or to the
sentinel `'http-only'` if you are **deliberately** skipping DirectTransport (webui-only). The
gate fails until you make this decision explicitly — that is the point.

### 5. Zod schema (optional — enables operator-sdk response validation)

Add a schema named per `methodIdToSchemaName` in
`packages/contracts/src/zod-schemas/<namespace>.ts` (e.g. `fleet.list` ⇒
`FleetListResponseSchema`; snake_case namespace segments are preserved). The registry
auto-picks it up by name; absence is tolerated (soft parity).

### 6. Event descriptor (if the method mutates cross-surface state)

Add a `GatewayEventDescriptor` in `method-catalog-events.ts` and reference its id from the
method's `events: [...]` field. Follow the `control.session_update` pattern (see
"Realtime / session-lifecycle events" below): declare the wire event, and if the channel
multiplexes several logical events onto one wire name, document the discriminant enum in the
`outputSchema`.

### 7. Regenerate + commit the generated files (the forcing function)

```
bun run refresh:contracts   # rewrites operator-contract.json, generated/operator-contract.ts,
                            # generated/operator-method-ids.ts (sorted), generated/foundation-metadata.ts
bun run docs:generate       # rewrites docs/reference-operator.md + reference-runtime-events.md
# or both at once:
bun run refresh:docs
```

Commit **all** generated outputs together (JSON + the generated `.ts` files + the regenerated
`.md`). A catalog edit without regeneration is a hard CI fail (see gates).

### 8. Verify the gates

```
bun run refresh:contracts:check   # exit 1 on any drift between source and artifacts
bun run contracts:check           # same, CI wrapper
bun run docs:check                # docs regenerated + completeness
bun test test/contracts-sync.test.ts test/operator-contract-catalog.test.ts \
         test/operator-sdk-coverage.test.ts test/transport-parity.test.ts
```

## The parity gate (`test/transport-parity.test.ts`)

Backstops the DirectTransport asymmetry. It enforces:

1. **Transport-declaration honesty** — a method that advertises `http` transport must carry an
   `http` binding, and vice-versa. A method "present in one transport but not the other" fails.
2. **DirectTransport coverage** — every method in an in-process namespace (`sessions.*`,
   `fleet.*`) must be declared in `DIRECT_TRANSPORT_COVERAGE`, either mapped to a real
   `createOperatorClient` method or explicitly `'http-only'`. **A new namespace method with no
   entry fails the gate.** This is what stops `fleet.*` shipping HTTP-only by accident.
3. **Cataloged-but-not-invokable is honest** — a descriptor with no `http` binding is not
   HTTP-invokable (the contract-driven client throws; the daemon returns 501), never a silent
   200.

When you add `fleet.*`, extend `DIRECT_TRANSPORT_COVERAGE` (step 4) — the gate already iterates
the `fleet` namespace.

## Realtime / session-lifecycle events

`control.session_update` (in `method-catalog-events.ts`) is the reference pattern for a
multiplexed lifecycle channel. The `SharedSessionBroker` publishes every lifecycle signal on a
single `session-update` wire event; the specific lifecycle name is the discriminated
`payload.event` field, enumerated by `SESSION_UPDATE_WIRE_EVENTS`. New broker signals flow
through the same wire channel automatically (generic `publishUpdate`) — only the enum needs the
new string. `SESSION_UPDATE_INTENT_MAP` documents which `payload.event` values each
cross-surface invalidation intent (`created` / `updated` / `steered` / `closed`) reacts to, so
webui and TUI subscribe identically. Broadcast is **un-domained** (reaches every live SSE/WS
client) and is dropped entirely when the `control-plane-gateway` flag is off (no phantom
buffering).

## Notes & gotchas

- **Version coupling** — the contract's `product.version` is overridden with the SDK VERSION at
  build; `foundation-metadata` carries it and `contracts-sync.test.ts` asserts it matches. A
  version bump alone re-drifts artifacts (expected). Keep new contract tests count/shape-based,
  not pinned to a version string.
- **Additive only** — `OPERATOR_METHOD_IDS` is a growing sorted union. Adding a method never
  renumbers anything. Renaming/removing a method or a broker event wire name is the breaking
  case — do not rename existing broker event strings (`session-created`, …) without a
  deprecation window; the webui keys on them.
- **Regen determinism** — after `refresh:contracts`, eyeball the JSON diff: it should be exactly
  your addition, nothing else.
