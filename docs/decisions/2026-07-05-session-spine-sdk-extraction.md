# Decision: Extract the session-spine surface client + read facade into the SDK (One-Platform Wave 3, S4)

Status: accepted — 2026-07-05
Scope: goodvibes-sdk (`packages/sdk`) — new public subpath `@pellux/goodvibes-sdk/platform/runtime/session-spine`
Wave: One-Platform Wave 3 — THE OBSERVABILITY WIRE (S4)

## Decision

ONE `SessionSpineClient` core lives in the SDK behind a public subpath, consumed by
BOTH the TUI and the agent (and, in waiting, webui / a future PWA). It is built around
an INJECTED async transport interface `{ register(input), close(id) } => SpineResult`
that folds the two real backends — the TUI's typed sessions client and the agent's
version-tolerant raw-REST mirror — into one common core. Activation is an optional mode
(construct WITH a transport for the agent's live-immediately posture, or WITHOUT one for
the TUI's dormant-until-`activate()` posture). Participant identity, origin `kind`, queue
bound and heartbeat window are options with the verified defaults. The `SessionUnionCache`
cross-surface read facade (`SessionReadFacade`) MOVES alongside it. Agent token-reading
(`connected-host-auth`, `createSpineConnectionResolver`) stays agent-local; the SDK never
reads token files — each surface builds its own transport adapter and hands it in.

Chosen per Mike's SDK-boundary ruling (2026-07-05): machinery needed by 2+ surfaces
belongs in the SDK. The TUI and agent shipped near-twin copies of the SAME class
(register/reopen, heartbeat debounce, the 45s keepalive timer — the agent's own comment
says "ports goodvibes-tui D3/#4 1:1" — the bounded drop-oldest offline ring, reconnect
flush, `foldLegacyRecords`, `dispose`, and the free `foldLegacySpineStore`; constants
identical: `DEFAULT_QUEUE_LIMIT=128`, `DEFAULT_HEARTBEAT_MIN_INTERVAL_MS=45000`). The
drift had already begun (result-kind handling diverged), which is exactly the failure mode
the SDK boundary exists to prevent.

## What shipped (SDK side; the consumer cutovers are W3-T1 / W3-A1)

- **New subpath `@pellux/goodvibes-sdk/platform/runtime/session-spine`** (added to
  `packages/sdk/package.json` exports). Source under
  `packages/sdk/src/platform/runtime/session-spine/`: `client.ts` (core + transport
  interface + participant consts + `foldLegacySpineStore`), `union-cache.ts` (the read
  facade), `index.ts` (public re-exports).
- **Injected transport, folded result vocabulary.** The core builds a canonical
  `RegisterSharedSessionInput` and hands it to a `SpineTransport`; the adapter performs the
  wire call and returns a `SpineResult` with outcome `ok` | `offline` | `rejected`:
  - `ok`       → reachability online, flush the queue.
  - `offline`  → transient connectivity fault → reachability offline, enqueue for
    idempotent replay (drop-oldest, cap 128).
  - `rejected` → DURABLE refusal (auth/route-missing/server error) → logged, NEVER
    enqueued (so it can't retry-forever), reachability unchanged.
  The TUI adapter is binary (resolve→ok / throw→offline) and never emits `rejected`; the
  agent adapter folds its REST result kinds (`connected_host_unavailable`→offline;
  `auth_required` / `connected_host_route_unavailable` / `connected_host_error`→rejected).
- **Optional activation mode.** A `transport` supplied at construction = live-immediately
  (agent, live for the whole process — keepalive starts in the constructor); omitting it =
  dormant-until-`activate()` (TUI, activated once its bootstrap adopts a compatible external
  daemon, `deactivate(reason)` when the mode is lost). `probeReachability()` runs an injected
  `probe` (the agent's deferred GET /status) and is an honest no-op returning the current
  status when no probe was supplied (the TUI's case).
- **Options with verified defaults.** `participant` (required; `TUI_SPINE_PARTICIPANT` /
  `AGENT_SPINE_PARTICIPANT` are exported from the subpath), `recordKind` (TUI stamps `'tui'`;
  the agent omits it — its REST mirror stamps `'agent'` server-side), `queueLimit` (128),
  `heartbeatMinIntervalMs` (45000), `now`, `log`.
- **`SessionUnionCache` moved verbatim** (generation guard, byte-for-byte
  local-wins-dedup / offline-degrade / probe-timeout semantics). Its distinct
  `DEFAULT_PROBE_TIMEOUT_MS` (4000ms) stays under its own `SessionUnionCacheOptions.probeTimeoutMs`
  namespace, separate from the spine client's register/close transport timeouts (which now
  live in each adapter, not the core) — so the constant-name collision the two source files
  had is structurally impossible here.

## Divergence rulings (where the two twins differed, and how they were folded)

1. **Transport (typed vs REST):** injected `SpineTransport`. The core NEVER references a
   typed sessions client, so the agent — which compiles against a pinned npm SDK that may
   predate `sessions.register` — supplies a hand-rolled REST adapter and is unaffected.
2. **Activation (dormant vs live-immediately):** optional constructor `transport`.
3. **Participant const:** required `participant` option; both canonical consts exported.
4. **`kind` field (TUI stamps, agent omits):** `recordKind` option; when unset, the built
   input omits `kind` entirely.
5. **Result-kind handling (TUI binary vs agent's ok/offline/durable-reject):** folded into
   `SpineResult.outcome` (see above). The agent's richer vocabulary is the superset; the TUI
   adapter uses only `ok`/`offline`.
6. **Register/close/probe timeouts:** these are REST-implementation concerns and move to the
   AGENT adapter (which owns the fetch), NOT the SDK core — the core no longer makes the wire
   call, so it has nothing to time out. This is a deliberate departure from a literal reading
   of the brief's "timeouts become options": under transport injection the timeout belongs
   with the transport.
7. **Unexpected-transport-throw path:** the core treats an unexpected `throw` from the
   transport as transient-offline (enqueue + reachability offline) — the TUI's exact current
   behavior, and a safe superset for the agent whose adapter is exhaustively try/caught and
   does not throw in practice. Durable rejects are a returned `rejected` outcome, not a throw,
   so they still never enqueue.

## Rejected alternatives

- **Leaving two twins in sync by convention.** The drift had already started (result-kind
  handling); Mike's ruling is 2+ surfaces => SDK.
- **A typed-client-only SDK core.** The agent's pinned SDK may predate the verb; REST
  injection is mandatory.
- **Pulling token-reading into the SDK.** It is tied to the agent's home-dir layout and
  `operator-tokens.json` conventions; the SDK takes a pre-built adapter, not a token path.
- **Leaving the union cache TUI-local.** It is SDK-clean and serves the union goal; cheap to
  move now, and W3-T2 already consumes it as a `SessionReadFacade`, so the SDK is its honest
  home.

## Flag

The union cache "generalizes cleanly" is ARCHITECTURAL until a second real consumer imports
it — today only the TUI does (the agent has no union-list panel). The move is speculative but
cheap: zero agent code changes to accommodate it, and it directly serves the One-Platform
union goal (webui / agent are consumers-in-waiting).

## Consumability proof

`test/session-spine-daemon-integration.test.ts` drives the SDK core against a REAL
`bootDaemon` (isolated home, ephemeral port) over a real `HttpTransport`, using the transport
adapter EXACTLY as the TUI's `bootstrap.ts` builds it, across the full journey: adopt
(`activate`), register-on-create, timer-driven keepalive, offline queue during an outage,
reconnect flush, and honest close. `test/session-union-cache-daemon-integration.test.ts`
proves the adopted-mode union includes a daemon-only (cross-surface) session and degrades
honestly when the daemon dies. Parameterized parity between the typed and REST adapters is in
`test/session-spine-client.test.ts`.
