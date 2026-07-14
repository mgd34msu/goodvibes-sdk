/**
 * core-verbs.ts — the canonical operator-method verb vocabulary (see CHANGELOG 1.0.0).
 *
 * WHY THIS EXISTS: OPERATOR_METHOD_IDS (generated/operator-method-ids.ts) is a
 * flat list of dotted ids (`<namespace...>.<verb>`). Before this file, nothing
 * enumerated or constrained the verb vocabulary — every method-catalog author
 * picked whatever word felt right, which is how an audit found three
 * worst-class collisions on the word "schedule", a redundant lifecycle pair
 * (`enable`/`disable` duplicated by `pause`/`resume`), and an update-verb split
 * (`patch` vs `update`). This module is the forcing function that keeps that
 * from recurring: CORE_VERBS is the closed vocabulary for generic lifecycle
 * operations, BANNED_VERBS are verbs that were retired and must never
 * reappear, and EXEMPT_VERB_CATEGORIES documents the (large, expected) set of
 * domain-specific verbs that aren't generic CRUD/lifecycle words — things like
 * `voice.stt`, `homeassistant.homeGraph.askHomeGraph`, or `telemetry.otlp.logs`
 * are real, single-purpose operations, not a coherence bug.
 *
 * NAMESPACE RULE: a resource family name is the plural noun the family
 * manages (`tasks`, `sessions`, `schedules`, `watchers`); verbs attach
 * directly to it (`tasks.list`, `tasks.get`). The ONE exception is a
 * documented, reusable pattern — not ad hoc: when a family already has both a
 * per-item action surface AND a collection surface, and giving both the same
 * plural name would be ambiguous about which one an action targets, the
 * per-item family takes the SINGULAR form and the collection keeps the
 * PLURAL. `knowledge.schedule.get/save/delete/enable` (singular — acts on one
 * schedule) alongside `knowledge.schedules.list` (plural — the collection) is
 * the canonical example. Do not introduce this split defensively "for
 * symmetry" on a family that only ever has one shape — `automation.schedules.*`
 * has no singular sibling because nothing needs one yet.
 *
 * CONFORMANCE: see test/core-verbs-conformance.test.ts, which lints every id
 * in OPERATOR_METHOD_IDS against this file: each verb tail must be in
 * CORE_VERBS, in one of EXEMPT_VERB_CATEGORIES, or the test fails and names
 * the offending id — a new ad hoc verb cannot land silently. BANNED_VERBS are
 * asserted absent outright, so a retired verb can never come back under the
 * same tail.
 */

/**
 * The canonical generic-lifecycle verb vocabulary. Every operator method
 * whose action is a generic CRUD/lifecycle operation (not a bespoke,
 * domain-specific action) must use one of these exact words as its id's final
 * dotted segment.
 */
export const CORE_VERBS = [
  // Collection / item reads
  'list',
  'get',
  'search',
  'snapshot',
  'status',
  // Writes
  'create',
  'update',
  'delete',
  'upsert',
  'set',
  // Lifecycle
  'enable',
  'disable',
  'close',
  'reopen',
  'cancel',
  'run',
  'retry',
  // Cross-cutting / transport
  'invoke',
  'stream',
  'register',
] as const;

export type CoreVerb = typeof CORE_VERBS[number];

/**
 * Verbs that were retired by the core-verb ruling (see CHANGELOG 1.0.0) and
 * must never reappear as a method id's final dotted segment. A verb lands
 * here (instead of just being deleted from history) so the conformance test
 * keeps banning it even if someone re-adds it later without knowing why it
 * was removed.
 *
 * - `patch` — retired in favor of `update` (automation.jobs.patch ->
 *   automation.jobs.update, routes.bindings.patch -> routes.bindings.update,
 *   watchers.patch -> watchers.update). `update` is the one
 *   canonical partial-mutation verb; `patch` mirrored the HTTP-verb name
 *   (PATCH) instead of the operator-method vocabulary in these three places —
 *   the HTTP method on the descriptor is unaffected, only the id's verb tail
 *   changed.
 * - `pause` / `resume` — retired as a byte-identical redundant lifecycle pair
 *   with `enable`/`disable` (automation.jobs.pause/resume -> deleted;
 *   same `{id, enabled}` output shape, same semantics). A caller-facing
 *   "pause"/"resume" user verb should map onto `disable`/`enable` at the wire.
 */
export const BANNED_VERBS = ['patch', 'pause', 'resume'] as const;

export type BannedVerb = typeof BANNED_VERBS[number];

/**
 * Domain-specific verbs that are NOT part of the generic lifecycle vocabulary
 * but are legitimate, real operations — not a coherence bug. Grouped by
 * category with a one-line reason each, rather than one entry per id, because
 * the catalog has ~300 methods across a dozen unrelated domains (calendar,
 * channels, home automation, knowledge, media, telemetry, voice, ...) and
 * requiring an individual justification per verb would make the exemption
 * list an unmaintainable copy of the catalog itself. The categorization is
 * still a real constraint: a verb tail that matches none of CORE_VERBS and
 * none of these categories' listed verbs fails the conformance test — a
 * genuinely new ad hoc verb has to either fit an existing category, join
 * CORE_VERBS with a decision record, or get its own category here.
 */
export const EXEMPT_VERB_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  'external-api-mirror': [
    // Verbs that mirror an external vendor's own API vocabulary (Home
    // Assistant's homeGraph.* actions, calendar ICS import/export). Renaming
    // these to the core vocabulary would obscure the 1:1 mapping to the
    // vendor operation they wrap.
    'askHomeGraph', 'browse', 'export', 'generateHomeGraphPacket', 'generateRoomPage',
    'import', 'ingestHomeGraphArtifact', 'ingestHomeGraphNote', 'ingestHomeGraphUrl',
    'linkHomeGraphKnowledge', 'listHomeGraphIssues', 'map', 'refreshDevicePassport',
    'reset', 'reviewHomeGraphFact', 'syncHomeGraph', 'unlinkHomeGraphKnowledge',
  ],
  'media-and-voice-io': [
    // Single-purpose media/voice operations named for what they produce, not
    // a generic CRUD shape.
    'analyze', 'generate', 'transform', 'writeback', 'stt', 'tts', 'session',
  ],
  'maintenance-and-indexing': [
    // Index/derived-state maintenance actions (knowledge and home-graph
    // reindexing, memory vector rebuilds) — a maintenance operation on
    // derived state, not a CRUD action on the record itself.
    'reindex', 'rebuild',
  ],
  'transport-and-protocol': [
    // Endpoints whose name is a protocol/transport concept, not a resource
    // verb (auth, OTLP ingestion, contract introspection, GraphQL execution).
    'login', 'current', 'contract', 'schema', 'execute', 'logs', 'metrics', 'traces', 'web',
  ],
  'relay-step-up-ceremony': [
    // The relay WebAuthn step-up ceremony: `mint` issues a single-use challenge a
    // surface signs with a passkey before a mutating relay call — named for the
    // cryptographic act, not a generic CRUD lifecycle. (Credential `register` is
    // already a CORE_VERB.)
    'mint',
  ],
  'ingest-and-content': [
    // Content-shaped verbs describing what is being brought in or produced,
    // not a generic lifecycle action.
    'artifact', 'bookmarks', 'browserHistory', 'connector', 'url', 'urls', 'packet',
    'lint', 'materialize', 'render', 'query', 'ask', 'decide', 'review',
  ],
  'approval-and-routing': [
    // Domain verbs specific to the approvals/routing/session-target model.
    'approve', 'claim', 'deny', 'default', 'named', 'assign', 'resolve', 'authorize',
    'audit', 'edit', 'diff', 'restore', 'revoke', 'rotate', 'disconnect',
  ],
  'session-and-work-lifecycle': [
    // Session/task-graph-specific state transitions that are not the generic
    // enable/disable/cancel vocabulary (they carry session semantics:
    // steering a live turn, delivering an out-of-band input, etc).
    'detach', 'followUp', 'deliver', 'steer', 'reorder', 'clearCompleted', 'record',
    'evaluate', 'send', 'read', 'save',
  ],
  'reporting-and-diagnostics': [
    // Read-shaped diagnostic/reporting endpoints named for their specific
    // report, not a generic "get"/"list". `report` is the feature-flag
    // graduation report (flags.graduation.report) — a whole-report read whose
    // shape (per-flag state + evidence + release-blocker list) is a named
    // report, not a generic get of one record.
    'doctor', 'stats', 'capacity', 'settings', 'catalog', 'reject', 'review-queue', 'report',
  ],
  'memory-record-store': [
    // The daemon-owned canonical memory store mirrors the MemoryStore engine's
    // own long-standing API verbs rather than the generic CRUD words. `add`
    // (MemoryStore.add stamps a new record at the recall-confidence floor — the
    // recall-honesty contract is written in terms of `add`, not `create`) and
    // `update-review` (mutates ONLY a record's review signal —
    // reviewState/confidence/reviewer/staleReason — a narrower, honesty-load-
    // bearing operation than a generic `update` that would also touch content).
    // `search-semantic` is the store's scored semantic-ranking read (returns
    // distance/similarity/score), a distinct engine verb from the literal `search`
    // (a CORE verb) it sits beside — the MemoryStore engine has always exposed
    // searchSemantic separately, so the wire mirrors that name rather than folding
    // it into a flag on `search` whose output shape differs.
    'add', 'update-review', 'search-semantic',
  ],
  'push-delivery': [
    // Browser-push delivery action: `verify` sends a live test notification to
    // a stored subscription and returns an honest delivery receipt (proving the
    // encryption + endpoint round trip). It is a single-purpose delivery probe,
    // not a generic read/lifecycle word — the subscription lifecycle itself uses
    // core verbs (push.subscriptions.create/list/delete, push.vapid.get).
    'verify',
    // `reconcile` is the self-heal-on-open action: the client presents its
    // device identity + current endpoint and the daemon heals a stale record in
    // place, reporting what drifted. It is a state-reconciliation verb (like a
    // terraform apply), not a plain create/update — a new subscription still
    // uses the core `create` verb.
    'reconcile',
  ],
  'pairing-tokens': [
    // Per-pairing operator token lifecycle. list/create/delete are core verbs;
    // these are not generic CRUD words: `rename` sets ONLY the user-visible
    // device label (a single-field relabel, not a general resource update),
    // `migrate` moves a client off the legacy single shared token onto its own
    // per-device token (an honest one-time hand-off), and `revokeShared` turns
    // the legacy shared token off entirely (a one-way switch, distinct from
    // deleting a per-device token).
    'rename', 'migrate', 'revokeShared',
  ],
  'pairing-handoff': [
    // The pairing hand-off bundle (pairing.handoff.create / .complete): one
    // exchange carries the notifications/relay/passkey offer set. `create` is a
    // core verb; `complete` applies the surface's per-offer decisions in a
    // single pass — a multi-offer apply action, not a generic CRUD word.
    'complete',
  ],
  'worktree-lifecycle': [
    // worktrees.discard — the eviction-preserving removal (dirty state
    // committed onto the KEPT branch, directory removed, branch kept, honest
    // receipt). Deliberately NOT `delete`: delete implies the branch and the
    // work go away; discard keeps both recoverable.
    'discard',
  ],
  'rewind-safety': [
    // The unified message-anchored rewind (rewind.plan / rewind.apply): a
    // terraform-style dry-run/apply pair over the platform's existing history
    // stores. `plan` computes exactly what a rewind to a turn anchor would
    // change and mints a single-use confirm token (read-only); `apply` consumes
    // it to restore files and/or conversation, recording an undo point so the
    // rewind is reversible. Not generic CRUD/lifecycle words — a safety-gated
    // whole-session rewind surface, sibling to checkpoint-restore-safety.
    'plan', 'apply',
  ],
  'hunk-revert-safety': [
    // Per-hunk reverse-apply on the live working tree (checkpoints.revertHunkPreview /
    // checkpoints.revertHunk): the comment-on-hunk review surfaces hand back ONE
    // unified-diff hunk and ask for exactly it to be undone. `revertHunkPreview`
    // validates the hunk still reverse-applies cleanly and mints a single-use
    // confirm token (read-only); `revertHunk` consumes it to snapshot-then-reverse-
    // apply that one hunk, emitting a receipt. Not generic CRUD/lifecycle words —
    // a safety-gated per-hunk workspace mutation, sibling to checkpoint-restore-safety.
    'revertHunk', 'revertHunkPreview',
  ],
  'checkpoint-restore-safety': [
    // Server-side confirmation preview for the destructive checkpoints.restore:
    // checkpoints.restorePreview computes what a restore would change and mints
    // a short-lived, single-use confirmToken authorizing the matching restore.
    // Read-only (no workspace rewrite) — a distinct verb from `restore` so the
    // preview can hold read scope while restore keeps write scope. Not a generic
    // CRUD/lifecycle word: it is a safety-gate operation specific to the
    // whole-workspace rewind surface.
    'restorePreview',
  ],
  'best-of-n-attempts': [
    // Best-of-N sibling attempts on the fleet surface (fleet.attempts.pick /
    // fleet.attempts.judge; fleet.attempts.list uses the core `list`). `pick`
    // accepts one attempt as the winner (merging it, cleaning the losers);
    // `judge` runs a model to PROPOSE a winner with reasons (clearly model
    // judgment, never an auto-pick unless opted in). Not generic CRUD/lifecycle
    // words — a best-of-N resolution surface over held-merge candidate groups.
    'pick', 'judge',
  ],
  'fleet-archive': [
    // Session-scoped fleet archive transitions (runtime/fleet/archive.ts):
    // moving a FINISHED process subtree out of the live fleet view and back.
    // Not generic record CRUD — archive/unarchive gate on all-terminal
    // subtrees and never delete anything; archiveFinished is the bulk form
    // over every fully-finished root. The archived-collection read uses the
    // core verb (fleet.archived.list).
    'archive', 'unarchive', 'archiveFinished',
  ],
  'process-control': [
    // OS/service process lifecycle verbs (distinct domain from
    // enable/disable, which toggle a *record's* activation state) plus
    // reload (re-read a live config from disk — a process action, not a
    // record lifecycle transition).
    'install', 'restart', 'start', 'stop', 'uninstall', 'open', 'reload',
  ],
  'legacy-verb-aliases': [
    // KNOWN, OUT-OF-SCOPE minor inconsistency (not one of the ranked
    // worst-class collisions): mcp.servers.remove means exactly what `delete`
    // means everywhere else in the catalog. Flagged here rather than fixed,
    // per the scope discipline of fixing only the ranked worst-class
    // items (schedule/memory/tasks/session-orphan/sessions-visibility) —
    // renaming every already-consistent-but-differently-worded single
    // outlier was explicitly out of scope for this pass. A
    // future pass can fold this into `delete`.
    'remove',
  ],
} as const;

/** Flattened set of every exempt (non-core, non-banned) verb, for fast lookup. */
export const EXEMPT_VERBS: ReadonlySet<string> = new Set(
  Object.values(EXEMPT_VERB_CATEGORIES).flat(),
);

/**
 * Classify a single operator-method id's verb tail (its final dotted
 * segment) against the vocabulary.
 */
export type VerbClassification =
  | { readonly kind: 'core'; readonly verb: CoreVerb }
  | { readonly kind: 'exempt'; readonly verb: string; readonly category: string }
  | { readonly kind: 'banned'; readonly verb: BannedVerb }
  | { readonly kind: 'unclassified'; readonly verb: string };

export function verbTailOf(methodId: string): string {
  const segments = methodId.split('.');
  return segments[segments.length - 1] ?? methodId;
}

export function classifyVerb(methodId: string): VerbClassification {
  const verb = verbTailOf(methodId);
  if ((BANNED_VERBS as readonly string[]).includes(verb)) {
    return { kind: 'banned', verb: verb as BannedVerb };
  }
  if ((CORE_VERBS as readonly string[]).includes(verb)) {
    return { kind: 'core', verb: verb as CoreVerb };
  }
  for (const [category, verbs] of Object.entries(EXEMPT_VERB_CATEGORIES)) {
    if (verbs.includes(verb)) {
      return { kind: 'exempt', verb, category };
    }
  }
  return { kind: 'unclassified', verb };
}
