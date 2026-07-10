# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [X.Y.Z]` section here before publishing — the publish script and CI enforce this.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

### Added

- **Session-scoped permission mode and context usage on the operator wire.**
  Three new daemon gateway verbs let a remote surface (webui) read and write a
  session's permission mode and read its context-window pressure, instead of
  only touching the daemon-wide `permissions.mode` config the way it did
  before while the in-process TUI saw per-session state. `sessions.permissionMode.get`
  and `sessions.permissionMode.set` speak an operator vocabulary
  (`plan`/`normal`/`accept-edits`/`auto`, plus a read-only `custom`) mapped onto
  the internal config modes; a set flows to every surface as a
  `runtime.permissions` `PERMISSION_MODE_CHANGED` event via the already-wired
  mode-change binding, and reports the `previousMode` it replaced.
  `sessions.contextUsage.get` returns `estimatedContextTokens` (the token
  estimator's figure, flagged `estimated: true` — never presented as a measured
  provider count), the model `contextWindow`, and the derived `contextUsagePct`
  and `contextRemainingTokens` from the one shared `deriveContextUsage` helper
  the in-process context chip also uses. All three answer only for the live
  local runtime the daemon hosts; any other session id is an honest 404
  (`SESSION_NOT_LOCAL`). Verbs land with typed IO and register together with
  their descriptors, so none is a cataloged-but-unhandled 501.
- **A local-first MCP (Model Context Protocol) server that exposes the operator
  surface.** New `@pellux/goodvibes-sdk/platform/mcp/server` generates MCP tool
  definitions from the operator catalog (every cataloged, invokable operator
  method becomes one tool, its dotted method id mapped to an MCP-safe name and
  its operator input schema carried over verbatim) rather than hand-writing
  them, so the tools an external agent tool sees can never drift from the
  daemon's contract. The session lifecycle methods — create, attach
  (`sessions.get`), send a message (`sessions.messages.create`), read a
  transcript (`sessions.messages.list`), and steer a live turn — are lifted to
  the front as first-class tools. The server speaks JSON-RPC 2.0 over a
  newline-delimited (stdio) transport with no external MCP dependency, and
  dispatches every `tools/call` through an injected invoker, so the transport
  that reaches the daemon is the consumer's choice. `createOperatorMcpServer({
  contract, invoke })` builds a ready-to-serve server; `buildOperatorMcpTools`
  exposes the generator on its own.
- **The single canonical skill service, hoisted into the SDK.** New
  `@pellux/goodvibes-sdk/platform/skills` owns one skill model (Markdown with
  YAML-style frontmatter), one progressive-disclosure read path (a cheap index
  line — name + description + metadata, no body — loaded for every skill, the
  full body read only for the one skill invoked), and one CRUD surface over an
  injectable store (a filesystem store of `<name>.md` documents and an in-memory
  store ship in the box), so consumers stop each carrying their own drifting
  copy. Exposed over the operator surface as five new daemon gateway verbs —
  `skills.list`, `skills.get`, `skills.create`, `skills.update`, `skills.delete`
  — with typed IO, honest absence (`skills.get`/`skills.update` 404 when the
  skill does not exist; `skills.delete` returns `{ deleted: false }` rather than
  pretending a phantom skill was removed), and a name-conflict 409 on create.
  The verbs' handlers register together with their descriptors, so a skills verb
  is never a cataloged-but-unhandled 501.

- **`repo_map` tool — a model-invoked, token-budgeted repository map.** A new
  read-only tool the model CALLS (never passive always-on injection) to orient in
  an unfamiliar codebase: it returns a per-directory source-file count plus the
  highest-centrality source files — ranked by how many other files import them
  (import-graph centrality), with file size as a tie-break — and each key file's
  top-level exported symbols. It takes `{ path?, budgetTokens? }` and caps output
  to the token budget, omitting lower-ranked files once the budget is reached. It
  reuses the SDK's existing `ImportGraph` plus a cheap export regex — no
  tree-sitter, no LLM, no process spawn. Registered with the tool registry and
  classified read-only so it auto-approves in prompt mode. As part of this, the
  `ImportGraph` specifier resolver now maps a `.js`/`.jsx`/`.mjs`/`.cjs` import
  specifier to its TypeScript sibling (`./core.js` → `core.ts`), so import edges
  resolve in TS-ESM projects instead of silently dropping — which also sharpens
  the edit tool's downstream import-graph warning.
- **Post-edit diagnostics in tool results.** After a successful, non-dry-run
  file write or edit, the tool result now carries cheap, in-process diagnostics
  for the touched file so the model sees a broken edit immediately instead of on
  a later build. The first (and only bundled) provider is tree-sitter-backed
  SYNTAX diagnostics for TypeScript/JavaScript — in-process, no process spawn, no
  type checking — and it only runs when a TS/JS project context (tsconfig.json /
  jsconfig.json) is detectable; otherwise it appends nothing (honest absence, not
  a fabricated "no errors"). The write tool attaches a structured `diagnostics`
  array to its JSON output; the edit tool appends a compact text block (its output
  already carries text suffixes). A `DiagnosticsProvider` interface is the seam a
  host can later implement with a full type-checking provider. Config key
  `diagnostics.postEdit` (`'on'` default | `'off'`) — default on because the
  bundled provider is cheap and never spawns a process.
- **Background agents respect the session permission mode.** A background /
  subagent's tool calls now run through the same permission layer as the
  foreground turn loop instead of executing ungated. Each call the agent runner
  makes is brokered through the configured session mode (`permissions.mode`):
  `allow-all` changes nothing (zero new friction for autonomous runs);
  `prompt`/`custom` ask via the same approval broker the foreground uses — so a
  background ask surfaces through the existing blocked-on-user machinery, now
  carrying the subagent's attribution (agent id + template) on the
  `PermissionPromptRequest`; `plan` and `accept-edits` apply their matrices; and a
  refusal returns the structured `ToolDenial` on the failed `ToolResult` so the
  subagent continues and reports honestly. A new escape-hatch config key
  `permissions.backgroundAgents` (`'inherit'` default | `'allow-all'`) lets a user
  deliberately exempt background agents from the gate.
- **Fleet lifecycle events + attention state (poll-free fleet).** The live
  process registry now surfaces changes as events instead of poll-only snapshots.
  (1) A new `fleet` runtime-event domain carries per-node lifecycle deltas —
  `FLEET_NODE_STARTED`, `FLEET_NODE_STATE_CHANGED`, `FLEET_NODE_FINISHED`,
  `FLEET_NODE_BLOCKED_ON_USER`, `FLEET_NODE_UNBLOCKED` — emitted by a bridge that
  diffs the registry's coalesced snapshots (seeds silently on first snapshot; never
  infers finish from absence). The control-plane gateway already fans this domain
  out to subscribed SSE/WebSocket clients, so surfaces can stop polling
  `fleet.snapshot` with no gateway change. (2) A `ProcessNode` blocked on a human
  (a pending shared approval) now carries a derived `needsAttention` marker with
  its reason — a pure projection of state, recomputed each tick, never a second
  store. (3) A new `needs-input` push category (typed `PushNotificationData`
  payload) fires when a node blocks on the operator, carrying a session/node deep
  link, and is suppressed when an operator surface is already attached to that
  session (presence). Emit-side only; consumer surfaces adopt the stream separately.
- **Structured tool-call denials.** A tool call refused by the permission layer
  now returns a structured, call-scoped `ToolDenial` (`{ denied, reason, scope }`)
  on the failed `ToolResult`, plus a self-explaining error string naming the reason
  code and decision scope — never a hung promise or a bare "Permission denied"
  line. Both the phased executor's permission phase and the main orchestrator
  tool-runtime path populate it, so an asking agent (including a background
  subagent) can continue and report honestly instead of guessing.
- **Server-side confirmation for `checkpoints.restore`.** The daemon now refuses
  an unconfirmed restore instead of executing it immediately. A caller supplies
  either `confirm: true` (explicit acknowledgment) or a `confirmToken` from the
  new `checkpoints.restorePreview` verb. `restorePreview` is read-only: it
  returns a preview of what a restore would change (checkpoint label, affected-
  path count + sample, diffstat) plus a short-lived (~2 min), single-use token
  that authorizes the matching restore. An unconfirmed `checkpoints.restore`
  returns a structured, non-destructive refusal body (`result: null,
  refused: true, refusal: {...}` naming both options) — a 200, not an error.
  MIGRATION: existing callers that already gate restore behind their own UI
  confirm add exactly one field, `confirm: true`, to their restore invocation;
  no preview round-trip is required. `checkpoints.restore`'s output gained
  `refused`/`refusal` and its `result` is now nullable.

### Changed

- **Typed-IO coverage ratchet.** A new `contracts:check` gate
  (`scripts/check-foundation-io-coverage.ts`) freezes the number of operator
  methods that lack typed `OperatorMethodInputMap`/`OperatorMethodOutputMap`
  entries (currently 97 of 334) at a checked-in baseline and fails if it grows,
  printing the missing method ids. New methods must ship with typed IO. This is
  a growth freeze, not a burndown of the existing 97.

## [1.6.1] - 2026-07-09

### Fixed

- The fleet archive verbs (`fleet.archive`, `fleet.unarchive`,
  `fleet.archiveFinished`, `fleet.archived.list`) now carry real
  `OperatorMethodInputMap`/`OperatorMethodOutputMap` entries in the contracts
  package, so remote clients (webui) get typed inputs/outputs instead of the
  `unknown` fallback. The hand-authored-IO-types drift gate
  (`check-foundation-io-types.ts`) covers them.

## [1.6.0] - 2026-07-08

### Added

- **Reactive compact-and-retry in the main session.** When a provider rejects
  a request as exceeding the context window (e.g. openai-codex
  `context_length_exceeded`), the main turn loop now compacts immediately and
  retries the request once — previously it printed "Run /compact" and failed
  the turn. A second rejection in the same turn still surfaces as an error.
- **Learned (observed) context ceilings.** That same rejection teaches the
  registry the endpoint's REAL limit: the rejected request's size is recorded
  per model (persisted alongside user overrides in
  `context-window-overrides.json`) and applied with new provenance
  `observed_limit` whenever it is smaller than the catalog window — so
  compaction thresholds, meters, and the model picker stop trusting
  over-stated catalog values (a catalog can claim 1M where the subscriber
  endpoint enforces ~250k). Self-correcting in both directions: smaller
  rejections lower it, successful requests with larger real billed input
  raise it. New registry APIs: `getObservedContextWindow`,
  `recordContextWindowRejection`, `reconcileObservedContextWindow`;
  `clearModelContextCap` now clears the learned limit too. Agent runs record
  rejections the same way.
- **Fleet archive.** `withFleetArchive(processRegistry)` (applied to the
  runtime's registry) moves FINISHED process subtrees out of the live fleet
  view into a session-scoped archive: `archive(id)` / `unarchive(id)` /
  `archiveFinished()` / `listArchived()` / `archivedCount()`. Only
  all-terminal subtrees can be archived — a finished member of a running
  swarm stays visible. Archived nodes remain fully inspectable. New
  control-plane verbs for remote surfaces (webui): `fleet.archive`,
  `fleet.unarchive`, `fleet.archiveFinished`, `fleet.archived.list`.

### Fixed

- **Agent-completion replay messages no longer repeat.** The event replay
  queue's acknowledgment hooks were never called, so every tracked event
  (agent completed/failed, WRFC state changes) was re-injected into the
  conversation three times with escalating `[Replay][URGENT]` tags long
  after the agent finished. Injection now acknowledges the event — each
  event reaches the conversation exactly once, one turn after it fires.

## [1.5.0] - 2026-07-08

### Added

- **A compaction warning from the model triggers immediate auto-compaction,
  regardless of estimated context usage.** When a provider response reports
  that the model's context window filled up (Anthropic stop reason
  `model_context_window_exceeded`, or raw values like
  `context_length_exceeded` from openai-compatible servers), the orchestrator
  now compacts at the next opportunity — before the next chat call in a tool
  loop, or in post-turn maintenance — even when the local token estimate is
  below the configured threshold and even when the percentage threshold is
  disabled. The provider's own report is authoritative over local estimates,
  matching how the reactive strategy already treats prompt-too-long errors.
  Agent runs get the same behavior (structural compaction immediately after
  the warning response). Ops `OPS_CONTEXT_WARNING` events and compact hooks
  carry the new reason `model-warning`.
- New normalized stop reason `context_overflow` in `ChatStopReason`, plus
  `isContextOverflowSignal` and `CONTEXT_OVERFLOW_RAW_STOP_REASONS` exports
  from the providers module.
- **Persisted per-model context-window overrides.** `ProviderRegistry.setModelContextCap`
  now works for any model (cloud, catalog, custom, or discovered — previously
  local models only), and the override persists under the control-plane config
  dir (`context-window-overrides.json`), surviving restarts and applying to
  every consumer of the same home. New `clearModelContextCap` returns a model
  to its automatic window; new `getModelContextCap` reads the override.
  Overrides apply with provenance `configured_cap`, which remains
  authoritative in `getContextWindowForModel`. New exports:
  `MAX_CONTEXT_WINDOW_OVERRIDE`, `isValidContextWindowOverride`.

## [1.4.1] - 2026-07-07

### Fixed

- **Permission settings are now the authority for command-class risk in the
  exec tool.** The exec guard previously hard-denied every command it
  classified as destructive (`kill`, `killall`, `pkill`, `rm`, `truncate`) or
  escalation (`docker`, `kubectl`, `sudo`, `helm`, …) with
  `Command denied (baseline mode)` — unconditionally, ignoring the user's
  permission configuration entirely, and re-denying commands the permission
  layer had already approved (including explicit prompt approvals). A session
  with exec allowed could not kill a process or run `docker ps`. Class-level
  risk decisions now belong exclusively to the permission layer (mode
  `allow-all`, per-tool `allow`/`prompt`/`deny`, prompts, session approvals);
  the exec layer no longer gates by class in either baseline or AST mode.
- The only remaining unconditional exec-layer denial is a small, frozen
  catastrophic list (`catastrophicReason` in the command classifier): root
  filesystem deletion (`rm -rf /`, `rm --no-preserve-root`), raw disk
  destruction (`dd of=/dev/…`, `mkfs*`, `wipefs`, `shred /dev/…`, redirects
  onto raw disk devices), and fork bombs. Its denial message states the
  pattern that fired and that permission settings do not affect it. This list
  does not grow without an explicit owner decision.
- `guardExecCommand` now honors its `allowedClasses` parameter in baseline
  mode (previously it was consulted only in AST mode). New exports:
  `ALL_COMMAND_CLASSES` and `catastrophicReason` from the command
  normalization module.

## [1.4.0] - 2026-07-07

### Added

- **Server-side turn stop** (`companion.chat.turns.cancel`): a chat client's
  Stop button can now actually stop the daemon, not just its own rendering.
  The turn's provider stream is aborted through a per-turn controller (a stop
  never poisons the session's later turns), any non-empty partial reply is
  persisted honestly (`deliveryState: "cancelled"`, linked to its prompt via
  `inReplyTo`), announced-but-unresolved tool calls are closed with a
  synthetic error result, and the terminal `turn.cancelled` event reaches
  every subscriber of the session stream — a stop issued from one client
  converges on all others. Honest machine-readable refusals: 404
  `NO_ACTIVE_TURN` (benign — the turn finished first), 409 `TURN_MISMATCH`
  (a stale stop must not kill a newer turn); repeat cancels are idempotent.
- **Queue-when-busy sends**: a message posted while another turn is running
  now QUEUES — visible in the transcript immediately with
  `deliveryState: "queued"`, answered in order when the current turn ends —
  instead of racing a concurrent turn against the same conversation history
  (the previous behavior, which could garble a session's context).
- **Steer** (`companion.chat.messages.steer`): interrupt-and-send-now. The
  message jumps to the front of the pending queue and the active turn is
  cancelled through the same finalization path as an explicit stop, then the
  steered message's turn runs. Queued messages keep their places behind it.
- Assistant messages carry `inReplyTo` (the user message a reply answers):
  transcripts are append-ordered, so with queueing, position stops being a
  reliable pairing signal.
- The interrupted partial (plus an explicit model-facing interruption note)
  is committed to the conversation history, so later turns can reason about
  what the user saw and stopped — which is usually exactly what a follow-up
  or steer refers to.

### Fixed

- Closing a session (or daemon shutdown) mid-turn now finalizes the turn
  through the same cancellation path — honest partial persisted, terminal
  `turn.cancelled` emitted — instead of silently discarding the streamed
  content and leaving subscribers without a terminal event.
- The Home Assistant conversation cancel route stops the in-flight turn and
  keeps the session open (it previously closed the whole session — the only
  available hammer — so the next utterance silently lost its conversation
  context).

## [1.3.3] - 2026-07-07

### Fixed

- The platform-capability classification now recognizes the exact refusal
  message Apple's system SQLite emits ("does not support dynamic extension
  loading"), so macOS compiled binaries report the honest capability limit
  as intended by 1.3.2.

## [1.3.2] - 2026-07-07

### Fixed

- A platform that cannot load SQLite extensions at all (macOS system SQLite in
  a compiled binary) is now reported as an honest capability limit
  (`platformLimitReason` on the vector stats) instead of an error: the daemon
  boots cleanly, semantic memory search falls back to literal matching with the
  reason stated, and fault monitors and release smoke checks no longer fire on
  a condition that is not a fault. A genuinely missing extension file (a real
  packaging defect) still reports loudly as an error.

## [1.3.1] - 2026-07-06

### Fixed
- Test-run suppression no longer silences the terminal bell — it silences only
  desktop notifications and webhooks. The 1.3.0 guard made `notifyCompletion()`
  return early under `NODE_ENV=test` / `GOODVIBES_SUPPRESS_NOTIFY`, which also
  suppressed the in-process terminal bell (a single `\x07` byte to the current
  process's own stdout) that host surfaces rely on as product behaviour. The
  bell now always fires for turns over 5s; only the real `notify-send`/`osascript`
  desktop spawn and real webhook HTTP delivery remain suppressed under test.

## [1.3.0] - 2026-07-06

### Added
- **The knowledge wiki is now honest and compounding — no more silent
  overwrites, and only real evidence resolves an answer gap.** Every
  content-changing node upsert now preserves the prior content in an
  append-only revision history and records what changed, exposed through a read
  path (`listNodeRevisions` / `graph.nodes.history`); a slug- or kind-only
  identity change records a revision instead of dropping the prior identity.
  Activation is gated by a configurable auto-accept confidence threshold and
  always carries honest `reviewProvenance` (auto-accepted / reviewed /
  pending-review / pre-gate / explicit): below-threshold nodes are held as
  drafts and are not served until a `reviewNode` decision accepts them, while
  existing active nodes stay active (pre-gate). Search and the semantic index
  serve only active nodes, so a draft or a stale record can no longer surface as
  an answer. An answer gap resolves only from real repair evidence — a promoted
  fact or an accepted source, with a truthful reason — otherwise it stays open.
  Extractions now carry an `extractorVersion` stamped at the single
  `upsertExtraction` choke point, so advancing `KNOWLEDGE_EXTRACTOR_VERSION`
  re-processes older captures through the existing recompile job. See the
  decision record at `docs/decisions/2026-07-07-knowledge-wiki-honesty.md`.
- **The daemon now runs a model-routed, confidence-gated issue-triage loop over
  the Home Graph, and its data stays walled off from the general knowledge
  store.** The existing `homeGraph.refinement.run` verb gained `triage` and
  `skipGapRefinement` inputs: the loop lists open triageable device-quality
  issues in the resolved Home Assistant space, joins each with its node and Home
  Assistant metadata, asks the configured semantic model to classify each as
  reject or review, auto-applies rejects at or above a confidence threshold
  (default 85, reusing the gap-repair precedent), and records every decision
  with honest provenance. A per-issue decision cache (a fingerprint plus the
  decision) lives on the issue metadata, so a re-run never re-spends a model
  call on an unchanged open issue, and an issue-code-to-rule framework replaces
  the two previously hardcoded codes. The loop operates only on the home-graph
  store and the single resolved Home Assistant space; a proof test seeds a
  non-Home-Assistant space with the same issue code and asserts, byte for byte,
  that a triage run leaves it untouched — the home-graph, wiki, and agent
  knowledge functions share code but never share data, separate stores by
  construction. See the decision record at
  `docs/decisions/2026-07-07-home-graph-issue-triage.md`.
- **One voice across every surface: the voice settings now live in a shared,
  surface-independent place.** The text-to-speech settings (`tts.provider`,
  `tts.voice`, `tts.speed`, `tts.llmProvider`, `tts.llmModel`) read from and write
  to one neutral file, `~/.goodvibes/shared/settings.json`, instead of each
  surface's own settings folder. So a voice chosen in one place — terminal,
  desktop, or the agent — is the voice every surface uses, rather than each keeping
  its own. A surface that has never set a shared voice keeps using its local
  setting, so existing setups are unchanged; a shared value simply wins once one is
  set. `ConfigManager.describeConfigKeySource(key)` reports which layer a value came
  from (shared / project / global / default), so the resolution order is
  inspectable, not just documented. See the decision record at
  `docs/decisions/2026-07-06-shared-voice-config-tier.md`.
- **The knowledge packet now discloses when it was cut short, on the wire.** The
  `knowledge.packet` result carries `truncated`, `totalCandidates`, `droppedCount`,
  `droppedForBudget`, and `budgetExhausted`, so a preview of a capped packet can no
  longer read as the complete matched set. `droppedForBudget` / `budgetExhausted`
  separate candidates the token budget actually forced out from those left off by
  the item-count cap, so "N omitted to fit the budget" is only ever said when the
  budget was truly the limit.
- **A memory search result reports the recall confidence floor it was judged
  against.** The honest search envelope carries `recallFloor`, so a surface can
  state "below the N% recall floor" from the result instead of hardcoding the number
  and silently drifting if the floor is retuned.
- **Home Assistant conversations now stream incrementally instead of arriving all
  at once.** The `conversation/stream` route used to emit a single terminal SSE
  frame after the whole turn finished; it now bridges the chat manager's existing
  per-turn events into the stream and emits incremental delta frames — each
  carrying the new chunk and the running accumulation — as the model produces
  text. The terminal-frame contract is unchanged: exactly one final/error frame
  is still emitted last, so older consumers that ignore delta frames are
  unaffected. A throwing listener cannot break the turn.

### Fixed
- **A newer client against an older daemon that does not serve a memory
  operation now says so plainly, instead of reporting an existing record as "not
  found."** The wire client distinguishes the two kinds of 404 by response code:
  a record-missing 404 carries the shared `MEMORY_RECORD_NOT_FOUND` code and
  folds to `null`, while any other 404 — a route-not-found from an older daemon,
  or a bare legacy 404 with no code — is treated as method-unavailable and
  rejects honestly with the one canonical unavailable-verb message, never a
  silent `null`. This closes the version-skew path the memory-over-the-wire
  feature advertises. A shared `classifyMemoryWireError` discriminator is the
  single classifier the transports reuse. See the decision record at
  `docs/decisions/2026-07-06-memory-wire-full-detach.md`.
- **The memory recall-snapshot note now matches the established freshness
  vocabulary.** A stale snapshot reads "may be stale … 45s ago" (lowercase, hedged,
  whole seconds) rather than "STALE … 45000ms ago", matching the wording used
  elsewhere. The note also labels its record count honestly against how the snapshot
  was captured: an unfiltered browse capture is described as "in the browse set
  (unfiltered — recall floor not applied)" rather than mislabeled "recall-eligible",
  which only a recall-filtered capture earns.
- **A fresh daemon home's default model now resolves without waiting on the
  network.** The default `openrouter:openrouter/free` model only appeared in the
  registry once the models.dev pricing catalog had loaded over the network, so
  on a brand-new daemon home (or offline) `getCurrentModel()` threw and crashed
  `GET /api/providers/{id}/usage`. The provider registry now recognizes the
  well-known default directly — if the configured model belongs to a registered
  provider that already lists it, the registry synthesizes a minimal entry on
  the spot instead of waiting for the catalog — and the usage-snapshot builder
  degrades an unresolvable current model to an honest response rather than an
  unhandled exception. A genuinely wrong model reference still fails the same way
  as before, so this does not paper over real misconfiguration.
- **Test runs no longer fire real desktop notifications or webhook requests.**
  `notifyCompletion()` and the webhook notifier used to shell out to
  `notify-send` / `osascript` and post real webhook HTTP requests with fixture
  text under `bun test`. Both now no-op when `NODE_ENV==='test'` or
  `GOODVIBES_SUPPRESS_NOTIFY` is set, with a `force` opt-in for the tests that
  specifically exercise the delivery layer itself.

## [1.2.0] - 2026-07-06

### Added
- **Memory over the wire is now complete, so a client surface fully detaches from
  the store file.** The daemon's memory API gained the rest of the operations a
  surface needs: list/browse records, scored semantic search, edit a record's
  content or scope, read and create links between records, the review queue, and
  bundle export/import. Combined with the operations that already existed
  (add/search/get/review/delete), a surface adopted to a daemon now reaches ALL of
  its memory over the wire and never opens the database file — closing the last
  paths that still read a divergent local copy. Rebuilding the semantic index stays
  a host/admin action (the daemon keeps its own index current and offers an admin
  rebuild route) rather than a per-client operation, ruled explicitly. Semantic
  search accepts the same filters as literal search, and a result ranked without a
  vector match reports that honestly. Surfaces pinned to an older daemon that
  predates one of the new operations get a clear stated error, never a silent
  fall-back to the local file.
- **A synchronous prompt builder can inject fresh memory without blocking on the
  network.** Because per-turn recall reads memory over the wire (asynchronous) but
  the prompt is assembled synchronously, the memory client keeps a freshness-stamped
  snapshot: an async pre-turn refresh captures the recall-eligible records, and the
  synchronous prompt build reads the cached snapshot with an honest note about how
  old it is and where it came from. Before the first refresh the snapshot is empty
  and says so; past its freshness window it is flagged stale with a stated reason —
  never a silent empty that reads as "nothing was ever stored." See the decision
  record at `docs/decisions/2026-07-06-memory-wire-full-detach.md`.
- **One shared text-to-speech engine now powers every surface's spoken output.**
  The live speech pipeline — splitting a reply into sentences, batching and
  merging them into a bounded number of concurrent requests to the speech
  provider, retrying a failed request with backoff and honestly skipping ahead
  rather than losing the rest of the reply, and knowing when to let speech
  finish naturally versus cut it off immediately on interrupt — used to be
  copied by hand between the terminal app and the agent. It now ships once in
  the SDK behind a small pluggable interface (an "audio sink") that only has to
  play, stop, and report when it's drained; the terminal surfaces keep their
  existing subprocess-based audio players as sinks, unchanged, and a browser
  sink is documented so a browser-based build can speak with the exact same
  behavior. See the decision record at
  `docs/decisions/2026-07-06-spoken-turn-tts-policy-sdk-hoist.md`.

## [1.1.0] - 2026-07-06

### Added
- **Cross-surface memory served by the daemon** — the daemon now hosts the one
  canonical memory store and serves it over its HTTP API, so no surface (TUI,
  agent, or web UI) opens the memory database file directly; a client surface
  reads and writes memory over the wire instead. This closes a real corruption
  risk: the underlying store rewrites the whole file on every save with no
  locking, so two processes writing it directly could clobber each other. The
  same recall-honesty rules apply everywhere memory is reached — a search that
  can't consult its semantic index falls back to a plain scan and says so
  (never a silent empty result), and stale or contradicted records are excluded
  and counted rather than served quietly. Offline surfaces with no daemon keep
  working exactly as before, reading and writing their local store directly.
- **The daemon can now serve the web UI itself, same-origin or cross-origin —
  both off by default.** Turning on same-origin serving points the daemon at a
  built web UI bundle and it serves the app from its own address, so the
  browser never has to reach a different origin at all; the app still
  authenticates every API call with a token, so serving the bundle itself
  leaks no data. Turning on the separate cross-origin allowlist lets specific,
  explicitly listed origins (never a wildcard) call the daemon from elsewhere;
  requests from any other origin are refused. Neither setting changes any
  route's authentication or admin requirements, and the existing local-only
  default is unchanged unless one of these is turned on. See the decision
  records at `docs/decisions/2026-07-07-webui-cross-origin-deployment.md` and
  `docs/decisions/2026-07-07-web-push-subscriptions.md`.
- **Chat conversations support regenerate and edit-with-branching, with full
  history kept.** A user can now ask for a fresh answer to the same message, or
  edit an earlier message and continue from there. In both cases the earlier
  turns are marked as superseded and kept, never deleted, so the prior answer
  or original wording is always still there to look back on; a new answer is
  generated from the edited or retried point forward.
- **Browser push (Web Push) notifications** — a browser or installed web app
  can now subscribe to receive approvals and completions as push
  notifications, with a full subscribe/list/unsubscribe/test-send lifecycle.
  The daemon generates its own signing key the first time it's needed and
  stores it the same way it stores any other credential — the private signing
  key is never written to config, never logged, and never handed back by any
  read; only the public key needed to create a subscription is served. Each
  notification is encrypted before it's sent, using the standard Web Push
  encryption scheme with no new third-party dependency. If a device has no
  subscriptions, that's reported honestly as an empty result rather than a
  fake success, and a subscription the browser has revoked is cleaned up
  automatically. See the decision record at
  `docs/decisions/2026-07-07-web-push-subscriptions.md`.

### Fixed
- **Artifact uploads now state their real size limit when they're refused, and
  no longer stall the connection afterward.** An upload that's rejected for
  being too large used to report a bare "too large" message and could leave
  the connection in a state where the next request on it stalled for several
  seconds; refusals now say the actual byte limit that was exceeded, and the
  rest of the oversized upload is always fully read and discarded before
  responding, so the connection stays healthy for whatever the client sends
  next. Ordinary, correctly-sized uploads are unaffected.

## [1.0.0] - 2026-07-06

First stable release. `1.0.0` stabilizes the public operator/peer contract, the
runtime and platform surfaces, and the nine `@pellux/goodvibes-*` workspace
packages, all published together in lockstep. It closes the goodvibes-tui
evolution arc: the SDK is now the one platform substrate shared by
the TUI, the agent fork, and the browser web UI — sessions, config, memory, and
presentation are cross-surface by construction, reached through one daemon.

This release also executes the two breaking removals that were deliberately
parked for the major bump (the `danger.daemon` alias and the TUI staged-switch
scaffolding); see **Removed** and **Migration**.

### Added
- **One-broker session spine** — a single canonical session identity spine
  (`SurfaceKind` unification, expanded `SharedSessionKind`, project-as-data) with
  the `sessions.register` wire method through the full contract pipeline, a boot
  migration importer that folds legacy per-surface stores into one home store,
  and one extracted SDK session-spine surface client + read facade
  (`./platform/runtime/session-spine`). Register is idempotent; the union view
  dedups a surface's own wire-mirrored session; restart survival is proven.
- **Daemon is a system service** — detached spawn by default with opt-in
  in-process embedding (`daemon.enabled`, default on), a version-compatibility
  gate on adopt-or-start (refuse an incompatible daemon), and honest launchd
  restart (unload-then-load).
- **Control-plane read + lifecycle verbs over the wire** — `fleet.*`,
  `checkpoints.*`, `sessions.search`, `sessions.detach`, per-hunk approvals,
  catalog-driven invoke input validation, and SSE domain-scoped delivery for the
  broadcast fan-out. Typed I/O for the fleet/checkpoints/sessions.search/detach
  verbs.
- **Presentation contract hoisted into the SDK** (`./platform/presentation`) —
  glyphs, tones, spinner frames, and waiting/thinking wording as one
  cross-surface source, so every surface renders identically.
- **External calendar connectivity** — READ machinery (ICS parser, an honest
  RRULE subset, a feed-subscription store) plus OAuth 2.0 provider connectivity
  for Google Calendar API v3 and Microsoft Graph over auth-code+PKCE and
  device-code. Unconfigured providers refuse honestly (`client-not-configured`)
  rather than faking success.
- **Delete-means-delete** — real hard-delete for companion chat plus a new spine
  `sessions.delete` verb; delete can never resurrect (map-delete, drain pending
  saves, then unlink; routes flush the broker sync before responding).
- **Config sharing across surfaces** — a daemon-served shared config tier so
  a provider configured once is visible everywhere, reached through the existing
  `config.get`/`providers.*` plus one new admin-scoped, `read:config`-scoped
  credential-status read method. API keys stay env-only; the config snapshot stays
  secret-free; unavailable reads report an honest degraded state rather than a
  stale confident value.
- **Memory unification** — one canonical cross-surface `MemoryStore` (a fact
  learned on one surface recalls on another), with the agent's recall-honesty
  discipline raised to the cross-surface contract (semantic-by-default; an
  unavailable index falls back to literal *with a stated reason*, never a silent
  empty; the injection floor is tied to the store's real baseline). `VIBE.md` is
  re-framed as a rendered projection of persona/constraint records rather than a
  separate source of truth.
- **Core-verb command spec** — an SDK-owned canonical verb vocabulary
  (`packages/contracts`) with a conformance lint that keeps shared verbs identical
  across surfaces, plus fixes to the worst-class collisions (schedule
  triple-meaning, memory fragmentation, the agent `/session` orphan).
- **Consolidated local-SDK overlay tool** — one SDK-shipped `scripts/sdk-dev.ts`
  that enumerates the workspace packages (all nine, including
  `@pellux/goodvibes-contracts`); consumers reduce to a one-line alias, closing
  the contracts re-sync gap.

### Changed
- **BREAKING**: several operator method ids were renamed to conform to the
  core-verb vocabulary (e.g. `watchers.patch` → `watchers.update`). Consumers move
  in lockstep with this release; there are no deprecation aliases (this is the
  major bump).
- The `TASKS` read-only boundary is documented as a deliberate design decision
  (not a drift bug).

### Fixed
- **Uncataloged-method 404 now carries a machine code** — the
  "method unavailable" family is distinguished by code everywhere instead of by
  string-matching prose; `NOT_INVOKABLE` behavior is unchanged.
- Idle-empty reaper never closes a live surface session; honest reopen-on-heartbeat.
- Steer to a closed session is rejected with `409 SESSION_CLOSED`; the closed-session
  guard closes the follow-up/submit gap.
- Session `kind` is an OPEN enum on READ so mixed-version records don't blank the
  list (register input stays strict).

### Removed
- **BREAKING**: the deprecated `danger.daemon` config alias for `daemon.enabled` is
  removed (see `docs/decisions/2026-07-05-daemon-by-default.md`).
  `resolveDaemonEnabled`'s signature and 7 existing callers are unchanged.
  `danger.daemon` is no longer a valid `ConfigKey`.
- **BREAKING**: the TUI staged-switch scaffolding for the session-spine conversion
  is retired; the converted spine-client path is the standing path. The legitimate
  embedded/offline daemon topology is preserved (it was never staging scaffolding).

### Migration
- A config migration (`platform/config/migrations.ts`, wired into
  `ConfigManager.load`) preserves any existing explicit `danger.daemon: false` by
  rewriting it onto `daemon.enabled: false` at load time, so the legacy off-switch
  is never silently flipped on. `unset`/`true` need no rewrite (daemon defaults on).

## [0.38.0] - 2026-07-04

A broad batch from the goodvibes-tui evolution effort: the SDK becomes an
observability and orchestration substrate — a queryable process registry over
every runtime concern, workstream orchestration beyond fixed chains, passive
knowledge injection for both turn loops, and a repo code index.

### Added
- `@pellux/goodvibes-sdk`: **fleet process registry** (`./platform/runtime/fleet`) —
  `createProcessRegistry` composes the EXISTING managers (agents, WRFC chains,
  orchestration, schedules, triggers, watchers, workflows, background processes,
  automation jobs, code index) into one queryable tree of `ProcessNode`s with
  derived states, per-node usage/cost, coalesced subscription ticks, and verbs:
  `interrupt`, `kill` (cascade), `steer`, `resume`, `dispose`. Zero new store
  state — the registry is a view, not a second source of truth.
- `@pellux/goodvibes-sdk`: **conversation snapshot bridge + steer** —
  `AgentManager.getConversationSnapshot`, `AgentOrchestrator.setConversationSink`,
  message-bus `steer` verb (verbatim injection at drain; consumption event emitted
  only AFTER a successful chat), `ProcessState 'interrupted'`,
  `AgentRecord.terminationKind`.
- `@pellux/goodvibes-sdk`: **orchestration engine** (`./platform/orchestration`) —
  Workstream/Phase/WorkItem model with float-ordinal phase insertion, capacity-slot
  scheduler, resume-prefix replay keyed (itemId, phaseId) with crash-artifact
  reconciliation (in-phase items re-queue on import), budget refuse-not-kill +
  `updateBudget` recovery, `fromChainSpec` compat, and the planner's
  `PlanProposal` (`assemblePlanProposal` / `singleItemProposal`).
- `@pellux/goodvibes-sdk`: additive `Tool.execute(args, opts?: { signal? })` —
  cooperative cancellation reaches exec/fetch child processes (closing a
  previously deferred gap).
- `@pellux/goodvibes-sdk`: **passive knowledge injection for BOTH turn loops** —
  per-turn budgeted retrieval (default 800 tokens, relevance floor 95) composed
  fresh on every LLM roundtrip (including chat retries), gated by the
  `agent-passive-knowledge-injection` flag; honest per-turn records
  (`TurnInjectionRecord`: query, candidates, injected ids, dropped-for-budget,
  token cost) in bounded rings — `AgentRecord.turnInjections` and
  `Orchestrator.getTurnInjections()`; `OrchestratorCoreServices.memoryRegistry`
  seam via `setCoreServices`.
- `@pellux/goodvibes-sdk`: **repo code index** (`CodeIndexStore`, Stage A) —
  tree-sitter chunking, bounded gitignore-aware walk (nested .gitignore honored),
  hash-gated incremental rebuilds, honest lexical/semantic labeling with
  embedding-provider identity pinned per build (mismatch degrades to lexical with
  a rebuild hint), sqlite-vec backend, fleet `code-index` node; auto-start off by
  default.
- `@pellux/goodvibes-sdk`: **pause↔resume through the registry** — schedules,
  triggers, and automation jobs report `'paused'` (previously mislabeled
  `'killed'`), expose `resumable`, and `ProcessRegistry.resume()` re-enables them;
  `/schedule`-managed AutomationManager jobs now surface in the fleet tree.
- `@pellux/goodvibes-sdk`: `ConfigManager.removeCategoryKey` — clearing a
  category override (e.g. a feature-flag entry back to its default) was a silent
  no-op via merge; explicit removal now persists across reload.

### Fixed
- Stalled/killed false positives in fleet derivation (executing-tool exemption;
  controller-driven gating/committing phases no longer derive killed).
- WRFC rollup double-counting in aggregates (leaf-only accounting).
- Engine resume lost mid-phase items permanently (blocker class: 'in-phase'
  deserialized verbatim occupied capacity forever) — reconciled to pending with
  agent id cleared on import.
- Zombie chains reimported after restart with an all-dead agent roster are
  reaped terminal at import (resurrection-safe: any live member skips the reap).
- Killed-run dirty residue can no longer be swept into the next workstream's
  file-scoped commit — launch-dirty paths are content-hashed and excluded from
  scoped commits unless the run actually modified them; all-excluded commits are
  skipped with an honest recorded note.
- Code index reroot-during-build race (epoch-guarded abort; no cross-root
  writes), honest chunk counters, split file-cap vs total-byte-cap skip
  accounting (256MB bound now disclosed).
- Session-wire mixed-version tolerance, enum leg: response/output
  validation now treats a session record's `kind` as an OPEN enum on read, so a
  mixed-version daemon emitting a kind an older reader does not model no longer
  blanks the entire `sessions.list` envelope (per-record tolerance; the normalizer
  still backfills display). `sessions.register` input stays strict (unknown kind
  still 400s).
- Idle-empty reaper no longer closes LIVE surface sessions: a register
  heartbeat advances `lastActivityAt`, idle-empty exempts sessions with any
  participant seen within the idle window, and a SYSTEM-reaped session
  (`metadata.closeReason = 'idle-reaped'`) auto-reopens on the next heartbeat while
  a user/surface close stays closed with an honest conflict.
- Steer/follow-up routing to surface-backed sessions: a steer or
  follow-up to a surface-managed session with a live registered participant now
  queues for the surface (`mode: 'queued-for-surface'`, no daemon executor spawn);
  surfaceless sessions keep the executor path.

### Notes
- `ProcessState` gains `'paused'` and `'interrupted'` (additive; stale consumers
  render unknown-state fallbacks).
- Stage B of the code index (auto-injection into turns + tool-site reindex
  hooks) is deliberately deferred.

## [0.37.2] - 2026-07-04

### Fixed
- `@pellux/goodvibes-sdk`: **checkpoint creation no longer aborts in repos whose top-level `.gitignore` lists `.goodvibes/`** (which the goodvibes TUI itself writes at startup) — the side-git staging pathspec explicitly named `.goodvibes` in an exclude, triggering git's ignored-path abort and disabling ALL checkpointing in git repos. The redundant pathspec is removed; the checkpoint store's own `.goodvibes/.gitignore` self-ignore (written before any staging can run) is sufficient.
- `@pellux/goodvibes-sdk`: **per-hunk approval selections are honored end-to-end** — `ApprovalBroker.requestApproval()` dropped `modifiedArgs` from prompt decisions in both its local-prompt bridge and `resolveApproval()`, so "Apply selected" executed the full unfiltered edit. The field now threads through; regression test drives the real broker→PermissionManager→executeToolCalls pipeline (the pre-existing test bypassed the broker).

## [0.37.1] - 2026-07-03

### Fixed
- `@pellux/goodvibes-sdk`: **WorkspaceCheckpointManager operations are now serialized** through an internal mutex — a background agent completing during a restore's read-tree/checkout-index window could previously interleave an auto-snapshot's `git add -A` and silently corrupt the restore (timing-dependent; found by adversarial review, proven with an injected race).
- `@pellux/goodvibes-sdk`: **checkpoint retention GC genuinely reclaims disk** — checkpoint commits are now parentless (lineage lives in the manifest), so pruned refs' objects become unreachable and `git gc --prune=now` frees them (measured 64.6% object-store shrink in the test); previously the linear parent chain kept every pruned commit alive and the store grew unbounded.

## [0.37.0] - 2026-07-03

An early stage of the goodvibes-tui evolution effort, focused on reversibility. The headline is the workspace checkpoint engine — cheap whole-workspace snapshots and rewind, with zero pollution of the user's git state.

### Added
- `@pellux/goodvibes-sdk`: **WorkspaceCheckpointManager** (`./platform/workspace`) — a hidden side git repository (isolated `GIT_DIR`, the workspace as work-tree) provides content-addressed whole-workspace checkpoints: automatic snapshots at turn and agent-run boundaries (subscribing to existing TURN_*/AGENT_COMPLETED events), named manual checkpoints, checkpoint-to-checkpoint and checkpoint-to-working-tree diffs, and whole-workspace restore with a default safety checkpoint. Never touches the user repo's HEAD/index/stash (proven byte-identical in tests); works in non-git directories; honors .gitignore; bounded retention via the existing RetentionPolicy with ref-deletion GC. Constructed in `createRuntimeServices` and exposed on `RuntimeServices`.
- `@pellux/goodvibes-sdk`: permission prompts can modify tool arguments — `PermissionPromptDecision`/`PermissionCheckResult` gain optional `modifiedArgs`, and the edit tool executes the approved subset, enabling per-edit accept/reject at the approval gate (whole-file `write` stays all-or-nothing for now).

### Fixed
- `@pellux/goodvibes-sdk`: **compaction now accounts for completed subagent work** — two build sites filtered agent records with a premature active-only predicate, so a compaction summary after agents built a whole project claimed "no completed tool work". Completed agent runs (task, files touched, outcome) now reach the compaction sections.

### Notes
- The `wcp_` workspace-checkpoint namespace is deliberately distinct from compaction's `cpt_` conversation snapshots and the generic retention `CheckpointRecord`.

## [0.36.0] - 2026-07-03

An early "trust repairs" round from the goodvibes-tui live-dogfooding effort: every fix closes a defect reproduced against v1.0.0 of the TUI where the SDK reported something other than the truth to the model or the user.

### Added
- `@pellux/goodvibes-sdk`: `STREAM_RETRY` TurnEvent — in-flight provider `chat()` retries (the withRetry backoff path) now emit an observable event with attempt/max fields so consumers can render honest "reconnecting" state instead of a frozen spinner.
- `@pellux/goodvibes-sdk`: optional `usage` payload on `AGENT_COMPLETED` events, and `AgentRecord.usage`/`toolCallCount` are now populated with real values on completion — including WRFC owner agents, which aggregate usage across every child agent in the chain (previously permanent zeros).
- `@pellux/goodvibes-sdk`: WRFC auto-commit policy config (`off | scoped | all`, default `scoped`) and a `paths` parameter on `AgentWorktree.commitWorkingTree`.
- `@pellux/goodvibes-sdk`: bounded WRFC transport-failure retry (default 1, configurable) with an observable chain failure state carrying the reason — a chain whose agent transport dies can never again evaporate silently.

### Fixed
- `@pellux/goodvibes-sdk`: **Tool failures no longer masked as "Unknown error"** — `ConversationManager.addToolResults` discarded `result.output` whenever `success` was false, so a failing test suite's exit code/stdout/stderr (which the exec tool returns faithfully in `output`) never reached the model. Output is now always preserved; the exec tool additionally sets a top-level one-line `error` summary when any command fails.
- `@pellux/goodvibes-sdk`: **Output truncation now preserves the tail** (head 20% + tail 80%) instead of keeping only the head — test runners print failures at the end, so head-only truncation kept the progress dots and silently dropped the failing assertion. The honest truncation marker is unchanged.
- `@pellux/goodvibes-sdk`: **WRFC auto-commit no longer sweeps the whole dirty working tree** — commits are scoped to the files the chain actually touched (from its own edit ledger), with full untruncated commit messages. Unrelated dirty/untracked files are left alone.
- `@pellux/goodvibes-sdk`: the exec phase timeout now honors a caller-supplied `timeout_ms` larger than the phase default, so long full-suite runs are not killed at the generic deadline.

### Notes
- Known follow-ups (documented, non-blocking): scoped-commit deletion paths must be repo-relative (absolute/'./'-prefixed self-reports are dropped, failing safe); the transport-retry budget is chain-global; `isTransportFailureMessage` deliberately matches broad substrings and can over-retry (bounded). Cooperative cancellation (AbortSignal through `Tool.execute`) remains unwired for all phased tools — an orphaned-child-process risk tracked for the orchestration wave.

## [0.35.0] - 2026-06-30

Full deep-review audit of the SDK: 55 adversarially-verified findings fixed across all 10 subsystem areas (providers, core orchestrator/compaction, agents/WRFC, runtime, channels/operator, tools/mcp/permissions/hooks, transports/contracts, data subsystems, cross-cutting).

### Added
- `@pellux/goodvibes-sdk`: `inferFallbackContextWindow` and `FALLBACK_CONTEXT_WINDOW` are now exported from the public `./platform/providers` entrypoint so consumers can share the family-aware pre-catalog context-window fallback instead of hardcoding their own.

### Fixed
- `@pellux/goodvibes-sdk`: **Tool-loop circuit breaker never terminated the loop** — the breaker set `continueLoop = false` which was then unconditionally clobbered by `continueLoop = results.continueLoop` on the next line (orchestrator-turn-loop.ts), so a model repeatedly producing all-failing tool calls looped until the iteration cap instead of tripping the breaker.
- `@pellux/goodvibes-sdk`: **Auto-compaction safety buffer is now scaled to the context window** (capped at a window fraction) instead of a flat 15k, which forced near-constant compaction on small/medium windows; the buffer remains an independent backstop on large windows regardless of the percentage threshold.
- `@pellux/goodvibes-sdk`: **`getContextWindowForModel` now honors a user `configured_cap` before the OpenRouter fuzzy lookup**, so an explicit cap is no longer silently widened by a fuzzy id match; and the method floors its result so a 0/NaN window can never poison budget math.
- `@pellux/goodvibes-sdk`: **McpClient no longer auto-restarts after an intentional disconnect** (which spawned orphan server processes); restart is gated on an intentional-close flag.
- `@pellux/goodvibes-sdk`: **Registering a transport middleware no longer silently disables HTTP retries** or reclassifies `HttpStatusError`; the retry policy applies through middleware.
- `@pellux/goodvibes-sdk`: **`openContractRouteStream` now threads the dynamic `getAuthToken` resolver**, so operator/telemetry SSE streams refresh auth instead of opening with a stale (or missing) token.
- `@pellux/goodvibes-sdk`: Anthropic/Gemini SSE assembly now flushes a trailing un-terminated `data:` line so the final `message_delta`/`usageMetadata` event is not dropped on abrupt close.
- `@pellux/goodvibes-sdk`: capability-resolution cache key now includes the provider's self-declared capabilities (no cross-call poisoning); image tokens are counted in both `estimateConversationTokens` and the recent-conversation compaction budget; the daemon HTTP route handlers return the structured `StructuredDaemonErrorBody` contract via `jsonErrorResponse`; the error-category classifier uses word boundaries (no false `authentication` match on "authorization"); and the platform/daemon-sdk error classifiers were de-drifted. Plus numerous DRY, dead-code, error-handling, and type-safety fixes across the listed areas.

## [0.34.2] - 2026-06-29

### Fixed
- `@pellux/goodvibes-sdk`: Fixed a tool-loop circuit-breaker infinite loop introduced in 0.34.1. The 0.34.1 DRY consolidation moved the `isActiveAgent` predicate into `compaction-sections` and had the orchestrator turn-loop modules (`orchestrator-context-runtime`, `orchestrator-tool-runtime`) and `context-compaction` import it from there. That pulled the heavy `compaction-sections` module into the turn-loop import graph and created a circular dependency, leaving the circuit-breaker threshold constant in its temporal dead zone (undefined) at runtime — so the breaker never tripped and a model that repeatedly calls a missing/failing tool would loop forever instead of failing with `tool_loop_circuit_breaker`. `isActiveAgent` now lives in the dependency-free leaf `tools/agent/predicates`, and a regression guard (`test/orchestrator-active-agent-cycle.test.ts`) prevents the cyclic import from returning.

## [0.34.1] - 2026-06-29

### Fixed
- `@pellux/goodvibes-sdk`: Agent progress no longer firehoses raw model output. The orchestrator stream handler overwrote `record.progress` (surfaced as `RuntimeAgent.latestProgress`) with the last ~100 chars of raw streamed output on every delta, clobbering the concise status strings ("Turn N · <tool>", "Thinking…"). Live output already flows via `record.streamingContent` / `emitStreamDelta`; progress now retains its last meaningful status.
- `@pellux/goodvibes-sdk`: Family-aware context-window fallback for unknown/new public models (Gemini 1M, Claude 200k, Grok 256k, GPT-5/4.1 400k, o-series 200k) instead of a flat default, plus a `> 0` guard so a `context: 0` from the live catalog no longer propagates as a zero window (which silently disabled auto-compaction). `capabilities.ts` context-window data corrected (xAI 256k, o-series 200k, gpt-5/4.1 400k) and made consistent with the fallback.
- `@pellux/goodvibes-sdk`: WRFC config now validated with `Number.isFinite` (a NaN `maxFixAttempts` previously made the fix loop never terminate); defaults aligned to the schema.
- `@pellux/goodvibes-sdk`: WRFC gate-failure handling — a global gate failure now spawns exactly one gate-fixer instead of one per concurrent chain racing the shared project tree (orphan-safety re-check added).
- `@pellux/goodvibes-sdk`: Anthropic thinking-budget `max_tokens` bump is now clamp-aware (no longer risks exceeding the model output cap).
- `@pellux/goodvibes-sdk`: `isRecord` array-semantics bug fixed — two copies (`mcp/client.ts`, `runtime/transports/http-helpers.ts`) wrongly treated arrays as records; all copies now use one canonical guard.

### Added
- `@pellux/goodvibes-sdk`: `WORKFLOW_SCORE_REGRESSION` workflow event (advisory) — distinct from `WORKFLOW_CASCADE_ABORTED`, which was previously overloaded for both a real abort and an advisory score-regression signal.
- `@pellux/goodvibes-sdk`: Session lineage now records the original task (`originalTask` was previously always undefined in the compaction handoff).

### Changed
- `@pellux/goodvibes-sdk`: Large internal DRY consolidation (no public API change): shared SSE line-buffer + Anthropic/OpenAI stream assembly, JSON TTL-cache scaffolding, provider error helpers, context-usage/section-token accounting, config range-validator factories, read-model projection helpers, and `isRecord`/`sleep`/fetch-timeout utilities.

## [0.34.0] - 2026-06-20

### Added
- `@pellux/goodvibes-sdk` / `@pellux/goodvibes-contracts`: Published 17 new operator method contracts so daemon-connected agents can detect and invoke them through the standard operator method protocol. These are additive, typed contract descriptors (no breaking changes to existing methods).
  - **Channels** (new methods under the existing `channels.*` namespace): `channels.inbox.list` (provider inbound feed — Slack/Discord DMs, email threads; read-only), `channels.routing.list` / `channels.routing.assign` / `channels.routing.delete` (daemon-persisted channel-to-profile routing), and `channels.drafts.list` / `channels.drafts.get` / `channels.drafts.save` / `channels.drafts.delete` (server-side channel draft sync; webhook values must be transmitted redacted).
  - **Email** (new `email.*` namespace, scopes `read:email` / `write:email`): `email.inbox.list`, `email.inbox.read` (read-only IMAP via BODY.PEEK), `email.draft.create` (IMAP Drafts append), and `email.send` (SMTP send — marked `dangerous`, requires `confirm: true`).
  - **Calendar** (new `calendar.*` namespace, scopes `read:calendar` / `write:calendar`): `calendar.events.list` / `calendar.events.get` / `calendar.events.create` and `calendar.ics.import` / `calendar.ics.export` (CalDAV-backed; writes require confirmation).
  - Mutating methods use `access: 'admin'` with `write:*` scopes; irreversible/destructive methods (`email.send`, routing/draft deletes) are flagged `dangerous`. Read methods use `read:*` scopes. The SDK publishes the contract surface only; daemon-side handlers implement the behavior.

### Security
- Cleared 6 high-severity advisories in build/test/optional transitive dependencies (no runtime SDK code change): added `overrides` pinning `form-data` to 4.0.6 (GHSA-hmw2-7cc7-3qxx), `ws` to 8.21.0 (GHSA-96hv-2xvq-fx4p), and `undici` to 7.28.0 (GHSA-vmh5-mc38-953g, GHSA-vxpw-j846-p89q, GHSA-hm92-r4w5-c3mj); bumped the `@cyclonedx/cyclonedx-npm` SBOM dev tool from 4.2.1 to 5.0.0 (GHSA-v75r-vx73-82pj). See `overridesRationale` for per-pin justification.

## [0.33.38] - 2026-06-12

### Added
- `@pellux/goodvibes-daemon-sdk` / `@pellux/goodvibes-sdk`: Added cursor-based pagination on 4 list endpoints: `GET /api/automation/jobs`, `GET /api/automation/runs`, `GET /api/knowledge/sources`, `GET /api/knowledge/nodes`. Pass `?limit=N&cursor=<opaque>` to activate; omit both params for the legacy array response (backward compatible). `GET /api/sessions` returns the session broker snapshot only (the integration helper is consumer-supplied and cannot be range-queried in daemon-sdk). New types: `PaginatedResponse<T>` (exported from `@pellux/goodvibes-daemon-sdk`). New helpers: `encodeCursor`, `decodeCursor`, `paginateItems`, `hasPaginationParams`. Paginated responses return `{ items, hasMore, nextCursor? }`; invalid cursors return HTTP 400 matching the existing error contract. `paginateItems` now accepts an optional `getCreatedAt` extractor: when a cursor’s item has been deleted mid-walk, the stable timestamp is used to locate the insertion point instead of restarting from index 0. `paginateItems` also accepts a `PaginateItemsOptions` argument (with `descending` flag) for stores sorted newest-first. Insertion-point recovery is **active** on `GET /api/knowledge/sources` and `GET /api/knowledge/nodes` (via `KnowledgeSourceRecord.updatedAt` / `KnowledgeNodeRecord.updatedAt`, matching the store’s `byUpdatedAtDesc` sort order; if an item is updated mid-walk its `updatedAt` increases and its old position vanishes — the insertion-point scan handles this identically to a deletion) and `GET /api/automation/runs` (via `AutomationRunLike.queuedAt`, descending order). `GET /api/automation/jobs` uses restart-from-0 fallback because `AutomationJobLike` exposes no timestamp field at the SDK boundary.
- `@pellux/goodvibes-transport-realtime`: Added `ConnectorTransportEvent` discriminated union and
  `onTransportEvent` callback to `RuntimeEventConnectorOptions`. The connector now dispatches typed
  `TRANSPORT_CONNECTION_STATE`, `TRANSPORT_RECONNECT_ATTEMPT`, and `TRANSPORT_BACKPRESSURE` events
  directly to `onTransportEvent` in addition to the existing dedicated callbacks. Subscribe to
  `onTransportEvent` to receive a unified stream of observability events suitable for forwarding to
  a UI state store or event bus.
- `@pellux/goodvibes-sdk` / `events/tasks.ts`: Added `BATCH_JOB_PROGRESS` and `EXPORT_PROGRESS`
  progress event contracts. `operationId` on both is operation-scoped (not task-scoped); see
  `lifecycle.ts` for the guard.
- `@pellux/goodvibes-sdk` / `events/knowledge.ts`: Added `KNOWLEDGE_INGEST_PROGRESS` progress event
  contract. `operationId` is operation-scoped; see `lifecycle.ts` for the guard.
- `@pellux/goodvibes-sdk` / `events/transport.ts`: Added `TRANSPORT_BACKPRESSURE`,
  `TRANSPORT_CONNECTION_STATE`, and `TRANSPORT_RECONNECT_ATTEMPT` members to the `TransportEvent`
  union.
- `@pellux/goodvibes-errors`: Added `SDKErrorCode` string-literal union, `SDKErrorCodes` const object,
  `isErrorCode()` type guard, and `isKnownErrorCode()` helper for exhaustive consumer pattern-matching.
  The `code` field on `GoodVibesSdkError` is now typed as `SDKErrorCode | (string & {})` and is always
  present (never `undefined`) — the SDK infers a canonical code from `status` or `category` when none
  is explicitly supplied. HTTP status codes are mapped to specific codes (e.g. `429` → `RATE_LIMITED`,
  `401` → `AUTH_REQUIRED`, `404` → `NOT_FOUND`, `409` → `CONFLICT`). Existing callers that supply
  custom string codes are backward compatible.
  Wire behavior: daemon error envelopes now always include a `code` field (`'UNKNOWN'` is the floor
  when no explicit code or inferrable status/category is available). Knowledge route 404-mapping:
  the bare `NOT_FOUND` code only maps to HTTP 404 when the error also carries `status: 404` (i.e.
  it originated from a real HTTP 404 response); domain-specific not-found codes
  (`KNOWLEDGE_ISSUE_NOT_FOUND`, `KNOWLEDGE_CANDIDATE_NOT_FOUND`, `KNOWLEDGE_JOB_NOT_FOUND`) always
  map to 404 regardless of status, as they are explicitly thrown by the service layer and are never
  auto-inferred.
- `SessionManager`: session/recovery files now include `schemaVersion` (currently `1`) in the JSONL
  meta line. Readers gate on version: legacy files without `schemaVersion` are accepted as
  version 0 (backward compatible), files with a newer unknown version are accepted with
  best-effort parsing and a log warning. `SessionMeta` exposes the parsed `schemaVersion? number`
  field. `CURRENT_SESSION_SCHEMA_VERSION` is exported for consumers.
- `ConfigManager`: added public `getConfigPath(): string` and
  `getProjectConfigPath(): string | undefined` accessors so consumers no longer need to cast
  through `as unknown` to reach the private path fields.
- `TtsConfig`: added `speed: number` field (playback speed multiplier, range 0.25–4.0;
  default `1.0`; required — always present with its default). Mirrors the existing `speed` field
  on `VoiceSynthesisRequest`. The config key `tts.speed` is now available in `ConfigKey`,
  `ConfigValue`, and `CONFIG_SCHEMA`. Values outside [0.25, 4.0] or non-finite values are rejected
  with `ConfigError` at `ConfigManager.set()` time.
- `MemoryRegistry.reviewQueue()` / `MemoryApi.reviewQueue()`: added optional `scope` parameter
  (`'session' | 'project' | 'team'`) to filter the review queue at the registry level before
  applying the `limit`. Fully backward compatible — existing calls with only `limit` are
  unaffected. The daemon HTTP route `GET /api/memory/review-queue` also accepts the new
  `?scope=session|project|team` query parameter. A `scope` value that is present but not one of
  the three valid enum members returns HTTP 400.

### Changed
- `@pellux/goodvibes-transport-realtime` `createWebSocketConnector`: Reconnect is now **only**
  suppressed for genuine clean closes (`wasClean === true && code === 1000`). All other closes —
  including code 1005 (No Status Received, synthesized by runtimes for abnormal drops with no close
  frame) — schedule a reconnect as per RFC 6455 §7.4.1. The connector transitions directly to
  `disconnected` only on deliberate clean server-side closes.

### Deprecated
- `RuntimeEventConnectorOptions.onReconnect(attempt, delayMs)` — use `onReconnectAttempt(info)`
  instead, which carries the same `attempt` and `delayMs` values plus `maxAttempts` and `reason`.
  The legacy `onReconnect` callback continues to fire alongside `onReconnectAttempt` for backward
  compatibility and will be removed in a future major release.

---

## [0.33.37] - 2026-06-05

### Added
- Added telephony surface schema coverage, adapter registration, bridge delivery
  metadata, and channel policy support so phone-call style delivery can be
  treated as a first-class channel surface.

---

## [0.33.35] - 2026-05-21

### Fixed
- Hid default-space GitHub navigation memory records whose title is
  `Navigation Menu`, including reviewed project memory records that were not
  linked back to their original source.
- Hid default-space `semantic-gap-repair` GitHub sources that only expose
  GitHub navigation chrome, preventing regular Knowledge/Wiki packet and ask
  surfaces from matching unrelated repair-source pages.
- Expanded Knowledge/Wiki scoping regressions to cover standalone navigation
  memory records and non-GoodVibes GitHub repair pages in default sources,
  nodes, projections, map, packet, and ask results.

---

## [0.33.34] - 2026-05-20

### Fixed
- Extended default Knowledge/Wiki contamination filtering to the root
  `github.com/mgd34msu/goodvibes` repository navigation page and source-derived
  memory nodes, preventing unscoped list, map, packet, projection, and ask
  surfaces from using root GoodVibes GitHub navigation debris as regular
  knowledge.

---

## [0.33.33] - 2026-05-20

### Fixed
- Rejected default-space GoodVibes repository navigation debris from regular
  Knowledge/Wiki scopes so unscoped `knowledge.ask` no longer answers
  GoodVibes Agent questions from unrelated plugin/TUI/desktop navigation pages
  or their stale semantic facts.
- Added regression coverage for default `What is GoodVibes Agent?` asks to
  return no results, no sources, no facts, no gaps, and confidence `0` when
  only default-space product navigation contaminants exist.

---

## [0.33.32] - 2026-05-20

### Fixed
- Fixed daemon startup normalization for embedded runtime services that are
  missing the isolated GoodVibes Agent knowledge service, preventing
  `/api/goodvibes-agent/knowledge/*` routes from wiring undefined
  `knowledgeService` handlers.
- Added regression coverage for Agent knowledge status, ask, and search routes
  backed by the isolated `knowledge-agent.sqlite` store.
- Hid legacy default-space GoodVibes Agent wiki records from regular
  Knowledge/Wiki lists, projections, packets, maps, and asks so Agent content
  only appears through the Agent-specific knowledge environment.

---

## [0.33.31] - 2026-05-20

### Added
- Added a scoped `@pellux/goodvibes-sdk/browser/agent` entrypoint whose
  Knowledge/Wiki calls route to an Agent-owned knowledge environment instead of
  the regular Knowledge/Wiki or Home Assistant Home Graph stores.
- Added a daemon-backed GoodVibes Agent knowledge store using
  `knowledge-agent.sqlite` and `/api/goodvibes-agent/knowledge/*` routes.

### Fixed
- Hardened default Knowledge/Wiki scoping so Home Assistant/Home Graph-derived
  sources, semantic gaps, answer-gap issues, orphan source-derived nodes, and
  extension-only repair artifacts do not leak into regular Knowledge/Wiki
  surfaces by default.
- Prevented unanchored default-space no-match answer gaps from being persisted
  and automatically web-repaired, keeping generic regular Knowledge/Wiki asks
  from creating extension contamination.
- Prevented generic extension documentation in the default space from receiving
  deterministic semantic enrichment.

---

## [0.33.30] - 2026-05-11

### Fixed
- Made JavaScript-family REPL execution inside QEMU use a guest runtime command
  instead of the host `process.execPath`. The SDK now defaults to `bun` for
  JavaScript, TypeScript, SQL, and GraphQL REPL snippets in QEMU and exposes
  `sandbox.replJavaScriptCommand` for guest-specific overrides such as
  `/home/goodvibes/.bun/bin/bun`.

---

## [0.33.29] - 2026-05-11

### Fixed
- Prevented retrospective documentation and setup-guide prompts from being
  classified as project execution simply because they are long or mention a
  workflow. Requests such as "list what you did", "summarize the workflow", and
  "write an instruction guide" now avoid `[Project mode]` priming unless they
  also ask for concrete implementation work.

---

## [0.33.28] - 2026-05-11

### Fixed
- Honored `behavior.autoCompactThreshold` as a percentage threshold for
  preflight and post-turn auto-compaction, while retaining the remaining-token
  safety buffer. Context warnings and compaction hooks now include effective
  token counts, threshold tokens, remaining tokens, safety-buffer tokens, and
  trigger reason.
- Made the `exec` tool accept command-level `working_dir` as a `cwd` alias and
  promote it to the required top-level working directory for single-command
  calls, matching common model-generated tool payloads.

---

## [0.33.27] - 2026-05-11

### Added
- Added SDK-owned runtime MCP config management so hosts can add, remove, and
  reload MCP servers without restarting the daemon. New daemon/operator routes
  expose effective config, runtime server status, connected tools, config
  reload, and project/global server upsert/remove.
- Added durable MCP config helpers for writable project/global GoodVibes MCP
  config files, including effective source metadata and project-over-global
  precedence.

### Fixed
- MCP runtime reload now reconnects only added/changed/removed servers and keeps
  configured-but-failed servers visible in runtime status so UI surfaces can
  repair bad config without losing the record.
- MCP config list responses redact environment values and expose env keys only.

---

## [0.33.26] - 2026-05-10

### Fixed
- Fixed WRFC `autoCommit` after passing review and gates. The SDK now commits
  direct workspace edits produced by live agents, uses a GoodVibes fallback git
  identity when a fresh machine has no local git user configured, and avoids
  staging `.goodvibes` internal runtime state.
- Fixed WRFC auto-commit candidate selection so reviewer/verifier branches are
  not merged as if they contained accepted implementation changes. Single-chain
  commits now prefer the accepted fixer when present, and compound chains commit
  the accepted sub-deliverable writer plus integrator outputs.
- Made missing legacy per-agent git worktree branches a non-fatal skip during
  auto-commit cleanup, matching the current direct-workspace agent execution
  model.

---

## [0.33.25] - 2026-05-10

### Added
- Added compound WRFC owner chains for multi-deliverable implementation work:
  the SDK now collapses related implementation batches into one durable owner,
  runs sub-deliverable engineer children concurrently, reviews and fixes each
  sub-deliverable only after its engineer output exists, and then runs an
  integrator child before final full-scope review.
- Added WRFC `orchestrator` and `integrator` roles/archetypes plus subtask
  metadata so hosts can render compound chains as one owner tree instead of
  sibling root agents.

### Fixed
- Preserved implementation scope and write/exec capability for compound WRFC
  subtasks when model-proposed child tasks try to narrow build work into
  design-only or no-write work.
- Kept compound subtask fixer loops scoped to the failing deliverable while
  preserving constraint continuity and feeding the latest fixed output into
  the integration phase.

---

## [0.33.24] - 2026-05-10

### Fixed
- Prevented companion chat and Home Assistant Assist conversation turns from
  failing with HTTP 500 when a model exhausts the tool-call round budget. The
  SDK now performs one tool-free finalization pass using the accumulated tool
  results and returns a normal assistant answer when possible.

---

## [0.33.23] - 2026-05-09

### Added
- Added SDK-owned WRFC scope-mutation diagnostics in collapsed agent
  `batch-spawn` results so callers can see when a model-proposed child task was
  not allowed to narrow the authoritative review scope.

### Fixed
- Preserved the original user request as `authoritativeTask` for root agent
  spawns and batch spawns emitted by the orchestrator, so WRFC owner chains
  review the user's requested deliverable instead of a model-invented child
  task.
- Prevented root WRFC role-fanout collapse from converting build/make/create
  requests into design-only or no-write scopes. Collapsed Engineer+Reviewer
  batches now use the authoritative original ask for the owner, engineer, and
  reviewer prompts.
- Ignored restrictive child `tools`/`restrictTools` settings that remove write
  or execution capability from implementation-like WRFC scopes, while still
  preserving those restrictions for explicitly no-write/read-only asks.
- Prevented direct root engineer spawns from silently narrowing an
  implementation request into design-only/no-write work when the orchestrator
  supplied the original user ask.

---

## [0.33.22] - 2026-05-09

### Changed
- Added an explicit WRFC owner-chain orchestration contract to agent tool
  results: authoritative WRFC spawns now return `authoritativeWrfcChain`,
  `continueRootSpawning: false`, `rootSpawnContinuation`, and
  `orchestrationStopSignal` so clients and orchestrators know the WRFC owner
  chain owns the deliverable.
- Injected explicit WRFC execution prompts into the live provider system prompt
  for user requests such as `WRFC review for ...`, so the model is instructed to
  start one WRFC owner chain instead of answering with a prose explanation.
- Recorded `wrfcRouteReason` when root reviewer/tester/verifier tasks are
  normalized into an engineer-owned WRFC chain.

### Fixed
- Suppressed the generic post-agent "continue spawning agents" nudge when the
  spawned result is an authoritative WRFC owner chain, including active-plan
  turns that would otherwise auto-spawn more root agents for the same
  deliverable.
- Prevented unconstrained WRFC fix loops from failing on fixer-invented
  `constraints` ids: fixer reports are canonicalized to the chain's
  authoritative constraint list before review, while non-empty constraint chains
  still surface missing or extra ids as continuity regressions.

---

## [0.33.21] - 2026-05-09

### Added
- Added a shared, durable project work-plan/task primitive under
  `projectPlanning.workPlan.*`, including project-scoped task CRUD, status
  transitions, ordering, completed-task clearing, snapshot counts, browser
  knowledge SDK helpers, and runtime task/snapshot events for TUI, WebUI, APK,
  daemon planning, and WRFC.
- Mirrored accepted project-planning state tasks into the shared work-plan store
  so plan items have one cross-surface task model instead of per-client local
  tracking.

### Changed
- Linked WRFC owner, engineer, reviewer, fixer, and verifier phases to shared
  work-plan tasks with chain/phase/agent correlation metadata, ordered task
  writes, and lifecycle status updates.
- Made WRFC owner/root lifecycle authoritative: premature owner completion or
  failure events are ignored and corrected while the chain is still active, and
  the owner remains visible/running until the full chain reaches a terminal
  passed, failed, or cancelled state.
- Added stable WRFC topology metadata to agent records, tool output, and runtime
  events/store state: `wrfcId`, `wrfcRole`, `wrfcPhaseOrder`, and
  `parentAgentId`.
- Normalized root reviewer/tester/verifier spawns into one WRFC owner chain
  instead of hard-failing, and normalized one-task `batch-spawn` requests
  through the single-agent spawn path.

### Fixed
- Prevented WRFC owner records from disappearing or being counted as terminal
  before review/fix/verify lifecycle children complete.
- Exposed enough WRFC metadata for clients to render owner/child hierarchy
  without inferring duplicate-looking engineer rows from task text.

---

## [0.33.20] - 2026-05-09

### Fixed
- Enforced WRFC topology at the SDK agent tool/runtime boundary by collapsing
  batch-spawn role decomposition such as engineer plus tester/reviewer/verifier
  into one WRFC owner chain instead of allowing sibling root role agents.
- Rejected direct disabled reviewer/tester/verifier root spawns so review,
  test, verification, and fix roles remain WRFC lifecycle children owned by
  the controller.
- Clarified the agent tool contract so `batch-spawn` is reserved for genuinely
  independent sidecar work, while same-deliverable role decomposition is routed
  through WRFC.

---

## [0.33.19] - 2026-05-08

### Fixed
- Made WRFC review prompts include the engineer's full reviewable output so
  no-write and non-file deliverable tasks can be reviewed directly instead of
  failing because no files exist.
- Tightened reviewer constraint-finding instructions with the exact JSON shape
  and normalized common evidence object/array shapes in the parser so usable
  findings are not silently dropped into repeated malformed-finding loops.

---

## [0.33.18] - 2026-05-08

### Added
- Added durable WRFC owner decisions for chain lifecycle, child spawning,
  review/fix transitions, gate outcomes, cancellation, failure, pass, and
  resume handling.
- Added optional WRFC child route selection so owners can choose provider,
  model, and reasoning effort per phase while defaulting to owner routing.
- Added basic WRFC chain resume hooks and a generic external WRFC adapter seam
  for companion or partner surfaces that need a translation layer.

### Changed
- Made WRFC review and fix prompts preserve the original request as the
  authoritative full-scope review target for every loop, including later fix
  rounds.
- Added lightweight worker self-check guidance instead of heavier phase
  contract retry machinery.

---

## [0.33.17] - 2026-05-08

### Fixed
- Split regular Knowledge/Wiki and Home Assistant Home Graph into separate
  runtime knowledge stores so `/api/knowledge/*` cannot expose Home Graph
  records through default views, `includeAllSpaces`, projections, packets, or
  repair-derived nodes.
- Routed Home Graph semantic repair through the Home Graph service and store,
  including the target Home Graph knowledge space on repair-source ingestion.

---

## [0.33.16] - 2026-05-07

### Fixed
- Hid orphan catalog-derived topic/domain/folder nodes from default
  Knowledge/Wiki views unless they are connected to visible base knowledge,
  preventing stale DisplaySpecifications-style repair tags from appearing in
  regular wiki nodes after reindex.
- Hid answer-gap issues whose only grounding is a refinement-only answer-gap
  node from default issues and projection targets, while still exposing them
  through `includeAllSpaces` diagnostics.

---

## [0.33.15] - 2026-05-07

### Fixed
- Made regular Knowledge/Wiki scoping edge-aware for derived nodes and issues,
  so stale topic/domain records connected to Home Assistant sources only by
  graph edges no longer appear in default nodes, issues, projections, packets,
  or maps.
- Hid ungrounded semantic answer-gap records from scoped default Knowledge/Wiki
  surfaces while preserving them for `includeAllSpaces` diagnostics and
  refinement state inspection.

---

## [0.33.14] - 2026-05-07

### Fixed
- Restored implicit `default` knowledge-space matching for base records without
  explicit space metadata, while keeping relationship-aware filtering for
  extension-linked records. This keeps reviewed project memory visible in the
  regular Knowledge/Wiki surface without reintroducing Home Assistant leaks.
- Wrote memory-derived graph nodes and topic tags with explicit `default`
  knowledge-space metadata during memory sync so future reindex runs produce
  unambiguous base knowledge records.

---

## [0.33.13] - 2026-05-07

### Fixed
- Tightened Knowledge/Wiki scoped issue, projection, packet, map, and item reads
  so stale answer-gap records marked `default` are hidden when their linked
  source or subject object belongs to an extension knowledge space.
- Inferred concrete non-default knowledge spaces for new answer gaps and
  source-linked records when their related source, subject, or linked object is
  already scoped, preventing future Home Assistant answer gaps from being
  written into base Knowledge/Wiki by mistake.

---

## [0.33.12] - 2026-05-07

### Fixed
- Tightened regular Knowledge/Wiki default scoping so unscoped derivative
  records are not treated as `default` knowledge. This prevents older
  Home Assistant/Home Graph semantic nodes, issues, projection targets, map
  entries, and packets from leaking through base knowledge routes.
- Namespaced source-derived compiled nodes and edges with the source knowledge
  space, so future domain, tag, folder, section, and structured entity records
  stay in the same space as the source that generated them.

---

## [0.33.11] - 2026-05-07

### Fixed
- Scoped regular Knowledge/Wiki reads to the base `default` knowledge space by
  default, so Home Assistant Home Graph records no longer appear through base
  knowledge sources, nodes, issues, search, map, packets, projections, status,
  item, extraction, or GraphQL routes unless callers explicitly request
  `knowledgeSpaceId` or `includeAllSpaces`.
- Returned scoped map facets and projection counts instead of deriving sidebar
  facets, backlink IDs, and wiki counts from the full cross-extension graph.

---

## [0.33.10] - 2026-05-07

### Added
- Added typed companion-chat message attachments. Browser clients can create
  artifacts through `sdk.artifacts.create(...)` from
  `@pellux/goodvibes-sdk/browser/knowledge`, then send them with
  `sdk.chat.messages.create(sessionId, { body, attachments: [...] })`.
- Persisted companion-chat attachments in message history and included them in
  per-session turn events so WebUI clients can render attachment state without
  local-only metadata.

### Fixed
- Resolved companion-chat attachments through the daemon artifact store before
  model turns. Small text artifacts are inlined into the provider prompt, image
  artifacts are forwarded as multimodal content parts, and unsupported files
  remain visible as durable artifact references instead of fake message
  metadata.

---

## [0.33.9] - 2026-05-07

### Added
- Added first-class companion-chat session listing and session route updates to
  `@pellux/goodvibes-sdk/browser/knowledge` via `sdk.chat.sessions.list()` and
  `sdk.chat.sessions.update(...)`.
- Added the typed `companion.chat.sessions.list` operator method and
  `GET /api/companion/chat/sessions` daemon route.

### Fixed
- Normalized OpenAI subscription-backed companion-chat model routing so both
  the catalog provider (`openai`) and runtime provider implementation
  (`openai-subscriber`) resolve `openai:*` registry keys safely.
- Returned the full stored companion-chat session from
  `companion.chat.sessions.create`, allowing browser clients to verify the
  persisted provider/model route immediately after create.

---

## [0.33.8] - 2026-05-07

### Added
- Added typed companion-chat browser helpers to
  `@pellux/goodvibes-sdk/browser/knowledge`, including scoped JSON methods for
  chat sessions/messages and an explicit SSE helper for per-session turn events.

### Fixed
- Aligned companion-chat operator contract outputs with the daemon route shapes
  so `sessions.get`, `sessions.update`, and `messages.list` no longer expose
  shared-session schemas.
- Preserved full provider/model routing metadata for `sessions.messages.create`
  `kind: "message"` conversation turns.

---

## [0.33.7] - 2026-05-07

### Fixed
- Reissued the scoped browser entrypoint release after npm published the
  `0.33.6` metadata for `@pellux/goodvibes-transport-realtime` without a
  retrievable tarball. No source changes from `0.33.6`.

---

## [0.33.6] - 2026-05-07

### Added
- Added scoped browser SDK entrypoints for extension-specific browser apps:
  `@pellux/goodvibes-sdk/browser/knowledge` exposes the base knowledge/wiki
  browser surface without Home Assistant Home Graph route metadata, and
  `@pellux/goodvibes-sdk/browser/homeassistant` exposes the Home Assistant Home
  Graph browser surface without the base knowledge/wiki route table.
- Added regression coverage that scoped browser bundles reject out-of-scope
  operator methods and do not include unrelated route metadata.

### Fixed
- Fixed scoped browser SSE cleanup so a subscription removed before the stream
  connection resolves cannot leave an orphaned stream open.

---

## [0.33.5] - 2026-05-07

### Fixed
- Aligned the public typed operator method id union with the generated operator method id artifact so `OperatorTypedMethodId` accepts every public method, including `knowledge.ask` and `knowledge.refinement.tasks.list`.
- Added type-level coverage for browser/WebUI knowledge invokes so contract drift between `OPERATOR_METHOD_IDS` and `OperatorMethodInput/Output` fails before publish.

---

## [0.33.4] - 2026-05-05

### Fixed
- Aligned `remote.snapshot` with the strict operator contract by serializing distributed pair requests, peers, work, and audit records as arrays instead of leaking the internal summary-object shape.
- Normalized persisted shared-session records when loading the session broker store so existing project stores receive required current fields such as `kind`, `lastActivityAt`, and `pendingInputCount` instead of blocking daemon startup.

---

## [0.33.3] - 2026-05-05

### Fixed
- Aligned `GET /api/accounts` with the strict `accounts.snapshot` contract by returning the canonical provider account snapshot without channel account fields.
- Fixed `IntegrationHelperService.getAccountsSnapshot()` so provider records keep required `notes` and `routeRecords` fields instead of returning a lossy projection.
- Added daemon-route and integration-helper regressions for account snapshots matching the published contract shape.
- Aligned SSE/WebSocket runtime event envelope serialization with the public realtime transport schema by emitting `ts` instead of the stale `timestamp` field.
- Enforced the current shared-session response shape on daemon session routes so `sessions.messages.list` includes required fields such as `session.kind` and `session.lastActivityAt`.

---

## [0.33.2] - 2026-05-05

### Fixed
- Aligned the shared-session operator contract with the daemon route/runtime session record by adding required `kind` and `lastActivityAt` fields to generated `sessions.*` response schemas and client types.
- Added regression coverage for the `sessions.create` contract so the published operator schema accepts the same session payload returned by `POST /api/sessions`.

---

## [0.33.1] - 2026-05-05

### Fixed
- Hardened `PersistentStore` and `JsonFileStore` atomic writes against concurrent saves by giving each save a unique temporary file. This fixes a real automation-job persistence race observed in CI where one save could rename another save's shared `.tmp` file.
- Added regression coverage for concurrent `PersistentStore.persist()` and `JsonFileStore.save()` calls.
- Added Node 22 setup to the release validation job before Wrangler tests so the tag release path matches the main CI platform matrix environment.

---

## [0.33.0] - 2026-05-04

### Breaking
- Renamed platform error type aliases `ErrorCategory` → `PlatformErrorCategory` and `ErrorSource` → `PlatformErrorSource` in `@pellux/goodvibes-sdk/platform/types`. The platform-layer error hierarchy (`AppError`, `ProviderError`, etc.) is unchanged; only the type aliases were renamed to eliminate the public-surface name collision with the canonical `ErrorCategory` / `ErrorSource` from `@pellux/goodvibes-errors`. Consumers importing these aliases via `@pellux/goodvibes-sdk/platform/types` must update their imports.

### Added
- Removed the `validateEvent` alias from the public event contracts; `validateKnownEvent` is now the single runtime event validator.
- Tagged `daemon-sdk` `ExecutionIntent` alias (`type ExecutionIntent = unknown`) with `/** @public */` to align with the existing `AutomationSurfaceKind` widening pattern. Eliminates an api-extractor `ae-incompatible-release-tags` warning at the daemon-sdk ↔ platform-runtime circular-dep boundary.
- Documented `SessionManager.#observer` non-emission policy: the field is intentionally retained but observer notification lives in the `createGoodVibesAuthClient` facade (`auth.ts`), which has full priorToken awareness for `anonymous→token` vs `token→token` transitions. Emitting from `SessionManager` would produce duplicate transitions.
- Added `assertSameOriginAbsoluteUrl` helper in `@pellux/goodvibes-transport-http` and wired it into `requestJson` and `openServerSentEventStream` so absolute URLs that diverge from the transport's `baseUrl` origin are rejected with `ConfigurationError SDK_TRANSPORT_CROSS_ORIGIN` instead of silently receiving the bearer Authorization header.
- Added `requireAdmin` gates to all twelve state-changing handlers in `daemon-sdk/media-routes.ts` (voice TTS/STT/realtime, web search, artifact create, media analyze/transform/generate, multimodal analyze/packet/writeback).
- Extended `scripts/package-metadata-check.ts` to assert `engines.bun === "1.3.10"` and `engines.node === ">=22.0.0"` per workspace package, preventing future regressions where a package drops the engines pin.

### Fixed
- `docs/observability.md:9` no longer references a non-existent `sdk.observer` field; updated to instruct passing `observer` via `createGoodVibesSdk({ ..., observer })` or subscribing via `sdk.realtime.viaSse()` / `sdk.realtime.viaWebSocket()`.
- `examples/README.md` env-var table now documents `GOODVIBES_USERNAME` / `GOODVIBES_PASSWORD` required by `auth-login-and-token-store.ts`.
- `bundle-budgets.README.md` now documents the aggregate `./events` budget entry separately from the per-domain exclusions, with a pointer to the `domains` array for human reference.
- `docs/secrets.md:6` standardized on `**Public subpath:**` wording to match `docs/security.md`.
- Standardized cross-link footer headings on `## Next Reads` across `docs/getting-started.md`, `docs/observability.md`, `docs/wrfc-constraint-propagation.md`, `docs/performance.md` (previously a mix of `## Next reads` and `## Related`).
- `docs/observability.md` activity-logger snippet now uses `homedir()` + `path.join` instead of a hardcoded Linux path.
- `docs/companion-app-patterns.md` now cross-references `docs/companion-message-routing.md` for the `kind: 'followup'` taxonomy.
- `docs/getting-started.md:128` `authToken` type description now mentions the `undefined` member and points to `client.ts` JSDoc as canonical.
- `docs/error-kinds.md` clarified the two `err.code` namespaces (HTTP route-body codes vs. typed-error-subclass codes).
- `docs/realtime-and-telemetry.md` now declares its scope vs. `docs/observability.md` to clarify the intentional content overlap.
- `packages/sdk/src/platform/runtime/observability.ts` now carries a header comment documenting why this barrel uses named re-exports only (no `export *`), in contrast to sibling runtime barrels.

### Migration
- **Platform error type rename**: if you import `ErrorCategory` or `ErrorSource` from `@pellux/goodvibes-sdk/platform/types` (or the deeper `platform/types/errors` path), rename to `PlatformErrorCategory` / `PlatformErrorSource`. The canonical `ErrorCategory` / `ErrorSource` from `@pellux/goodvibes-errors` are the consumer-facing names and are unchanged.

---

## [0.30.5] - 2026-05-04

### Breaking
- none

### Added
- Closed docs and examples audit findings across `docs/`, `examples/`, `packages/sdk/src/client.ts`, and all package `package.json` files.
- Bumped all package versions to `0.30.5` to align CHANGELOG with source-of-truth.
- Fixed `docs/media-and-search.md`: removed non-existent `platform/media` subpath; corrected to `platform.media.*` namespace and `platform/multimodal` subpath.
- Fixed `packages/sdk/src/client.ts:48`: JSDoc example replaced broken `.then(events => ...)` form with correct synchronous `viaSse()` usage.
- Fixed `docs/security.md:226`: changed "Internal module" to "**Public subpath:**" for `platform/config`.
- Fixed five example quickstarts (`submit-turn`, `retry-and-reconnect`, `realtime-events`, `peer-http`, `operator-http`): replaced silent `?? null` authToken with explicit guard that throws when `GOODVIBES_TOKEN` is unset.
- Removed duplicate `> **Note:**` block from `docs/observability.md` after daemon-embedder gate was already present at section top.
- Updated `examples/peer-http-quickstart.mjs` clarification comment to reference `docs/public-surface.md` capability namespaces.
- Strengthened `examples/README.md` daemon-fetch-handler entry to describe the host callback boundaries explicitly.
- Added Route-Level Error Codes section to `docs/error-kinds.md` cataloguing `INVALID_KIND`, `PROVIDER_NOT_CONFIGURED`, `INVALID_REQUEST`, and other HTTP-route error codes.
- Removed lone JSDoc `@param` annotation from `examples/submit-turn-quickstart.mjs` for consistency with other `.mjs` examples.
- Added `(internal helper)` marker to `extractAuthToken` prose in `docs/auth.md`.
- Converted long companion-chat route list paragraph to a table in `docs/companion-message-routing.md`.

### Fixed
- none

### Migration
- none

---

## [0.30.4] - 2026-05-04

### Breaking
- none

### Added
- Closed docs and examples audit findings across `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, and package READMEs.
- Corrected default daemon control-plane port from `3210` to `3421` across all quickstarts, docs, examples, and package READMEs.
- Fixed sealed-path imports: `docs/automation.md` (`platform/automation` → `platform`), `docs/security.md` (`platform/permissions` → `platform` namespace), `docs/media-and-search.md` (removed non-existent `platform/media` subpath), `packages/contracts/src/zod-schemas/README.md` (`zod-schemas` → `zod-schemas/index`).
- Corrected `docs/wrfc-constraint-propagation.md`: `ConstraintFinding` is not exported from the SDK root; corrected to reflect `platform` namespace access.
- Fixed broken doc anchor in `examples/expo-quickstart.tsx`: `#websocket-not-available` → `#websocket-implementation-is-required`.
- Updated `SECURITY.md` lodash override version from `4.17.21` to `4.18.1` to match the pinned override in `package.json`.
- Corrected `docs/architecture.md`: `platform/pairing` is a public subpath, not an internal module.
- Refactored `examples/auth-login-and-token-store.ts`: replaced unidiomatic IIFE-throw pattern with explicit guard block.
- Added session TTL and rate-limit defaults to `docs/defaults.md`.
- Clarified `docs/observability.md`: `LOG_FLUSH_INTERVAL_MS` and `LOG_BUFFER_MAX` are internal constants, not exported configurables; added daemon-embedder note before `configureActivityLogger` example; added `STREAM_DELTA` to turn events table; added wire-up status table caption.
- Disambiguated `docs/companion-app-patterns.md` `POST`/`PATCH` guidance for companion chat sessions.
- Added public-surface cross-reference note to `docs/runtime-orchestration.md`.
- Clarified `docs/troubleshooting.md`: SSE mobile reconnection issues described precisely; added Next Reads section.
- Clarified `docs/feature-flags.md` `killed` state description.
- Marked internal functions in `docs/auth.md` scope flow list; aligned `client-auth` phrasing.
- Added clarifying note to `docs/error-kinds.md` WRFC synthetic critical issues section.
- Added Next Reads sections to `docs/automation.md`, `docs/voice.md`, `docs/troubleshooting.md`.
- Clarified `examples/README.md` guidance for `daemon-fetch-handler-quickstart.ts` host callbacks.
- Added usage hint comment to `docs/getting-started.md` daemon embed snippet.
- Added `peer-http-quickstart.mjs` operator.snapshot clarification comment.
- Closed docs and examples audit findings across `docs/`, `examples/`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- Reconciled `docs/public-surface.md` platform table with actual `packages/sdk/package.json` exports map; added `./client-auth` and `./observer` entries.
- Corrected `docs/authentication.md`: `autoRefresh: false` → `autoRefresh: { autoRefresh: false }`, `AutoRefreshCoordinator` import path corrected to `./client-auth`.
- Corrected `docs/retries-and-reconnect.md`: removed non-existent `generateIdempotencyKey` import from `transport-http`.
- Corrected `docs/error-handling.md`: `OperatorSdk`/`ControlSnapshot` replaced with `GoodVibesSdk`/`OperatorMethodOutput<'control.snapshot'>`.
- Fixed `docs/daemon-embedding.md` route-group list to reflect actual exported dispatchers.
- Replaced internal source file paths in `docs/secrets.md`, `docs/auth.md`, `docs/runtime-orchestration.md`, `docs/channel-surfaces.md` with public API references.
- Updated `examples/daemon-fetch-handler-quickstart.ts` to use the generated operator contract.

### Fixed
- none

### Migration
- none

---

## [0.30.3] - 2026-05-03

### Breaking
- none

### Added
- Expanded public seams used by TUI tests and examples without restoring
  private/deep import paths: ACP connections, adapter helpers, automation
  scheduler snapshot import, hook runner helpers, runtime lifecycle helpers,
  transport helpers, provider classes, runtime snapshots, media understanding
  providers, and built-in tool factories are now exported from their platform
  seams.
- Added automation store snapshot import coverage through the automation API.
- Added a runtime lifecycle facade that routes plugin, MCP, task, and
  compaction transition helpers through the explicit `platform/runtime` seam
  while keeping the subsystem-specific modules typed for direct consumers.

### Fixed
- Restored package-export-valid access for TUI test and example imports that
  still depended on SDK-owned symbols after the v0.30 public seam cleanup.
- `buildOperatorContract()` now includes the current-auth alias path metadata
  advertised by the daemon, and the shared contract type/schema accepts it.
- Transport diagnostics expose structured negotiation failure fields for current
  diagnostics consumers.

### Migration
- Continue using explicit `@pellux/goodvibes-sdk/platform/...` public seams
  listed in the package export map. Private source paths remain unavailable.

---

## [0.30.2] - 2026-05-03

### Breaking
- none

### Added
- Expanded the public `platform/runtime` seam for host-owned TUI and daemon
  composition: shell path helpers, provider account snapshots, system-message
  policy, command shell service contracts, diagnostics panels, eval helpers,
  forensics, sandbox, worktree, remote runtime, session persistence, return
  context, settings sync, ecosystem catalog, provider health UI data, and
  runtime read models are now available through the aggregate runtime entry.
- Expanded exported platform seams with SDK-owned symbols needed by host
  runtimes. Consumers should import only exact subpaths listed in the package
  export map.

### Fixed
- Restored package-export-valid public access for the TUI's production SDK
  imports without adding private source-path aliases.
- Background provider discovery now accepts both current host hook names used
  by SDK-owned bootstrap code.
- Ecosystem catalog reviews and install receipts expose `compatibility`
  alongside `runtimeFit`, matching the marketplace UI contract.
- Companion pairing token helpers now support scoped host calls and expose
  stale operator-token pruning through the public pairing seam.

### Migration
- Keep using exact `@pellux/goodvibes-sdk/platform/...` seams from the package
  export map. Do not import private SDK source paths.

---

## [0.30.1] - 2026-05-03

### Breaking
- none

### Added
- Added deliberate public SDK seams for daemon host runtimes that need to
  compose GoodVibes platform services without importing private source paths.
- Added public runtime subpaths for event bus, feature flags, network helpers,
  runtime store, store domains, and store reducer helpers.
- Added public config subpaths and aggregate exports for secrets, secret
  references, service registry, provider subscriptions, helper model,
  OpenAI Codex auth, and tool LLM support.

### Fixed
- `platform/tools` now exports the SDK-owned `ToolRegistry`, `ProcessManager`,
  and `AgentManager` classes required by daemon/TUI runtime composition.
- `platform/providers` now exports `ProviderRegistry`, so host runtimes can
  wire provider catalog, routing, and model state through the public provider
  seam.
- Host-runtime composition moved to explicit platform subpaths instead of
  private source imports.

### Migration
- Replace private deep imports such as `config/manager`,
  `runtime/feature-flags`, `runtime/network`, `utils/logger`, and
  `daemon/server/http-listener` with corresponding explicit platform public
  seams.

---

## [0.30.0] - 2026-05-02

### Breaking
- The SDK source mirror system has been removed. Sibling packages such as
  `@pellux/goodvibes-contracts`, `@pellux/goodvibes-transport-http`,
  `@pellux/goodvibes-peer-sdk`, and `@pellux/goodvibes-operator-sdk` are now
  the source of truth and `@pellux/goodvibes-sdk` re-exports them through
  deliberate facade entrypoints.
- Arbitrary `@pellux/goodvibes-sdk/platform/*` wildcard imports are no longer
  public API. Use the explicit package exports documented for v0.30.0.

### Added
- `bun run contracts:check` replaces the old mirror-oriented `sync:check`
  command and checks generated contract artifacts only. It does not check or
  regenerate SDK mirror source because mirror source no longer exists.
- v0.30.0 documentation now describes the facade package, source-of-truth
  sub-packages, explicit exports, runtime surfaces, base knowledge refinement,
  generated pages, and Home Graph as an extension.
- CI now rejects ordinary skipped/todo tests and folds lint-style gates into
  the validation path.

### Fixed
- Deleted the stale `packages/transport-direct` workspace artifacts; the public
  SDK subpath now remains only as a facade over `transport-core`.
- Home Graph generated-page refresh now batches graph writes, skips missing
  extraction text explicitly, and indexes page source relationships before
  rendering device passports.
- WebSocket realtime errors now preserve close/error event fields and outbound
  queue overflow uses a typed transport error.
- Peer/operator clients share contract input merging, reject excess helper
  arguments, expose disposal hooks, and derive available Zod response schemas
  from contract schema exports.
- The HTTP contract response validator now checks common JSON Schema `format`
  constraints.
- Retryable HTTP status codes now use the canonical
  `@pellux/goodvibes-errors` list everywhere, so SDK platform helpers,
  transport retry policy, and structured HTTP errors agree on 408, 429, 500,
  502, 503, and 504.
- CI no longer runs dead mirror deletion guards. The mirror-drift job is
  replaced with a contract-artifact check that matches the current
  source-of-truth architecture.
- Large semantic and Home Graph route tests were split into focused files with
  shared fixtures.

### Migration
- Remove any workflow or local command that calls `bun run sync:check`,
  `scripts/sync-check.ts`, `scripts/sync-sdk-internals.ts`, or
  `bun run sync --scope=...`; those tools were deleted or renamed with the
  mirror system.
- Replace old deep imports into SDK mirror or platform wildcard paths with
  explicit v0.30.0 exports.
