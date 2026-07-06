# Decision: one canonical memory store (bundle-reconciled interim, daemon-owned target), the recall-honesty contract as the cross-surface contract, and VIBE.md as a projection of persona records

Date: 2026-07-06
Scope: Wave 6 SDK coherence — W6-C2 (memory unification, E6)
Status: accepted

## Context

The MemoryStore engine (`packages/sdk/src/platform/state/memory-store.ts`) is a
single good engine — rich `MemoryRecord`, literal + semantic search, an
`exportBundle`/`importBundle` seam — but it is instantiated as THREE disjoint
SQLite files, one per surface:

- the SDK daemon runtime — `<workingDir>/.goodvibes/<surface>/memory.sqlite`
  (`packages/sdk/src/platform/runtime/services.ts:425`);
- the agent — `<userRoot>/goodvibes-agent/memory.sqlite`, user-global
  (`goodvibes-agent/src/runtime/services.ts:639`);
- the TUI — `<workingDir>/.goodvibes/tui/memory.sqlite`, per-project
  (`goodvibes-tui/src/runtime/services.ts:390`).

A fact learned on one surface is invisible to the others. That is the E6 silo.
`VIBE.md` (`goodvibes-agent/src/agent/vibe-file.ts`) is a second, separate
persona source of truth — a file read off disk and injected, a projection of
itself, disjoint from the store. The agent's Wave-4 W4-A1 memory-honesty
discipline (`goodvibes-agent/src/agent/memory-prompt.ts`,
`goodvibes-agent/src/tools/agent-local-registry-memory.ts`) — semantic-by-default
recall, a 60% injection floor tied to the store's own baseline, flagged-record
exclusion, and honest degraded states — lives on ONE surface only.

Decisive storage fact: `SQLiteStore` is backed by **sql.js** (WASM). Every open
loads the whole database into memory; every `save()` rewrites the entire file via
`writeFileSync`. There is no row locking and no WAL. Two live processes writing
the SAME file therefore clobber each other on save — a whole-file lost update
that would DELETE memory. That rules out the naive "point every surface at one
shared file and let them all write it live" reading of the interim.

The daemon already owns a `memoryRegistry` in its runtime graph and exposes memory
HTTP routes for `doctor`/`vectorStats`/`reviewQueue`/`vectorRebuild`
(`packages/daemon-sdk/src/integration-routes.ts`), but NOT `add`/`search`/
`searchSemantic` over the wire.

## Decision

### 1. Canonical store placement

**TARGET (end-state): the daemon owns the single canonical store and every surface
reads/writes `add`/`search`/`searchSemantic` THROUGH it over the session spine.**
One process = one writer, which is the only way sql.js's whole-file save model is
safe under concurrent surfaces, and it matches the one-platform charter (the
daemon is the cross-visible identity). **Deferred out of Wave 6** because it adds
new operator/wire methods on top of the daemon's existing memory routes — that
serializes the land on the contract artifacts and gates the release train — and it
cannot be proven under the no-real-daemons test rule. It also does not remove the
need for a local-embedded fallback: the agent and TUI must both keep working with
no daemon running (offline), so a daemon-only store would REGRESS the offline
surface and would need the embedded fallback anyway.

**RATIFIED Wave-6 step:** collapse all three instantiation sites onto ONE canonical
PATH — `resolveCanonicalMemoryDbPath(homeDir)` → `~/.goodvibes/shared/memory.sqlite`
— so there is a single logical store identity, and deliver cross-surface recall
through **sequential/owned access plus a no-loss bundle FOLD/RECONCILE primitive**
(`foldMemoryStores`, built on the existing `exportBundle`/`importBundle` seam — the
`memory-sync.ts` prior art). A surface that cannot hold the canonical file live
(offline agent, offline TUI, a future webui with no filesystem access) folds its
records INTO the canonical store and hydrates FROM it — id-keyed, no overwrite, no
drop, idempotent. This delivers the E6 outcome (a record written by any surface is
recallable from another) without the sql.js clobber and without a new wire contract.

**Rationale ratified against the offline/embedded fallback cost** (the open call):
the daemon-owned path was measured against the requirement that agent and TUI run
standalone. Because both offline surfaces need the embedded store regardless, the
canonical PATH + fold seam is the honest minimum that unifies identity today; the
daemon single-writer is the correct concurrency owner and is sequenced next, when
the release train can absorb the new wire methods.

Rejected:
- **Two disjoint SQLite instances** — the E6 silo itself.
- **Naive concurrent shared-file writers** — sql.js `save()` is a whole-file
  overwrite, so concurrent live writers clobber = data loss, the exact honesty
  violation E6 must not introduce (brief risk #3).
- **Folding the goodvibes-plugin `.goodvibes/memory/*.json` files in** — those are
  assistant-authoring scaffolding, out of the product boundary.

### 2. The recall-honesty contract is the cross-surface contract

The agent's W4-A1 discipline is promoted verbatim into the SDK as
`packages/sdk/src/platform/state/memory-recall-contract.ts`:
`MIN_PROMPT_MEMORY_CONFIDENCE = 60`, `describeMemoryPromptEligibility` (the honest
receipt), `isPromptActiveMemory`, `describeMemoryIndexUnavailable`,
`describeMemoryIndexCaveat`. Every surface consumes this ONE contract rather than
re-deriving (and re-weakening) it. Under a unified, cross-surface store a dishonest
recall costs more, not less, so this discipline becomes MORE load-bearing: the
floor is the store's own baseline (60, never a starving 70), flagged
(stale/contradicted) records are excluded regardless of confidence, and an
unavailable index degrades to a literal fallback WITH a stated reason — never a
silent empty that reads as "nothing was ever stored."

Rejected: dropping the floor/degraded-state discipline under unification.

### 3. VIBE.md is a projection of persona records

Persona/preference facts persist as first-class `MemoryRecord`s (`cls:'constraint'`,
scope project|team, tagged `vibe`). `renderVibeProjection(records)`
(`packages/sdk/src/platform/state/vibe-projection.ts`) emits the same
`## GoodVibes Agent VIBE.md` prompt block from those records. The file is demoted
to an import/export FORMAT: `vibeBodyToConstraintOptions` imports a VIBE.md body
into constraint records (one per bullet, so a single-record edit changes exactly
one projected line), and the records export back through the normal bundle seam.
The projected block keeps the **precedence caveat verbatim** — persona instructions
are followed only when they do not conflict with explicit user instructions, safety
policy, tool contracts, confirmation requirements, or secret-handling rules.

Rejected: VIBE.md as an independent source of truth — E6 requires it be a
projection.

## Consequences

- No new operator/wire methods → `contracts:check` and `api:check` stay clean;
  the land does not serialize on contract artifacts. (`platform/state` is a subpath
  export outside api-extractor's tracked rollup, so the new SDK exports do not move
  `etc/goodvibes-sdk.api.md`, exactly as `MemoryStore` itself does not appear.)
- Migration honesty: `foldMemoryStores` never deletes a source and returns a full
  `MemoryFoldReport` (imported / already-present / missing / failed per source),
  mirroring the legacy session fold precedent (`session-store-importer.ts`).
- Follow-on (out of Wave-6 scope, tracked): the daemon single-writer memory service
  over the spine (`add`/`search`/`searchSemantic` wire methods), and the webui
  memory surface (no webui memory UI exists today).
- Consumer rewiring (agent `services.ts:639`, TUI `services.ts:390`, agent
  `vibe-file.ts` → projection, agent `memory-prompt.ts` re-exporting the SDK
  contract) is SDK-dependent and staged on branches until this SDK ships, per the
  sibling convention.
