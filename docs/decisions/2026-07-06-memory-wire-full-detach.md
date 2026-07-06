# Decision: complete the memory wire so every consumer fully detaches from the store file — the extended verb catalog, per-op host-vs-wire rulings, and the sync-recall snapshot seam

Date: 2026-07-06
Scope: SDK 1.2.0-track — memory wire full detach (follow-on to the 2026-07-06 memory-unification decision)
Status: accepted

## Context

The 1.1.0 memory wire family shipped five verbs on the daemon-owned canonical
store — `add`, `honestSearch`, `get`, `updateReview`, `delete`
(`POST /api/memory/records`, `/search`, `GET`/`DELETE /records/{id}`,
`POST /records/{id}/review`). Both consumers adopted them through
`MemorySpineClient` (SDK `platform/runtime/memory-spine`). That was enough to
STORE and RECALL a fact over the wire, but not enough for a consumer to FULLY
detach from the store file. Their landing reports named exactly what still fell
back to a local file:

- **TUI** — the turn-loop knowledge injection needs a bulk record read
  (`getAll`), and `/recall` drives the 16-method `MemoryApi`
  (`platform/knowledge`): browse, semantic search, review queue, link, export,
  import — none of which had a wire equivalent.
- **agent** — `agent-local-registry-memory.ts` kept `list`, `update`, and the
  SEMANTIC search path on the raw local registry with an explicit in-file note
  that no wire verb existed. Its inventory also named show/linksFor, queue,
  promote, link, export/import, and vector diagnostics.
- **both** — per-turn recall cannot await the wire because
  `Orchestrator.getSystemPrompt()` is SYNCHRONOUS.

The single-writer invariant is unchanged and non-negotiable: sql.js rewrites the
whole file on every `save()` with no row locking, so a wire client must NEVER open
the file. Anything a consumer still did locally while adopted to a daemon read a
divergent copy out of band from the canonical store — the exact silo E6 set out to
close.

## Decision

### 1. Extend the wire catalog through the full method-catalog pipeline

New operator methods, authored in `method-catalog-runtime.ts` and regenerated into
the checked-in contract artifacts (same pipeline as the 1.1.0 records verbs), with
matching route handlers (`integration-routes.ts`), body parsers
(`memory-record-body.ts`), route registration (`operator.ts`), and the
`MemoryRegistryLike` structural surface (`integration-route-types.ts`):

| verb | route | scope | maps to |
|------|-------|-------|---------|
| `memory.records.list` | `POST /api/memory/records/list` | read | `registry.search(filter)` (empty filter = getAll) |
| `memory.records.search-semantic` | `POST /api/memory/records/search-semantic` | read | `registry.searchSemantic(filter)` (scored) |
| `memory.records.update` | `POST /api/memory/records/{id}/update` | write | `registry.update(id, patch)` (scope/summary/detail/tags) |
| `memory.records.links.list` | `GET /api/memory/records/{id}/links` | read | `registry.linksFor(id)` |
| `memory.records.links.add` | `POST /api/memory/records/{id}/links` | write | `registry.link(id, toId, relation)` |
| `memory.records.export` | `POST /api/memory/records/export` | read | `registry.exportBundle(filter)` |
| `memory.records.import` | `POST /api/memory/records/import` | write | `registry.importBundle(bundle)` |

`vectorStats` and `doctor` already had read routes (`GET /api/memory/vector`,
`/api/memory/doctor`) and `reviewQueue` already had `GET /api/memory/review-queue`
— those are now surfaced through the client rather than re-routed.

Semantic-search options parity: `list`, `search-semantic`, and `export` all accept
the SAME `MemorySearchFilter` fields as the shipped `search` verb (scope, cls, tags,
query, semantic, since, reviewState, minConfidence, provenanceKinds, staleOnly,
limit), so the wire honestSearch/search matches the local `honestSearch` filter
exactly. `distance` on a semantic result is nullable on the wire because a
no-vector-match fallback carries `Infinity`, which JSON serializes to `null` — an
honest signal that the row was ranked lexically, not by vector.

### 2. Per-op ruling — what goes over the wire vs stays host-only

Every op the consumers named is ruled explicitly; nothing is silently omitted.

- **WIRE (read):** `list`/getAll, `search-semantic`, `linksFor`, `export`,
  `vectorStats`, `doctor`, `reviewQueue`. These read the daemon's OWN canonical
  store/index — honest to serve, and the whole point of detaching.
- **WIRE (write, single-writer daemon applies it):** `update`, `link`, `import`.
  A client sends the intent; the daemon is the sole process that touches the file.
- **`promote` → NOT a distinct verb.** "Promote" is expressed through verbs that
  now exist: a scope promotion (session→project→team) is `update({ scope })`; a
  review promotion (fresh→reviewed) is `updateReview({ state: 'reviewed' })`. No
  new endpoint; ruled here so the gap is closed on purpose, not by omission.
- **HOST-ONLY — `rebuildVectors` / `rebuildVectorsAsync`.** Rebuilding the vector
  index is maintenance a store performs on its OWN index. The daemon keeps its
  canonical index current on every add/import and exposes an admin-gated
  `POST /api/memory/vector/rebuild` for a forced rebuild. A wire client owns no
  index to rebuild, so a client-initiated rebuild is an admin/diagnostic action
  against a store it does not own — it stays out of band and is deliberately NOT on
  `MemoryAccess`. A client that needs a forced canonical rebuild calls the existing
  admin route.
- **HOST-SIDE PROJECTION — `explain`.** `MemoryApi.explain` composes
  `selectKnowledgeForTask` over the store's reads; it is a client-side projection,
  not a store operation. It runs over whatever read surface is active (a snapshot or
  the async reads), so it is not a wire verb.

### 3. Widen `MemoryAccess` / `MemorySpineClient`, with version tolerance

`MemoryAccess` splits into `MemoryCoreAccess` (the five shipped verbs, always
required) and `MemoryExtendedAccess` (the ten new read/write verbs). The injected
wire transport type `MemoryTransport = MemoryCoreAccess & Partial<MemoryExtendedAccess>`
— core required, extended OPTIONAL — so a surface pinned to an older SDK/daemon
that predates a verb still satisfies the type. When a client in wire mode calls an
extended verb its adopted daemon does not implement, `MemorySpineClient` REJECTS
with a stated reason. It never silently reads the local file, because that would
break the single-writer invariant AND report a divergent local copy as canonical —
the exact dishonest-recall failure the whole design prevents. This preserves the
"an older adapter can still adapt raw REST" tolerance both consumer transports
document, without weakening honesty.

The knowledge-injection bulk read (`TurnKnowledgeRegistrySource.getAll` /
`syncKnowledgeMemoryNodes`) is satisfied by `MemoryAccess.list()` (async, over the
wire when adopted) and, for the synchronous per-turn path, by the recall snapshot
below.

### 4. The sync-recall seam — a freshness-stamped cached snapshot

The per-turn prompt builder is synchronous; a wire read is asynchronous; a sync
function cannot await the wire. The least-friction honest design (chosen over both
"make the whole prompt path async" — a large cross-consumer refactor — and "let a
wire client open the file" — a single-writer violation) is a CACHED, freshness-
stamped snapshot held by `MemorySpineClient` (`recall-snapshot.ts`):

1. an ASYNC pre-turn hook calls `refreshRecallSnapshot(filter?, { recall })` — this
   awaits the honest recall search over the CURRENT route (wire or local) and stamps
   the result with a capture time and the access mode it came from;
2. the SYNC prompt builder calls `recallSnapshot()` — it returns the cached records
   immediately with a freshly-computed `ageMs`, a `stale` flag (against a
   configurable window, default 30s), the capture `mode`, and an honest `note`.

Honesty rules, enforced by tests: before any refresh the snapshot is EMPTY and its
note SAYS SO ("not yet captured … call refreshRecallSnapshot in an async pre-turn
hook") — never a silent empty that reads as "nothing was ever stored"; past the
freshness window `stale` is true and the note says the data may be out of date; the
note states WHERE the data came from (over the wire vs local) and carries the search
envelope's own degraded-index reason/caveat verbatim. Consumers adopt this by
awaiting `refreshRecallSnapshot` in their existing async pre-turn path and reading
`recallSnapshot()` inside `getSystemPrompt`.

## Consequences

- The land DOES move the contract artifacts (operator-contract.json/.ts,
  operator-method-ids.ts, foundation-metadata.ts) and `docs/reference-operator.md`
  — regenerated from the catalog, unlike the 1.1.0 memory-unification step which
  added no wire methods. `etc/goodvibes-sdk.api.md` also moves, but ONLY in the two
  generated constants re-exported from the main entry (`OPERATOR_METHOD_IDS` gains
  the seven new ids; `FOUNDATION_METADATA.operatorMethodCount` 320→327). The
  memory-spine CLIENT types (`MemoryCoreAccess`/`MemoryExtendedAccess`/
  `MemoryRecallSnapshot` etc.) live in the `platform/runtime/memory-spine` subpath
  export, outside the api-extractor rollup, so they do NOT appear in the report —
  `api:check` is satisfied by regenerating the report for the two constant changes.
- One-writer invariant holds throughout: a wire client routes EVERY op (core and
  extended) through the transport and structurally cannot reach the local file; an
  unsupported extended verb rejects rather than falling back to the file.
- Consumer rewiring (agent `agent-local-registry-memory.ts` list/update/semantic
  paths onto the spine; TUI `getMemoryApi`/`/recall` and knowledge-injection onto
  the spine + snapshot) is SDK-dependent and staged on the consumer branches until
  this SDK ships, per the sibling convention.
- Follow-on still tracked: the daemon becoming the DEFAULT single writer at boot
  (canonical placement TARGET) remains sequenced separately; this step delivers the
  wire it needs.
