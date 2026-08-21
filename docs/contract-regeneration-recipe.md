# Contract regeneration recipe: adding an operator namespace end to end

This is the **load-bearing, follow-it-cold** procedure for adding a new operator method or
namespace (e.g. `fleet.*`, `checkpoints.*`) to the SDK's control-plane contract and
having it reachable across **every** transport, documented, and gated.

The checked-in contract artifacts are **generated, never hand-edited**. You describe a method
in a catalog module, regenerate, and the JSON/TS artifacts, the method-id list, the metadata
counts, and the API docs all follow. Editing a generated file by hand is always wrong. The
`refresh:contracts:check` gate will revert your intent on the next regenerate.

## The transport map (what is automatic, what is hand-wired)

| Transport | Reachability | Cost to add a method |
| --- | --- | --- |
| HTTP (operator-sdk remote client) | **Automatic.** `createOperatorRemoteClient` enumerates from the contract and dispatches on the method's `http` binding. | Zero client code. Just declare an `http` binding. |
| WebSocket `call` frames | **Automatic.** Same `invokeGatewayMethodCall` dispatch path. | Zero. |
| DirectTransport (the TUI's in-process path) | **HAND-WIRED** in `packages/sdk/src/platform/runtime/operator-client.ts`. A new method is invisible in-process until you add it to `OperatorSessionsClient` (or the relevant namespace surface) **and** the `createOperatorClient` factory. | Explicit code + a manifest entry (see step 4). |
| Business logic | Written **once** in the daemon route handler; both HTTP and WS/invoke re-enter the same `dispatchApiRoutes`. | One handler. |

The asymmetry in the DirectTransport row is the parity trap. A method can pass every existing
HTTP test while being unreachable in the TUI. `test/transport-parity.test.ts` is the gate that
makes that fail loudly (see "The parity gate" below).

## The recipe

### 1. Describe the method

Add a `methodDescriptor(...)` to the right catalog module under
`packages/sdk/src/platform/control-plane/`:

- `sessions.*` live in `method-catalog-control-core.ts`.
- For a **new** namespace, create `method-catalog-<name>.ts` exporting its own descriptor
  array, then wire that array into an aggregation point. There are two, and which one you use
  depends on where the namespace belongs:
  - `BUILTIN_GATEWAY_METHODS` in `method-catalog.ts` for a namespace that stands on its own
    (most of the catalog's ~30 families work this way).
  - `builtinGatewayControlMethodDescriptors` in `method-catalog-control.ts` for a namespace
    that belongs alongside the other control-plane surfaces (session lifecycle, live-turn,
    hosted sessions, power, devices, memory, voice-setup, companion, automation). `fleet.*`
    took this path, its descriptor array is spread into `method-catalog-control.ts`, which is
    itself one of the spreads inside `BUILTIN_GATEWAY_METHODS`.

Required fields (`GatewayMethodDescriptor`, see `method-catalog-shared.ts`): `id`, `title`,
`description`, `category`, `scopes`, and, **critically**, an `http` binding
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
schemas. The regenerator's `safeStringify` collapses cycles to `{}`.

### 3. Implement the handler (the ONLY place real logic lives)

Add the route path-match + handler in `packages/sdk/src/platform/control-plane/routes/*.ts`
(mirror the sessions steer/follow-up handlers) and the handler implementation that calls the
broker / registry. `invokeGatewayMethodCall` resolves the descriptor's `http` template and
re-enters `dispatchApiRoutes`, so this handler is reused by HTTP **and** WS/invoke.

### 4. DirectTransport surface (only if `createOperatorClient` is how the in-process consumer reaches the method)

Whether this step is needed depends on how the in-process consumer already gets its data.

If the only path to the underlying state is through `createOperatorClient`, add the method to
the namespace client interface (`OperatorSessionsClient`, or a new equivalent) and the
`createOperatorClient` factory in `runtime/operator-client.ts`, delegating to the broker or
registry.

If the in-process consumer already holds a direct reference to the same object the method
reads (a registry, a broker, an engine), it does not need a DirectTransport wrapper at all.
`fleet.*` is the real case. The TUI's fleet panel holds a direct reference to the daemon's
`ProcessRegistry` and calls `registry.query()` in-process, never through `operator-client`. All
of `fleet.*` is declared `'http-only'` in the coverage manifest below, and `createOperatorClient`'s
`OperatorClient` interface has no `fleet` member at all. The wire methods exist purely for
remote consumers (webui, a detached session view) that don't share the daemon's process.

Either way, record the decision in the parity manifest `DIRECT_TRANSPORT_COVERAGE` in
`test/transport-parity.test.ts`: map the contract id to the new client method name, or to the
sentinel `'http-only'` if you are **deliberately** skipping DirectTransport because no
DirectTransport wrapper is needed. The gate fails until you make this decision explicitly for
every method in a namespace listed in `DIRECT_TRANSPORT_NAMESPACES`. That is the point.

### 5. Zod schema (optional, enables operator-sdk response validation)

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

### 7. Regenerate and commit the generated files (the forcing function)

```
bun run refresh:contracts   # rewrites operator-contract.json, generated/operator-contract.ts,
                            # generated/operator-method-ids.ts (sorted), generated/foundation-metadata.ts,
                            # the foundation-io type maps, the OpenAPI contract, the webui facade,
                            # and the Home Assistant client, in that order
bun run docs:generate       # rewrites docs/reference-operator.md, docs/reference-peer.md,
                            # and docs/reference-runtime-events.md
# or both at once:
bun run refresh:docs
bun run pretest             # runs the typecheck gate (tsc -b --force); api-extractor reads
                            # compiled .d.ts, so a cold follower MUST build before extracting
                            # (first-cold-run gap)
bunx api-extractor run --local   # regenerates etc/goodvibes-sdk.api.md
```

`refresh:contracts` is five scripts run in sequence (`refresh-contract-artifacts.ts`,
`generate-foundation-io-entries.ts`, `generate-openapi-contract.ts`,
`generate-webui-facade.ts`, `generate-homeassistant-client.ts`), not one. The last two emit
the mechanical transport layers that the webui and the Home Assistant integration otherwise
hand-write, generated straight from the same committed operator contract, so a new method
with a plain-REST `http` binding reaches both without hand-editing their client code.

Mid-MERGE note (second first-cold-run gap): `api:check` diffs the working tree against the
index. During a merge you must `git add` the regenerated artifacts BEFORE the diff-based
gates (`api:check`, `refresh:contracts:check`) read true, or they fail on your own
unstaged regen output.

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

1. **Transport-declaration honesty.** A method that advertises `http` transport must carry an
   `http` binding, and vice-versa. A method "present in one transport but not the other" fails.
2. **DirectTransport coverage.** Every method in a namespace listed in
   `DIRECT_TRANSPORT_NAMESPACES` (currently `sessions` and `fleet`) must be declared in
   `DIRECT_TRANSPORT_COVERAGE`, either mapped to a real `createOperatorClient` method or
   explicitly `'http-only'`. **A new method in one of these namespaces with no entry fails the
   gate.** This is what forced a deliberate, documented decision for every `fleet.*` method
   before it shipped. Every `fleet.*` id today is `'http-only'`, and that is recorded, not
   accidental.
3. **Cataloged-but-not-invokable is honest.** A descriptor with no `http` binding is not
   HTTP-invokable (the contract-driven client throws; the daemon returns 501), never a silent
   200.

Adding a new in-process namespace means adding its name to `DIRECT_TRANSPORT_NAMESPACES` in
`test/transport-parity.test.ts`; the gate only enforces coverage for namespaces listed there.

## Realtime / session-lifecycle events

`control.session_update` (in `method-catalog-events.ts`) is the reference pattern for a
multiplexed lifecycle channel. The `SharedSessionBroker` publishes every lifecycle signal on a
single `session-update` wire event; the specific lifecycle name is the discriminated
`payload.event` field, enumerated by `SESSION_UPDATE_WIRE_EVENTS`. New broker signals flow
through the same wire channel automatically (generic `publishUpdate`). Only the enum needs the
new string. `SESSION_UPDATE_INTENT_MAP` documents which `payload.event` values each
cross-surface invalidation intent (`created` / `updated` / `steered` / `closed` / `deleted`)
reacts to, so webui and TUI subscribe identically. The event is domain-tagged `session`. A
client that narrows its subscription with `?domains=…` must include `session` to receive it; a
client that opts into no narrowing receives it along with everything else. It is dropped
entirely when the `control-plane-gateway` flag is off (no phantom buffering).

## Notes and gotchas

- **Version coupling.** The contract's `product.version` is overridden with the SDK VERSION at
  build. `foundation-metadata` carries it and `contracts-sync.test.ts` asserts it matches. A
  version bump alone re-drifts artifacts (expected). Keep new contract tests count/shape-based,
  not pinned to a version string.
- **Additive only.** `OPERATOR_METHOD_IDS` is a growing sorted union. Adding a method never
  renumbers anything. Renaming or removing a method or a broker event wire name is the breaking
  case. Do not rename existing broker event strings (`session-created`, …) without a
  deprecation window. The webui keys on them.
- **Regen determinism.** After `refresh:contracts`, eyeball the JSON diff. It should be exactly
  your addition, nothing else.
