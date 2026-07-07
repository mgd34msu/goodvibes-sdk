# Knowledge wiki: honesty and compounding fixes

Date: 2026-07-07
Status: accepted
Area: `packages/sdk/src/platform/knowledge`

## Context

An audit of the knowledge system measured the general "LLM wiki" against the concept
it implements (immutable raw sources → agent-owned derived pages → schema; never invent;
merge, don't duplicate; log contradictions; version control; a retained raw "data lake"
that re-extracts as extraction improves) and against the ecosystem honesty bar (stated
reasons, no silent empties, no fabricated confidence, no silent data loss).

The wall between the general wiki, the home-graph, and the agent personal-ops knowledge
holds by construction (three separate SQLite files opened by three separate store
instances). The correctness gaps were in the wiki's own behavior. This record captures
the fixes and the two designs that carried the most judgement (revision history and the
review gate).

## Decisions

### 1. Node revision history (was: silent `INSERT OR REPLACE`)

`upsertNode` overwrote a node's title/summary/metadata with zero retained history. We
added an append-only `knowledge_node_revisions` table. On every content-changing
`upsertNode`:

- A revision is recorded only when tracked content actually changed (title, summary,
  status, confidence, sourceId, aliases, or metadata excluding the volatile review
  provenance stamp). A provenance-only restamp or an idempotent re-upsert records nothing.
- The first tracked change to a pre-existing node also writes a baseline revision holding
  the about-to-be-overwritten content, so the prior version is never lost.
- Each revision records `changeKind` (`create`/`update`) and `changedFields`.

Read path: `KnowledgeStore.listNodeRevisions(id)` → `KnowledgeService.listNodeRevisions`
→ `knowledgeApi.graph.nodes.history(id)` (in-process). A hard node delete purges its
revisions (delete means delete).

### 2. Node review gate (was: everything silently `active`)

Activation is now honest and gated at `upsertNode`:

- An explicit producer status (or a review that applied facts) is honored and labelled
  `explicit`/`reviewed`.
- An already-active node stays active; the first time it passes the gate without prior
  provenance it is labelled `pre-gate` — folds/migrations are never downgraded.
- A new/draft node auto-accepts at/above a **configurable** confidence threshold
  (`nodeAutoAcceptConfidence`, stored per KnowledgeStore) — labelled `auto-accepted` with
  the numeric reason — otherwise it is held as `draft` (pending review) and is not served
  by search/ask until a decide step (`KnowledgeService.reviewNode`) accepts it (→ active,
  `reviewed`) or rejects it (→ stale).

Every activation now carries a `metadata.reviewProvenance` stamp, so a node is never
*silently* active.

**Default threshold = 40**, chosen just below the lowest confidence the existing synthesis
producers emit (deterministic facts at 45, deterministic wiki pages at 55) so those flows
keep activating — now with honest provenance — while genuinely low-confidence content is
held. The mechanism is the deliverable; consumers raise the threshold to hold more for
review. `reviewProvenance` is treated as system bookkeeping: it is excluded from the
node-content-shape classifier and from metadata search text so it changes neither
scope classification nor search ranking.

The serve surface was aligned: `knowledge.search` and the semantic graph index now serve
**only** `active` nodes (previously they served everything except `stale`, so a draft would
have answered). This also fixes the separate stale-serving `search` defect.

### 3. No fabricated answer-gap evidence

`isRepairedAnswerGap` treated a merely `stale` or `not_applicable` gap as "repaired" and
auto-closed the open issue with the invented reason *"Answer gap already has accepted
repair evidence."* A gap is now repaired **only** with real evidence — `repairStatus ===
'repaired'` **and** a concrete signal (a promoted fact count > 0 or accepted source ids) —
and the resolution reason is built from that actual evidence. Otherwise the gap stays open
honestly.

### 4. Data-lake re-extraction on extractor-version advance

Re-extraction previously fired only to repair an *empty* extraction, so an improved
extractor never re-processed already-successful captures. Extractions now carry an
`extractorVersion` stamp, applied at the single `store.upsertExtraction` choke point (so
every write path — ingest, home-graph, browser-history, import — is covered, and a fresh
write always lands the current generation without looping). `knowledgeExtractionNeedsRefresh`
re-extracts a stored capture whose version is older than the current
`KNOWLEDGE_EXTRACTOR_VERSION`, even when its prior text was usable. Bumping that constant
re-processes the retained lake through the existing per-source recompile job.

### 5–7, 9, 10, unlink, H1, family assert (mediums)

- **mergeNodes** (5): a real `store.mergeNodes(loser, winner)` re-points every edge onto
  the survivor (deduping, dropping self-loops), records a `merged_into` edge, and marks the
  loser stale with a `mergedInto` stamp.
- **Honest hard delete + GraphQL filter** (6): `deleteNode`/`deleteSource` exposed via the
  service/API; `queryNodes` (which backs the GraphQL `node`/`nodes` and the
  `/api/knowledge/nodes` route) now hides `stale` nodes by default, with an explicit
  `includeStale` opt-out — a forgotten node is no longer served over the wire.
- **Refinement-task cascade** (7): single-record node/source deletes now also delete the
  `knowledge_refinement_tasks` that referenced them (the space-level delete already did).
- **Packet truncation disclosure** (9): `KnowledgePacket` carries `truncated`,
  `totalCandidates`, `droppedCount`, mirroring the home-graph packet.
- **Enrichment off the source row** (10): the semantic-enrichment cache stamp moved from
  `knowledge_sources.metadata` to its own derived `knowledge_semantic_enrichment_state`
  record; sources stay append-only.
- **Unlink is a real reversal** (home-graph): `unlinkHomeGraphKnowledge` now removes the
  link edge (and, if the link itself materialized the target node and nothing else
  references it, that node too), and is an honest no-op on a never-linked target — no
  phantom records. It returns a `HomeGraphUnlinkResult` (`reversed`, `removedEdgeId`,
  `removedNodeId`).
- **Shared-artifact reset (Hazard H1)**: home-graph reset now scope-checks deletions — a
  blob explicitly owned by another knowledge family is preserved rather than deleted, so a
  reset cannot orphan another family's artifact reference. (Blobs are per-creation ids
  today, so this is defensive; the guard closes the documented hazard.)
- **Constructor family assert**: `KnowledgeStore` accepts a `family` (`wiki` /
  `home-graph` / `agent`) and asserts the resolved db file matches it, so a cross-family
  mis-wire fails loudly. The three SDK construction sites declare their family.

## Consumer notes (surface behavior changes)

- **`knowledge.search` / semantic ask** now return only `active` nodes (stale and draft
  excluded). Previously stale nodes leaked into `search`.
- **`queryNodes` / GraphQL `node`,`nodes` / `GET /api/knowledge/nodes`** hide `stale`
  (forgotten) nodes by default; pass `includeStale`/a status filter to see them.
- **`KnowledgePacket`** gained `truncated` / `totalCandidates` / `droppedCount`.
- **`HomeGraphService.unlinkKnowledge`** returns `HomeGraphUnlinkResult` (no longer a
  `HomeGraphLinkResult` with a soft-flagged edge).
- Existing active nodes are untouched (labelled `pre-gate` on first restamp). New
  synthesized nodes below the auto-accept threshold are held as `draft` until reviewed.
- The new `graph.nodes.history` / `graph.nodes.delete` / `graph.nodes.merge` /
  `graph.nodes.review` / `sources.delete` verbs are exposed on the in-process
  `knowledgeApi`; they are not (yet) added to the daemon HTTP method catalog.

## Not done (out of scope for this change)

Audit lows 11–15 (lint suppression, reindex partial-completion counts, opted-out
confidence omission, unearned baseline confidence, projection-index truncation) were not in
this change set.
