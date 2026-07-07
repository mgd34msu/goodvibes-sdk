# Home Graph LLM issue triage + conversation stream deltas

Date: 2026-07-07
Status: accepted
Area: `packages/sdk/src/platform/knowledge/home-graph`, `packages/sdk/src/platform/companion`, `packages/sdk/src/platform/daemon`

## Context

Two additions complete the Home Assistant track.

1. The Home Assistant integration carries a Python "triage engine"
   (`custom_components/goodvibes/frontend.py`) that lists open Home Graph device-quality
   issues, asks an LLM to classify each as reject/review, auto-applies confident rejects,
   and caches decisions so unchanged issues are not re-sent. A capability comparison
   (`goodvibes-homeassistant/docs/triage-engine-comparison.md`) showed the SDK already owns
   issue generation, the reject→fact mapping (`review.ts` `deriveIssueFacts`), the
   `facts/review` target, and generation-side dedupe. The genuine delta the SDK lacked: the
   LLM-driven triage loop itself, a confidence threshold on its output, a triage-decision
   cache (distinct from the generation-side fingerprint), and a way to extend triage beyond
   the two hardcoded issue codes.

2. `homeassistant-routes.ts` `streamConversation` emitted a single terminal SSE frame after
   the whole turn completed. The integration now consumes SSE deltas, so the route must emit
   incremental frames as the model streams while keeping the terminal frame contract.

## Decisions

### 1. Triage is a new mode of the existing `homeGraph.refinement.run` verb, not a new verb

`runHomeGraphRefinement` gained two optional inputs — `triage` (`true` or a
`HomeGraphTriageOptions` object) and `skipGapRefinement`. When `triage` is set it runs the new
loop; existing callers (no `triage`) get byte-identical gap-refinement behavior, including the
unchanged "Semantic refinement is not configured" error path. The HTTP route already spreads
the request body into `runRefinement`, so no route change was needed. The Home Assistant
integration replaces its Python engine by calling
`POST /refinement/run` with `{ triage: {...}, skipGapRefinement: true }`.

### 2. The loop lives in `home-graph/triage.ts` and reuses existing plumbing

`runHomeGraphIssueTriage` lists open triageable issues in the resolved HA space, joins each
with its node + Home Assistant metadata into a compact record (parity with the Python
`_triage_issue_record`), batches them (default 25), and prompts through
`KnowledgeSemanticService.llm` — a new narrow getter that exposes the already-configured
semantic LLM the same way `enrichment.ts`/`answer-llm.ts` use it, so triage shares the one
model route instead of re-plumbing a provider registry. Confident rejects are applied through
the existing `reviewHomeGraphFact`, which already derives `{batteryPowered:false,...}` /
`{manualRequired:false}` facts — no duplication of that mapping.

### 3. Confidence threshold reuses the `gap-repair.minConfidence` precedent

Default auto-apply threshold is `85` on the SDK's 0–100 confidence scale
(`HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE`), mirroring the Python `0.85` gate and the
`WebGapRepairOptions.minConfidence` idiom. Model output is normalized to accept both the 0–1
fraction the Python engine used and the 0–100 scale. Only `action:"reject"` at or above the
threshold is auto-applied; everything else is left open for a human.

### 4. Triage-decision cache lives on the issue metadata

Each decided issue records `metadata.triage = { fingerprint, action, category, confidence,
reason, applied, source, decidedAt }`. The fingerprint hashes the issue's identity plus its
node's salient fields. On re-run, an issue whose fingerprint is unchanged (and `force` is not
set) is skipped — no model spend. Because `upsertIssue` shallow-merges metadata, the quality
refresh (`replaceIssues`) preserves the cache, and an applied reject (resolved by
`reviewFact`) keeps its provenance. This is the "already triaged this open issue" guarantee
the generation-side fingerprint never provided.

### 5. Extensible issue-code → rule framework

`HomeGraphTriageRule` (code + prompt guidance + default category) replaces the two hardcoded
codes. `DEFAULT_HOME_GRAPH_TRIAGE_RULES` reproduces the Python judgment for `unknown_battery`
and `missing_manual`; `additionalRules` merges new codes over the defaults by code. Only issues
whose code has a rule are triaged.

### 6. The family wall holds by construction and by scoping

Mike's ruling: the home-graph must stay a separate part of the knowledge/wiki function so Home
Assistant never bleeds into tui/agent knowledge. Two independent guarantees:

- **By construction:** the home-graph, general wiki, and agent-ops knowledge are separate
  `KnowledgeStore` instances over separate SQLite files. Triage only ever holds the home-graph
  store handle; it has no reference that could reach another store.
- **By scoping:** even within a single store, triage resolves one HA space
  (`resolveReadableHomeGraphSpace`) and reads/writes only that space (`readHomeGraphState`,
  `reviewHomeGraphFact`, space-scoped `upsertIssue`). A wall proof test seeds a non-HA space
  with an issue carrying the *same* triageable code and asserts, byte-for-byte, that the HA
  triage run leaves that space untouched and never lists its issue in the decision set.

Triage shares code with the wiki/agent knowledge functions; it never shares their data.

### 7. Conversation stream deltas bridge existing turn events

`CompanionChatManager._runTurn` already publishes `turn.delta`/`turn.completed`/`turn.error`
to the gateway. Rather than wiring a gateway subscription into the HA route, an optional
in-process `onTurnEvent` tap threads through `postMessageAndWaitForReply` →
`_postMessageInternal` → `_runTurn`'s `publish` closure (isolated: a throwing listener cannot
break the turn). `postHomeAssistantChatMessage` forwards it; `streamConversation` passes a tap
that maps each `turn.delta` to an incremental SSE `delta` frame carrying the chunk plus the
running accumulation. The terminal `final`/`error` frame is emitted exactly as before, so older
consumers that ignore `delta` events are unaffected. `companion-chat-manager.ts` sat one line
under its grandfathered line cap; the added plumbing was offset by tightening non-load-bearing
JSDoc so the file stayed under the cap.

## Consequences

- `bundle-budgets.json` `./platform/knowledge/home-graph` budget rises 192 → 411 B gzip: the
  triage module is now reachable from `HomeGraphService`. Deliberate, re-justified per the
  registry's headroom formula.
- The triage surface is intentionally NOT added to the public `./platform/knowledge/home-graph`
  subpath barrel; it is reached via `runRefinement`/the HTTP verb and internal imports, keeping
  the public facade and its size budget unchanged.
- The Home Assistant integration can now delete its local Python triage engine (§1 + §2 of the
  comparison doc) once it adopts the daemon capability. See the adoption note below.

## Home Assistant integration adoption note

When the integration adopts this (its own follow-up), replace `_async_triage_home_graph_issues`
with a single call:

- `POST /api/homeassistant/home-graph/refinement/run?installationId=<id>` with body
  `{ "triage": { "minConfidence": 85, "limit": 25, "chunkSize": 25, "force": false,
  "skipIssueIds": [], "reviewer": "homeassistant:auto-triage" }, "skipGapRefinement": true }`.
- Response `triage`: `{ ok, spaceId, configured, processed, skipped, applied, reviewed,
  decisions[], remaining, minConfidence, reason? }`. `configured:false` +
  `reason:"triage-llm-not-configured"` means the daemon has no semantic LLM — keep the local
  engine as fallback until the daemon capability is default.
- The following Python can then be deleted: the prompt (`_triage_prompt`), decision parsing
  (`_parse_triage_decisions`), the confidence gate + `facts/review` auto-apply loop, the
  `_semantic_review_value` fact special-casing (the SDK's `deriveIssueFacts` covers it), and the
  entire Store-backed triage fingerprint cache (`_async_load/save_triage_cache`,
  `_triage_cache_matches`, `_remember_triage_decisions`) — the SDK now owns the decision cache.
- Retain only the Home-Assistant-surface glue: reading HA registries for entity/device/area ids
  and syncing them into `node.metadata.homeAssistant` (the SDK stores, but does not read, HA
  registries).
- Gate the switch behind a daemon capability check so older daemons keep working; the daemon
  advertises triage via the `refinement/run` `triage` input.
