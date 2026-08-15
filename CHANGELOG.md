# Changelog

This file tracks breaking changes, additions, fixes, and migration steps for each release of `@pellux/goodvibes-sdk`. Every release **must** have a corresponding `## [x.y.z] - YYYY-MM-DD` section before it can publish — the changelog gate refuses a release the file does not describe.

## [2.0.16] - 2026-08-15

### Fixed

- **One tool schema no longer breaks every turn through strict
  OpenAI-compatible gateways.** The edit tool's `occurrence` parameter
  declared its string-or-integer union with the JSON-Schema keyword `oneOf`.
  Some OpenAI-compatible request validators — abacus RouteLLM among them, as
  of a recent server-side tightening — forbid `oneOf` inside tool parameter
  schemas and reject the ENTIRE chat request with "Extra inputs are not
  permitted", so every conversational turn through such a provider failed no
  matter what was asked. The union is now `anyOf`, which validates
  identically for these disjoint branches and is the keyword OpenAI's own
  function-calling schemas use. A wire-compatibility test walks every tool
  schema module and keeps `oneOf` from coming back.

## [2.0.15] - 2026-08-08

### Fixed

- **The keep-awake inhibitor can no longer paint an authentication prompt over
  a running terminal UI.** When the platform holds a sleep inhibitor during
  real work (`power.inhibitWhileWorking`), a host whose polkit rules require
  authentication for that inhibit class — typical for tmux or SSH sessions
  that logind does not count as an active seat — got systemd's interactive
  auth agent registered on the controlling terminal: "authentication is
  required to inhibit system sleep", written straight over the fullscreen UI
  on every submitted turn. The inhibitor is now requested with
  `--no-ask-password`, so a polkit refusal is an immediate silent exit that
  lands in the already-handled denied-classes path: the platform simply runs
  without the inhibitor there, exactly as it does on hosts with no logind at
  all. Pinned by a test on the inhibitor argv. Setting
  `power.inhibitWhileWorking: false` remains the way to opt out of keep-awake
  entirely.

## [2.0.14] - 2026-08-08

### Fixed

- **Post-wake capture ends when the speaker stops, on real microphones.** Two
  things defeated the room-measured silence floor in live use. A headset's
  automatic gain control ramps its gain back up after speech stops, so the
  noise floor RISES above the level measured before the wake word — no frame
  ever reads as silent again. And a close microphone hears breath: each short
  burst reset the consecutive-silence clock to zero. The floor now follows the
  room during capture — a rolling minimum over the last 1.5 seconds tracks the
  quiet dips between words, and the effective floor rises with it, guarded so
  it can never climb into actual speech (capped at a third of the tracked
  speech level). And a loud burst shorter than `voice.wake.speechRetriggerMs`
  (new setting, default 150 ms; 0 restores the strict old rule) counts as part
  of the silence instead of restarting the clock — breath and mouse clicks no
  longer hold the microphone open. An explicit `voice.wake.silenceFloorRms`
  still freezes the floor completely: a pinned value is pinned.
- **Every completed wake capture now leaves a receipt** in the voice
  diagnostics: the floor it started with, where the rolling floor ended, why
  the capture stopped (silence, ceiling, requested), how long it ran, and how
  many sub-threshold bursts were absorbed. "It kept listening" is a number now.

### Added

- **Spoken output reads prose, not markdown.** The shared spoken-turn pipeline
  strips formatting before synthesis: heading marks, bold/italic/strikethrough
  markers, link and image syntax (the text survives, the URL does not), list
  bullets, blockquote marks, table plumbing (cells read as a list), horizontal
  rules, and raw HTML tags. Fenced code blocks are not read at all — the voice
  says "Code block omitted." once, even when the fence opens and closes across
  separate streaming deltas. Identifiers like snake_case and math like 2*3
  survive untouched.

## [2.0.13] - 2026-08-07

### Added

- **`platform/runtime/bootstrap`, `platform/runtime/security`,
  `platform/runtime/shell`, and `platform/runtime/transport` are now published
  subpaths.** Products that alias names out of these runtime surfaces had only
  the grouped namespace objects to reach them through, which forced eager
  module-scope reads (`export const X = bootstrap.X`) in their own barrels.
  Bun's single-file compiler emits module bodies in an order that varies
  build-to-build, and an eager read can land before the module that defines the
  binding — the compiled binary then dies at load with a ReferenceError on SOME
  builds of identical source (observed live: the same agent commit failed CI's
  binary smoke, passed it on rerun, and failed the darwin-arm64 release leg).
  With registered subpaths, a product barrel can use grouped live re-exports
  (`export { X } from '<subpath>'`) — resolved by the module system, not read
  at module scope — exactly how `platform/runtime/operations` already fixed
  this same class once. All four barrels were already public API through the
  runtime namespace; this changes how they can be reached, not what they
  expose.
- **The toolchain `post-build-smoke` now scans the artifact for that pattern.**
  After the banner check, the smoke reads the compiled artifact and fails if
  the embedded bundle contains any top-level `var X = exports_Y.Z` eager
  namespace read — even when this particular build booted, because the next
  rebuild of the same source can reorder and die. A booted binary is safe
  forever (order is baked at build time); the sentinel exists so the lottery
  itself cannot ship.

## [2.0.12] - 2026-08-06

### Fixed

- **Post-wake capture now ends when you stop talking, in a room that is not
  silent.** The level at which a frame counted as silence was a fixed constant
  (180 on the int16 magnitude scale, about -45 dBFS). In any room whose steady
  background sits above it — a fan, a compressor, traffic through a window — no
  frame was ever silent, so `voice.wake.silenceStopMs` never accumulated and
  EVERY capture ran the full `voice.wake.captureMaxSeconds` however long ago the
  speaker had finished. The floor is now measured per utterance from the audio
  captured just before the wake fired, and placed 12 dB above the room's own
  noise. That window is mostly the wake phrase itself, so the measurement reads
  the quiet frames inside it — inter-word gaps and stop closures, where only the
  room is left — rather than its average level, which would measure the speaker
  and put the floor over their head. The measurement is clamped into [180,
  1440]: it can never fall below the old constant, so a genuinely quiet room
  behaves exactly as before and no sentence starts getting clipped, and it can
  never rise past the point where the next thing above the floor would be the
  speaker. With no pre-roll to measure, the constant stands unchanged.

### Added

- **`voice.wake.silenceFloorRms`** pins the silence floor instead of measuring
  it. 0, the default, measures. A number is used exactly as given, including
  below the built-in 180 — raise it if capture keeps running after you stop,
  lower it if capture cuts off while you are still speaking. It reaches both
  capture paths, post-wake and push-to-talk.
- **`voice.wake.captureMaxSeconds: 0` removes the ceiling.** Speech-to-text
  imposes no length limit of its own, so the ceiling was always policy rather
  than a technical bound, and a long dictated thought is a real thing to want.
  The default stays at 10: the ceiling is the backstop for the OTHER stop
  condition failing, and silence-stop is only dependable now that the floor is
  measured — which is why these two ship together. With the ceiling off, silence
  (post-wake) or the key release (push-to-talk) is the only thing that closes
  the microphone.

- **The exec sandbox note now names the way through the boundary, not only the
  boundary.** A network-isolated run already said host `localhost` services were
  unreachable and that the daemon on 127.0.0.1 would refuse connections from
  inside. Being told only what does not work left the next move unstated, and a
  turn that wanted daemon or settings state kept reaching for it anyway — a
  second `curl`, then `systemctl`, then a port check. The note now names the
  built-in tools that answer those questions from outside the boundary:
  `goodvibes_context` (`summary` for runtime and daemon state, `config_get` for
  a setting) and `goodvibes_settings` for changing one. Still one line.

## [2.0.11] - 2026-08-06

### Fixed

- **An unnamed voice request now goes to the provider the user actually
  configured.** When a transcription or synthesis request named no provider,
  the registry returned the FIRST registered provider with the capability —
  a cloud provider, by builtin registration order — even when that provider
  had no key and the host carried a fully provisioned local engine. On a
  machine set up for local voice, every wake-word transcription died with
  "OpenAI API key missing" while the user's working whisper was never asked,
  and no settings key could override the pick. Unnamed requests now prefer
  providers that report themselves configured, with a configured local
  engine first (free, offline, no key — provisioned precisely so unnamed
  requests use it), then any other configured provider in registration
  order. When nothing is configured the old first-registered pick remains,
  so the resulting error still names one concrete provider. A named
  provider keeps exactly its previous semantics, for all four capabilities
  (speech-to-text, synthesis, streaming synthesis, realtime).

## [2.0.10] - 2026-08-05

### Fixed

- **A new turn is no longer finished by the previous turn's ending.** A client
  opened a fresh event stream per turn and presented no `Last-Event-ID`, so the
  gateway's catch-up replay handed the new stream the tail of the previous turn
  — that turn's `TURN_COMPLETED` included. The frame appended the previous
  turn's final assistant message a second time (the store-boundary dedupe
  already covered that symptom and stays; an honest crash-replay produces it
  too) and, worse, marked the new turn's renderer finished, so every real frame
  of the turn actually running was dropped as post-terminal noise. That turn had
  already been billed for. Fixed at the cause on both sides: an SSE stream now
  surfaces the position it reached (`onEventId`, and `lastEventId` on the
  handle it returns), the runtime-event connector remembers that position per
  URL across stream LIFETIMES rather than only across one stream's own
  reconnects, and the gateway — which did honour the header — no longer falls
  back to the full catch-up window when it cannot resolve the position it was
  handed. Event ids are random per record, so an id that has aged out of the
  ring cannot be compared against one that has not; a client stating a position
  now gets silence and a stated `resume` outcome on the `ready` frame instead of
  a guess that costs a turn.
- **A terminal frame can only finish the turn its consumer is rendering.**
  Defence in depth for the replays resumption cannot prevent. Turn frames carry
  a `turnId`, and the new turn-lifecycle gate (`createTurnLifecycleGate`) binds
  per session to the turn that session was last seen to START: a frame for any
  other turn is ignored, and a terminal frame for a turn the consumer never saw
  run is refused outright rather than allowed to bind. A client attaching
  mid-turn still renders the turn in flight, and frames carrying no `turnId` are
  never withheld. On by default in the SDK's own SSE clients — a consumer that
  passes nothing is protected; `turnScope: { turnId }` pins a connection to a
  turn it submitted, `turnScope: 'off'` opts out.
- **One hosted turn no longer starves every session's heartbeat.**
  `HostedSessionSpineIntake.tick()` awaited delivery — the whole turn — inside
  its own re-entrancy guard, so while any ONE hosted session was answering, no
  other session was heartbeated on the shared spine. A hosted session whose
  spine participant goes stale stops receiving its own steers and starts getting
  background agents instead: the conversation keeps answering, from the wrong
  thing. The stale clocks also read as idle to the session reaper, which is how
  a session with a turn plainly still running was closed "idle-reaped" (the
  liveness probe covers the reaper's symptom; this is the starvation under it).
  The guard now covers SCHEDULING only, and delivery is detached into a
  per-session lane: a session's own turns stay serial and in order, other
  sessions do not wait behind them, a tick that fires mid-turn never hands the
  same message over twice, and an error out of a detached delivery is reported
  exactly where `tick()` used to report it. `drainDeliveries()` is there for a
  caller that needs the outcome rather than the scheduling.
- **A turn nobody is watching no longer falls back to the host.** The exec
  sandbox always answered "is there a boundary for this command", and when the
  answer was no — the gate off, `sandbox.enabled` off, or the host unable to
  provide one — the command ran directly on the host with an honest note. For a
  terminal that is right; for a daemon-hosted conversational turn it was how one
  reached the whole process table, the owner's `/proc`, and his terminal. A
  composition now states a CONTAINMENT POSTURE: `host-allowed` is the unchanged
  default, and `required` refuses the command instead, naming why the boundary
  was absent. `background: true` is refused under `required` too, since a
  detached command cannot be contained at all. Hosted sessions are `required`
  by default, and a `workstream` spawn is granted the host per spawn by the
  product composing it — never by the model, the wire, or a tool argument.
- **The frozen catastrophic block now runs on the detached path too.** A
  `background: true` command returned before `runCommand`, so everything checked
  there was not checked for it — including the unconditional block the exec docs
  describe as always in force. Measured on a real host under the daemon's own
  service environment: an identical witness command reported 5 processes and a
  masked `$HOME` in the foreground and 581 with `$HOME` readable in the
  background. The boundary itself never failed; this path never entered it. The
  guard call moved to the one point every path goes through. The boundary
  exemption for detached commands is legitimate and stays — a bwrap boundary is
  `--die-with-parent` — but it is no longer silent, and the LIST is untouched:
  this changes where the existing block runs, never what is on it.
- **The owner's terminal is untouchable.** A new exec guard refuses a command
  that drives an existing tmux session, window or pane this platform did not
  create — send-keys, kill, resize, attach, respawn, rename — with a refusal
  naming the rule. Ownership is by name (`goodvibes-…`, plus names a
  composition registers), because a pane id proves nothing about who made it.
  Creating and driving the platform's own sessions stays allowed, and so does
  reading tmux state. Off unless a composition enforces it; hosted sessions
  enforce it in every posture. The frozen catastrophic block is untouched.
- **A surface home can refuse a second live writer.** `claimSurfaceHome`
  records the owning pid at `<home>/.goodvibes/<surface>/owner.json` and a
  second LIVE process claiming the same home is refused by name, so a second
  agent forked onto a live home stops at boot instead of racing the first over
  its session store. Every uncertainty resolves toward letting the boot proceed:
  a dead pid, a recycled pid now running something else, and an unreadable
  record all read as "nothing holds this home". Opt-in per composition
  (`homeSingleWriter: 'claim'`), because a terminal is legitimately run twice.

### Added

- `CONVERSATIONAL_DIAGNOSIS_SECTION` — the DO half of the conversational
  contract, issued to conversational spawns and to a hosted session's base
  prompt: report the state and propose the fix rather than performing it
  uninvited, never restart the owner's applications or type into his terminal,
  and back a "fixed" claim with the live evidence it rests on.

## [2.0.9] - 2026-08-05

### Fixed

- **Two writers of one store no longer destroy each other's work, and a store
  that cannot be written no longer kills the process.** Every atomic write now
  uses a temp file named per write instead of per process, and the sweep of
  leftovers only reclaims files old enough to be crash debris — a temp file
  still being written by another process, or by this one on another thread, is
  left alone. Periodic snapshots that rebuild themselves (the watcher store
  first among them) write through a variant that logs the path and errno and
  returns the failure, so a save that fails inside a background tick is a log
  line rather than the end of the process.
- **A dead runtime record can no longer make the platform unreachable.** The
  daemon endpoint record is a hint now: liveness-checked before trust, reaped
  with a receipt when stale, and discovery falls through to the live daemon.
  Reads and writes of daemon-owned settings share one resolution, so a
  successful write is immediately readable.
- **Wake-word transcription is daemon-first.** A surface ships captured audio
  to the connected daemon's speech-to-text and falls back to its own process
  with a stated reason — which process owns the engine stops mattering.
  Failures leave evidence (provider, config source, exception) in diagnostics
  instead of vanishing with the notification.
- **Reminders respect being heard.** An occasion nudge raises once at the
  lead boundary and at most once on the day; between those it stays open and
  enumerable but quiet. Replying to a reminder records an acknowledgment in
  the same turn and mutes that occurrence; a remember-only occasion about the
  owner himself never pushes at all. Machines already over-nudged reconcile
  on first boot, receipted. The complaint remedy ladder is contract: mute the
  occurrence, adjust the occasion, and whole-feature-off only on an explicit
  feature-naming yes.
- **Exec output never lies by omission.** Truncation carries a counted marker
  at every verbosity for both streams; the sandbox states its own isolation
  in results; and the permission guard's classifier no longer denies ordinary
  diagnostics (null-delimited reads, file-reading substitutions) while
  backtick command-name assembly — previously invisible to the parser — is
  now caught structurally. The frozen catastrophic list is untouched.
- The tool-activity label holds still: it names the tool instead of streaming
  its argument characters.

### Changed

- **Provisioning proves itself.** The managed voice installer repoints paths
  that belong to superseded manual installs (naming each replaced path in the
  receipt), only when a managed root is known and only across a path
  boundary, and ends with a spoken-and-transcribed round trip — "provisioned"
  is only ever reported after the proof passes.
- **Setup completes the inferred intent.** A general setup contract ships:
  complete the ask, propose inferred extensions with a one-line approval,
  ask short questions at genuine forks, and never hand the user a command —
  with the four solution shapes (guided walkthrough, managed browser
  automation, official CLI, question-driven up to an outcome interview)
  stated generally. Wake-word setup implies speech-to-text as its first
  instance; the Google walkthrough ends with paste-the-values-here and a
  same-reply consent link via the new non-blocking consent session.
- Clipboard image paste is platform machinery (Wayland and X11), with an
  honest named-package message when no reader exists.
- `occasions.finalStretchDays` is retired — under the two-touch cadence it
  governed nothing. Files carrying it migrate with a receipt (owner-only on
  disk, in-memory for readers) and load clean.

## [2.0.8] - 2026-08-05

### Fixed

- **The daemon's answers match its own contract, and a test now proves it.**
  `profile.get` leaked two internal properties past a strict schema, so every
  strict client's profile reads failed ("Ensure the daemon is running the
  matching GoodVibes contract version") — the daemon could not tell its owner
  his own address. The response is now an explicit wire projection, `section`
  is a declared contract property, and `profile.provenance` correctly declares
  its null for hand-edited fields. A conformance test runs the real route
  handlers' responses through the same validator clients use, across the whole
  profile and occasions families.
- **Session event streams carry what the agent did, scoped to the session.**
  The hosted-session event stream omitted the tools domain (a remote viewer
  saw everything said, nothing done) and delivered every session's frames down
  one session's stream. Render-grade domains and per-session scoping now, in
  the companion-chat stream too.
- **One control-plane store.** A path-derivation defect made every daemon boot
  rewrite a legacy unscoped store the broker never reads. The fold now takes
  its path from the broker, legacy duplicates are quarantined with a receipt,
  and the stores that still lived only at the legacy location migrate to the
  surface-scoped home on boot, receipted and idempotent.
- **Browser automation cannot touch your browser.** Managed launches resolve
  only into the platform's own profile directory (traversal-hardened), one
  session is reused instead of relaunch-looping, retries are capped, unknown
  tool errors name the tools that exist, and the engine refuses to type into
  sign-in pages — it hands the URL back instead.

### Changed

- **Connecting Google is one action.** Discovery decides the path before
  anything runs: a stored credential proves itself with zero actions; a stored
  client goes straight to one consent URL carrying every needed scope (mail
  read, send, calendar) in a single consent; a signed-in gcloud CLI is a real
  source; the guided path never mentions credential files (their download flow
  is not documented by Google) and costs exactly one copy-paste for a stated
  reason. No filesystem scanning — a credential file is used only when you
  point at it. A dead grant is diagnosed once in plain words (including the
  wrong-account case) instead of retried; removing a stored credential takes
  your explicit yes; a finished run proves itself with a live mail and
  calendar read.
- **Dialing the connected host has its own switch.** `daemon.enabled` kept its
  historical meaning and silently disabled half the platform's dial paths on
  machines that set it. It now means only "adopt your own daemon";
  `daemon.connectedHost.enabled` (default on) governs dialing, with a
  receipted migration for existing files.
- The settings catalog carries the connector keys the daemon really reads
  (calendar, google, email — 22 described settings), and operator catalog
  search understands plain words like "google" instead of answering nothing
  out of 434 methods.

## [2.0.7] - 2026-08-02

### Changed

- **A conversational turn is told to understand what it captures, not just
  file it.** The capture contract now instructs the turn to read what a shared
  thing implies and fold that into the same answer — an itinerary also means
  an away-span said back in plain words, travelers who are people in his life,
  and durable facts about the destination — and then to USE what it stored:
  name collisions with existing plans and offer the obviously useful next
  things once (a reminder before departure, weather at the destination).
  Capturing and inferring are part of answering; anything beyond the
  conversation — booking, monitoring, a standing job — is still proposed and
  waits for a yes.

## [2.0.6] - 2026-08-02

### Fixed

- **A conversation stays a conversation.** The conversation gate's explicit
  no-chain decision is now authoritative: the keyword heuristic that
  normalizes review-shaped root tasks into write-review-fix-confirm chains
  yields to a caller that suppressed the chain, so a chat message whose
  transcript happens to contain "review the route" gets an answer, not an
  owner/engineer/reviewer chain. A declared reviewer/tester template is still
  normalized — naming the role is a statement, matching prose is a guess.
- **The reply a person sees is the answer.** A chained agent's recorded
  output now carries what it actually found or did; the chain status line
  ("passed (review 10/10); commit skipped …") stays with the operator
  progress feed and the chain journal, and never rides a channel reply.
- **Each answer appears once.** The two agent-completion reporters (runtime
  bus and the pending-reply poller) raced and could store the same reply
  twice; the session broker now stores one completion per agent.
- **The daemon settings file is rewritten only by the daemon.** Clients
  applying the payments-budget rename migrate their in-memory view and leave
  the file bytes untouched — no write, no receipt. The daemon folds the
  rename, the receipt, and a reader floor into one atomic write, so an older
  reader refuses loudly, naming both versions, instead of silently skipping
  the owner's spending limits.
- **A chat session is filed as a chat.** Channel-originated sessions get the
  new home-scoped `channel` kind derived from their surface instead of
  defaulting to a TUI project session rooted in a filesystem path, rollover
  re-derives the classification, and a sender on the channel's owner
  allowlist is attributed as the owner principal instead of unknown.

### Added

- **Personal information shared in conversation gets captured.** A
  conversational channel turn — which previously spawned with zero tools —
  now carries read/find/fetch plus the new `profile` capture tool, bound to
  per-run owner authority that never travels in tool arguments. A pasted trip
  itinerary lands in the owner profile's Plans section with its dates,
  flights, travelers and confirmation number, and the reply states concretely
  what was stored. Configurable via `profile.conversationalCapture` (default
  on) and `profile.ownerChannels` (defaults to the occasions nudge channel).

## [2.0.5] - 2026-08-02

### Changed

- **Money settings hold the amount you would say out loud.** The payment
  budget keys drop their unit suffix — `payments.budget.perPurchaseCeiling`,
  `dailyItem`, `dailyOverage`, `overageToleranceDailyAllowance` — and hold
  plain amounts in the configured currency: `100` is a hundred dollars,
  `19.99` is nineteen ninety-nine, written exactly as you gave them, decimals
  allowed and never forced. `$100`, `100.00` and `100` all mean the same
  hundred. Existing files migrate on load with a receipt; your limits are
  unchanged, only how they are written. Money detection is schema-typed now
  (`unit: 'money'`), not name-sniffed.

### Fixed

- **Every platform state store writes atomically and survives corruption.**
  The watcher-store fix is now the platform rule: one shared helper gives
  every JSON store the temp-fsync-rename write and the quarantine-with-
  receipt load, so a power loss mid-write can never leave a torn file, and a
  corrupt file from any cause costs a rebuilt cache with the evidence
  preserved beside it. Eighteen stores converted outright; a handful keep
  deliberately stronger contracts (the secrets store refuses writes to an
  unreadable store rather than moving your secrets aside; the daemon settings
  tier still refuses to boot on an unparseable file, because defaults may be
  more permissive than what the file held).
- The owner-profile composition honors an injected home directory — an
  embedder's runtime can no longer fall through to the login home's profile.

## [2.0.4] - 2026-08-02

### Fixed

- **A corrupt watcher snapshot can no longer take the daemon down.** Snapshot
  saves are atomic — written to a sibling temp file, flushed to disk, renamed
  over the target — so a power loss or hard freeze mid-write leaves the old
  snapshot intact instead of a torn file. And a snapshot that is corrupt
  anyway (the live incident: a host freeze left valid JSON followed by NUL
  bytes, and the daemon crash-looped parsing it — once at boot, once on a
  periodic tick 47 seconds in) is quarantined beside the store with a receipt
  naming what happened, bounded so a flapping writer cannot fill the disk,
  and watcher state rebuilds from live registrations. Both halves apply to
  every consumer of the store: daemon, terminal app, agent.
- The "not a profile field" refusal names the valid field ids. It used to
  cite a documentation section — useless to the model that just guessed a
  wrong id mid-conversation, which is exactly who receives it. All refusal
  sites (set, forget, undo, and the HTTP route) now enumerate the real
  catalog from one shared formatter.

## [2.0.3] - 2026-08-01

### Fixed

- A client that inherited a daemon's bind host no longer gets refused as
  "insecure PUBLIC transport" when that host is a wildcard. `0.0.0.0` and `::`
  are listen addresses; as dial targets they reach the local machine, so the
  transport now classifies them with loopback and the other private-network
  origins. The live failure this ends: a daemon deliberately bound to
  `0.0.0.0` for LAN access left every client that imported that host unable to
  call it — profile reads included — over plain http.

### Added

- `@pellux/goodvibes-terminal-shell` exports the shared conversation fold
  policy: `foldedToolResult`, `trailingBlankAfterRow`, `foldPreviewText`, and
  their thresholds. A folded transcript block is exactly one row — the header
  with its `▸ N lines` badge and the content's head riding the same line; no
  frame rows, no interior padding, no separate hidden-count marker, and no
  blank rows between consecutive folded tool rows. Both terminal products
  read these decisions from here so their renderers cannot drift apart again.

## [2.0.2] - 2026-08-01

### Fixed

- Client bundles can no longer reach in-process daemon composition code. The
  shared runtime bootstrap still carried two pre-split remnants — default
  service factories that dynamically imported `platform/daemon`'s server and
  HTTP listener — kept for an `embedDaemonInProcess` option nothing has passed
  since the daemon became its own product. Bundled into a client, those
  dynamic imports fractured the bundler's module-initialization graph: the
  turn engine could call functions from modules whose constants were never
  initialized, and every conversation turn in the packaged Agent died on its
  first message classification with a swallowed error. The default factories,
  the embed option, and the embed branch are gone; a host that enables the
  HTTP listener without injecting a factory now gets an honest "composed by
  the daemon product" status instead of a silent in-process composition. A
  source-level test pins that no static or dynamic import from the bootstrap
  reaches `platform/daemon` again.

### Changed

- The daemon adoption policy no longer has an embed input or an embed ruling:
  a host adopts an external daemon or spawns the detached standalone binary,
  and a failed detached spawn reports `unavailable` instead of quietly
  standing up an embedded daemon that the split retired.

## [2.0.1] - 2026-08-01

### Fixed

- `display.themeMode` is a declared setting. The light/dark appearance
  preference (auto | dark | light) existed only as a terminal-app-private
  descriptor, so every other component reading a settings file that carried it
  reported an unknown key on boot. It is a schema key now, beside
  `display.theme` (the color palette — the two are independent and their
  descriptions say so), with the same values and default it always had; stored
  values keep working unchanged.
- The hosted-session steer test waits for the acknowledgements it asserts
  instead of racing them, and the secret scanner carries fingerprints for the
  two deliberately key-shaped redaction fixtures at their rewritten-history
  hashes.

## [2.0.0] - 2026-08-01

### Added

- **The reachability check and the composition wiring (`platform/runtime`).**
  `reachability-check.ts` answers, at every boot, whether this is the build the
  shell actually reaches and whether it is the current release: the PATH scan,
  the bounded `--version` probe, the self-directory resolution, and the bounded
  latest-release lookup, with the notice wording in `reachability-notice.ts` and
  the install-kind question it turns on in `install-kind.ts`. WHERE the lines go
  stays with the product, because only the product knows what it can print with
  at that moment; `fallbackUpdateCommand` takes the package name for the same
  reason.

  Alongside it, the composition wiring each surface had a copy of: the agent
  graph, the channel registry, remote execution, idle power and the live-turn
  holder, managed voice setup, the session-storage handle, the code index, the
  legacy memory fold, the surface feature-flag gates and the feature-settings
  queries, and workspace registration and trust. The four that differed did so
  in exactly one way — the storage scope they wrote under — so
  `createSessionStorageServices`, `createCodeIndexServices`, `codeIndexDbPath`,
  `createStoreRerooter`, `WorkspaceTrustManager`, `detectPriorWorkspaceState` and
  `readPersistedWorkspaceTrust` take a `surfaceRoot` and the difference is gone.

- **The engine policy every surface product was writing twice (`platform/config`,
  `platform/runtime`, `platform/rewind`, `platform/pairing`, `platform/providers`,
  `platform/orchestration`, `platform/workflow`, `platform/state`, `platform/types`).**
  Twenty-five modules that answer the same question on every surface now answer
  it in one place: how a durable file is written (`atomicWriteFileSync`) and read
  back with its version gate and quarantine (`readVersioned`,
  `reapQuarantinedFiles`); what a crash leaves behind and who reclaims it
  (`runDurabilityHousekeeping` / `startDurabilityHousekeeping` over transcript
  journals, liveness markers, quarantine files and rewind-anchor sidecars, plus
  `createDurabilityServices` wiring them beside the snapshot scheduler and the
  permission rule store); where a session's WAL journal
  (`openTranscriptJournal`, `replayJournal`) and multi-instance liveness marker
  (`writeLivenessMarker`, `checkSessionLiveness`) live; the rewind turn-anchor
  registry (`recordTurnAnchor`, `resolveTurnAnchor`) and its optional sidecar;
  what a model costs and when a budget is breached (`resolvePricing`,
  `calcSessionCost`, `computeBudgetBreach`, `readBudgetAlertUsd`); the stable
  name a printed or QR pairing link should carry (`resolveStableHost`,
  `resolvePairingWebOrigin`, `mintPairingHandoff`) and the plain-language offer
  and posture copy that goes with it; the unfocused-alert gate (`FocusTracker`,
  `shouldFireAlert`); the memory-governor status projection; the daemon
  credential-status fold (`deriveCredentialAvailability`); the per-project work
  plan (`WorkPlanStore`); and the workstream draft a human reviews before
  anything is spent (`createWorkstreamServices`, the draft store, the item edits
  and the best-of-N validation).

  Everything here is policy over an injected shape, so nothing decides something
  a product owns. `WorkPlanStore` takes the surface root it writes under and the
  source it records. `resolveDaemonCompanionToken` takes the peer name it mints
  under, and `workspaceOperatorTokenCandidates` takes the surface root it looks
  under. `turn-anchors` is two layers — an in-memory registry that touches no
  disk, and an opt-in per-call sidecar for hosts that want anchors to survive a
  resume. `resolvePairingWebOrigin` reads the stored `web.*` keys and resolves
  the port through `resolveWebPort`, the same resolver that binds the listener,
  so a printed origin can never name a port nothing is listening on. And every
  priced answer in `session-cost` goes through `computeUsageCostUsd`, so cache
  traffic is billed at its own rate in exactly one place.

- **Daemon-hosted sessions (`platform/hosted-sessions`, `sessions.hosted.*`).**
  A conversation loop composed INSIDE the daemon: the same `Orchestrator`, the
  same `registerAllTools` registry rooted at a workspace, the same permission
  manager with whatever ask seam the product wired. Until now the daemon could
  SEE a surface's sessions and steer them, but the loop always ran in the client,
  so closing the client ended the work.

  One workspace floor is shared by every session in that workspace, not one per
  session. The floor's cost is a provider model-discovery pass, config file
  watchers, a plugin manager, an MCP registry and a project index — per-machine
  or per-workspace truths that duplicate badly, and two sessions editing one tree
  with two file caches would disagree about the file they both just wrote. What
  differs per session is the conversation, the queued mid-turn messages, the
  tool-call aborts and context accounting, and that is what the per-session
  `Orchestrator` and its own tool registry own. Floors are reference-counted and
  released when their last session goes.

  Five verbs, lifecycle only: `sessions.hosted.create/attach/detach/kill/list`
  (ws-only invoke, like `approvals.raise` — no REST binding).
  Driving a hosted turn uses the verbs that already exist — `sessions.steer`,
  `sessions.followUp`, `sessions.toolCalls.cancel`,
  `sessions.queuedMessages.*` — which now resolve a hosted session's id the same
  way they resolve the daemon's local runtime (`SessionLiveTurnControlsHolder`
  gained per-session bindings). Streamed tokens and tool events need no new
  channel either: the hosted loop is the ordinary orchestrator, so it emits them
  on the `turn` and `tools` runtime domains stamped with the hosted session's id,
  and the control-plane SSE stream already forwards those. The new
  `control.hosted_session_update` event carries lifecycle only.

  A steer reaches a hosted turn through the machinery that already routes one:
  the broker queues an input for a session's live SURFACE participant, and for
  a hosted session the engine IS that surface, so it collects the queued input
  and hands it to the loop (`HostedSessionSpineIntake`) — the same contract
  `createWireSessionDispatch` implements for a client across the wire. The
  participant heartbeat rides the same tick, because a stale one would make the
  broker spawn a background agent instead: the conversation would keep
  answering, from the wrong thing.

  `ProviderRegistry.listDiscoveredServers()` is new for the same reason: a
  process that builds a SECOND registry has to see the same LOCAL models, and
  without it a machine's own Ollama or LM Studio was routable for the daemon's
  agents and invisible to a hosted session on the same box.

  **Detach is a setting, and its default preserves what people expect.**
  `hostedSessions.detachPolicy` defaults to `kill` — closing a client has always
  ended its work — and `survive` is the opt-in that makes a session outlive both
  the client and a daemon restart. A session may override the setting when it is
  created, and every record reports the policy that would apply on the next
  detach, so a client can show what leaving will do before it leaves. Also
  configurable: `hostedSessions.maxSessions`, `maxMessagesPerSession`,
  `terminatedRetentionMs`. All four are daemon-owned.

  Disk state gets the standing persisted-state treatment: a bounded session
  count and a bounded per-session transcript (the tail is kept), every file
  content-validated on load with unusable ones moved aside rather than dropped,
  terminated records swept on a retention window, and a load report the daemon
  states at boot. A restart restores a survive-policy session idle with a system
  line saying its turn did not finish, and terminates anything else with a named
  reason — `daemon-shutdown`, `detached`, `killed`, `restart-unresumable`. A
  hosted session never simply disappears.

  Hosting is OFF until a product states how a workspace floor is built
  (`DaemonConfig.hostedSessions`, composed by `composeHostedSessions`), because
  that statement is where the product's trust posture lives and the only posture
  a default could pick is no gate at all.

- **Approval decisions arrive when they happen (`watchApprovalUpdates`).**
  `control.approval_update` already carried every transition of every approval
  record the moment the broker wrote it, and nothing consumed it: the client
  raise seam re-read `approvals.list` every 750ms and surfaces' approval panels
  every 15s, so an ask raised on a phone could take fifteen seconds to reach the
  terminal that could answer it. `watchApprovalUpdates` subscribes to that
  channel narrowed to the `permissions` domain, and
  `createClientApprovalRaiser` takes a `subscribeApprovalUpdates` seam and
  prefers it — with one read immediately after subscribing, because a decision
  can land between the raise and the subscription and a push channel cannot
  deliver what happened before it opened. Polling remains a real fallback for a
  client with no stream seam wired or whose stream the daemon refused.

- **`SharedSessionKind` gains `hosted`**, so a daemon-hosted session appears in
  the shared spine's union list alongside every other session kind. The type, the
  wire schema, both route validators and the broker's own set move together, the
  way `acp` did.

- **The client seams themselves, not just the sockets they plug into
  (`platform/runtime/client`).** `client-services.ts` already held the COMPOSITION
  shape for a surface that runs its own loop and reaches a daemon for
  everything else, plus the two seam TYPES that shape depends on
  (`ApprovalRaiser`, `SessionContinuationDispatch`). What it did not hold was a
  single implementation of either, so both surface products wrote their own —
  and an audit of the split found the bill: two parallel implementations of one
  bounded daemon-start policy, three divergent shapes of one conversation-rewind
  port contract, a device-posture runtime bound in-process in one product while
  the daemon owned the grants ledger, and a permission ask that was visible only
  to the surface that raised it.

  Twelve modules now live here, each policy over one injected I/O shape —
  `DaemonVerbCaller`, two methods: `createClientApprovalRaiser` (raise on the
  daemon, prompt locally, first real answer wins, write the local decision
  back), `createDaemonConfigClient` and `createDaemonCredentialsClient`
  (daemon-owned writes refuse rather than landing in a file nothing reads; the
  reference and its value stay one verb apart from never), `createWireSessionDispatch`
  (the register-only inbound client), `createConversationRewindHost` (the surface
  half of the reverse call whose daemon half was already here),
  `createDevicesClient` + `createClientPhoneTool` (the tool follows the loop, the
  runtime follows the daemon), `createTasksClient` and the fleet union policy
  (local rows authoritative, daemon rows fill in, an act on a row you do not own
  refuses with a reason), `createSpineAdoptionSync` (idempotent per base URL,
  with the two products' activation timings as an option rather than a second
  implementation), and `autostartInstalledDaemon` (the union of the two products'
  bounded-start policies, including the attempt-counted wait that terminates
  under an injected no-op sleep).

  What deliberately did NOT move: resolving WHICH daemon a surface talks to.
  That is the consumer trust-boundary carve-out recorded beside the spine
  transports, and it stays with each product, which passes the resolved caller
  in.

- **Conversation-scope rewind, served by the surface that actually hosts the
  conversation.** Files rewind works from anywhere, because the workspace
  checkpoint store is the daemon's. The conversation half is answerable only by
  the process running the loop, and the port the daemon wired resolved a
  session's conversation out of an in-process map nothing outside the daemon
  could populate. So `rewind.plan` with scope `conversation` reported
  `available: true, messagesToDrop: 0` for every session hosted by a client —
  indistinguishable, to every reader, from a conversation already at the anchor.
  A confident wrong answer, which is the worst shape one can take.

  Five verbs, all ws-only, in a new route module
  (`routes/rewind-conversation-hosts.ts`) over a new broker
  (`platform/rewind/conversation-host-broker.ts`). A surface offers the
  conversation it is running with `rewind.conversation.host.register`, collects
  the questions the daemon puts to it with
  `rewind.conversation.requests.take` (optionally holding the call open until
  one arrives), and reports back with `rewind.conversation.requests.answer`.
  `rewind.conversation.host.release` withdraws the offer and
  `rewind.conversation.hosts.list` shows who is holding what, so "conversation
  rewind is unavailable for that session" is checkable rather than taken on
  trust.

  There is no cross-surface path, deliberately: only the process holding the
  messages can count or drop them, so anyone else's answer would be a guess.
  The shape mirrors the approval broker, the platform's existing reverse call —
  a request, a resolver beside it, a bounded deadline, and every outcome
  RESOLVING rather than rejecting so no caller is left holding a promise. It
  differs in delivery, because an approval waits on a person and a rewind ask is
  answered by a program in milliseconds while `rewind.plan` is waiting on it, so
  the host takes its work on its own connection instead of on an event stream.

  Nothing is persisted. A registration is a claim about a live process, worthless
  once either end may be gone, so it carries a lease the host renews by polling
  and an unrenewed one is dropped on the next access — bounded by time rather
  than by a sweep, with ceilings on hosts and on unanswered questions per host.

  `RewindConversationPreview` and `RewindConversationOutcome` gained an optional
  availability channel (`available`, `unavailableReason`), and
  `UnifiedRewindService` turns it into a plan/receipt warning. A port that omits
  it is treated as available exactly as before, so an in-process consumer that
  always holds its conversation is unaffected. `conversationRewindPort` on
  `GatewayVerbGroupDeps` is now the FALLBACK, consulted for sessions no surface
  has offered: a process holding the messages is a better authority on them than
  a store that merely might have them. A timed-out `rewind` reports that it
  could not be confirmed whether the surface truncated, and never that nothing
  was dropped — the one claim nobody in the daemon is in a position to make.

- **A route to a paired phone for a surface that does not host the device
  runtime.** The `devices.*` family could list paired nodes, list the durable
  grants and revoke them, and run the housekeeping sweep. It could not ask a
  phone for anything: `DeviceCapabilityService.request` was reachable only
  in-process, through the `phone` tool, so a client with no device posture
  runtime of its own had a grants surface it could read and a camera it could
  never open. Three verbs close that.

  `devices.capability.request` (POST `/api/devices/capability/request`,
  `write:remote`) takes a node id, a capability id, the capability's inputs, a
  required reason, and an optional shorter deadline, and returns the runtime's
  own outcome. It re-decides nothing: the durable-grant lookup, the confirmation
  prompt, the configuration gate, the capture retention and the disclosure all
  stay inside the runtime, which is the point — a second copy of the grant rule
  living at a route is a second copy that can disagree with the first. A refusal
  comes back as `ok: false` with the runtime's reason and a machine-readable
  code rather than an HTTP error, because a person declining to hand over their
  camera is an answer, not a fault.

  `devices.artifacts.list` and `devices.artifacts.read` (`read:remote`) are the
  capture half. The in-process tool read capture bytes straight off the daemon's
  disk, which a surface on another machine cannot do; `read` returns them
  base64-encoded, and the store re-hashes them against the digest recorded when
  the capture was taken, so a torn or half-written file is a 404 naming the
  mismatch rather than bytes presented as the picture that was taken.

  Two supporting changes in `platform/devices`. `DeviceCapabilityService.request`
  now accepts an optional `timeoutMs` that can only SHORTEN the configured
  device deadline (`resolveDeviceRequestTimeoutMs`, exported) — a surface that
  stops waiting after ten seconds should not leave a phone working for sixty,
  and a caller that could extend it would be setting the posture from the wire.
  The prompt keeps the configured deadline either way, because the person
  answering it is not the caller. And the host half of the input check that
  `device-peer-work.ts` describes ("runs on the host before dispatch AND on the
  node") moved into `request` itself, ahead of the prompt, with a new
  `invalid-input` refusal: it used to live in the `phone` tool, so the verb path
  would have had no host-side check at all, and asking someone to approve a
  request that cannot run spends their attention on nothing.

- **A composition shape for a product that runs its own conversation loop and
  nothing else.** `RuntimeServices` is the daemon-grade graph: a hundred-odd
  required fields, several of them concretely-typed daemon furniture — the
  persisting `SharedSessionBroker`, the `GatewayMethodCatalog` that SERVES
  verbs, the watcher registry, channel delivery, automation, pairing tokens. A
  terminal or a chat surface could not type-check against it without
  constructing all of that, which is how both surface products ended up
  embedding a daemon they did not want.

  `ClientRuntimeServices` (`platform/runtime/client-services.ts`, exported from
  `platform/runtime` as `bootstrap.*`) is the other shape, built by
  `createClientRuntimeServices`. The rule applied to every field: it belongs
  there when the surface's own turn cannot run correctly without it in-process,
  and everything a daemon can answer over a verb is out. In: the agent graph and
  its tool-facing state, the model stack, permissions as a client (a manager, a
  rule store for approvals this surface remembers, and the raise seam that
  carries an ask to whoever prompts), config/secrets/services, the event
  bus/store/dispatch, hooks, plugins, MCP, the file cache and project index the
  file tools read, transcript persistence, and the session and memory spine
  CLIENTS. Out: the broker as a server, the gateway catalog, watchers, channels
  and delivery, automation, cluster, device posture, the knowledge/home-graph/
  code-index stores and their schedulers, voice and media, fleet aggregation,
  remote supervision, retention and snapshot schedulers, the memory governor.

  Two fields keep their `RuntimeServices` names but are typed as interfaces
  rather than concrete classes, which is what lets a surface stop owning the
  objects behind them. `sessionBroker` is now the inbound-dispatch seam
  (`SessionContinuationDispatch` — bind a continuation runner, nothing else): a
  surface still runs the loop, so it must be able to receive work for a session
  it hosts without owning a persisting register to do it, and `SharedSessionBroker`
  satisfies the seam unchanged, as does a wire-backed poller over
  `sessions.inputs.*`. `userPermissionRuleStore` is now `UserPermissionRuleAccess`
  (read the remembered rules, add one) — the Pick `PermissionManager` already
  took, given a name, so a surface can remember its own approvals while the
  canonical store and its `permissions.rules.*` verbs stay with the daemon.

  Purely additive: `RuntimeServices` is unchanged, both consumer compile-pins
  against it still hold, and the daemon-grade graph still satisfies the shared
  part of the client shape field for field — `ClientRuntimeServicesFromHost`,
  pinned at compile time in `test/types/client-runtime-shape.ts`, so a helper
  typed against the narrow view accepts either composition.

- **One implementation of each piece both compositions build.** The pure-client
  factory is not a fork of `createRuntimeServices`: the parts they share moved
  into free functions that both now call — `resolveRuntimeFeatureFlags`
  (`runtime/feature-flag-composition.ts`, which owns the subtle "who owns the
  manager" rule: a caller's manager is used as-is, never re-loaded or
  double-bridged), `createProviderStack` (`runtime/provider-stack.ts`: the
  stores, the registry, the ONE live credential chain, the tool LLM and the
  optimizer bound to its flag and config mode), `createAgentGraph`
  (`runtime/agent-graph.ts`: the four objects plus the two post-construction
  links — conversation sink and cancellation source — that a hand-written second
  copy drops silently), and the permission set in
  `runtime/permissions/permission-composition.ts` (`createUserPermissionRuleStore`
  with its fail-safe init, `createPolicyRuntimeState`,
  `createBrokeredPermissionManager` carrying background-agent attribution, and
  `createApprovalDerivedHandlers` for the three handlers that must ride the same
  ask seam as a tool permission). `services.ts` calls all of them instead of
  spelling them out, and shrank by 61 lines doing it.

- **`credentials.set` / `credentials.delete` — writing a credential through the
  daemon.** `credentials.get` has been able to report which credentials are
  configured since config sharing shipped; nothing could ever SET one. Every
  product wrote secrets through an in-process `SecretsManager` against its own
  disk, which works exactly as long as the client and the daemon share a
  filesystem and produces the platform's oldest recurring failure the moment
  they do not: a token pasted into a settings modal reports success, lands in a
  store the daemon never reads, and the capability it configures stays dead with
  nothing anywhere reporting a problem.

  A write takes the same four steps as the plaintext credential sweep, for the
  same reason: derive the secret-store name from the config path
  (`daemonSecretKeyFor` — one derivation, platform-wide), store the value at the
  scope the ownership rules resolve (a daemon-needed credential lands in the
  daemon tier whichever surface sent it), read it BACK and compare, and only
  then replace the config value with its `goodvibes://secrets/goodvibes/<KEY>`
  reference. A read-back mismatch fails the call and leaves the setting exactly
  as it was, because a config key pointing at a reference that resolves to
  nothing reads as a configured-but-broken credential — worse than one that was
  never written. The response carries key names, the resolved scope and the
  reference now in config, and never the value or a value-derived fingerprint.
  A key whose value is not credential material is refused rather than turned
  into a reference (that is `config.set`'s job), and so is a value that is
  itself a `goodvibes://` reference.

  `admin` + `write:config` + `dangerous`, matching `config.set`: a credential
  write is a config write whose value happens to be secret, and it must not be
  reachable by a token granted only session access. Step-up rides the platform's
  existing rule rather than a new per-verb flag — these are mutating calls, so a
  call arriving over the relay with `relay.requireStepUpForMutations` on is
  refused without a fresh WebAuthn assertion by the same dispatch gate that
  already covers `config.set`. Handlers in
  `control-plane/routes/credentials-write.ts`; ws-only invoke verbs, so no
  advertised REST path is left unserved.

- **`approvals.raise` — a surface creating an ask in the shared broker.**
  `approvals.list/claim/approve/deny/cancel` could only ever act on asks the
  daemon's own in-process callers had raised, so a surface outside that process
  kept its own broker, prompted at its own terminal, and its asks were invisible
  to every other surface and to the daemon's attention machinery (web push, the
  fleet blocked-on-user signal).

  The verb returns the PENDING record immediately and does not block: an HTTP
  request parked across a person's attention span dies to any idle timeout
  between here and there, and the decision has a better channel. An identical
  in-flight ask (same session, tool and args) coalesces onto the existing record
  — one prompt, one decision, `coalesced: true`. Optional `timeoutMs` expires
  the ask (clamped to 12h); optional `waitMs` waits inline for callers that want
  one round trip (clamped to 60s) and reports `decided: false` with the record
  still pending when it runs out, never a decision nobody made. The daemon
  remains the single source of the applied result: a surface renders what the
  record says, not what it locally believes it asked for.

- **`control.approval_update` in the event catalog — the push that replaces
  polling.** The `approval-update` wire event has always been broadcast and
  domain-tagged `permissions`; it was never described in the catalog, so a
  client had to know it existed to subscribe to it. It is now a first-class
  event descriptor carrying the whole approval record, which is what makes
  `approvals.raise` usable: raise returns the record, and every transition of it
  — starting with the pending one, which IS the prompt — arrives on the existing
  `control.events.stream`.

- **A `config` runtime-event domain, emitting key-level change notices.**
  `ConfigManager.subscribe` is how live settings work inside a process, and it
  is in-process by construction. A `subscribeConfig` consumer in a client
  attached to a remote daemon therefore never fired: the value it was watching
  could change on the daemon and the client would keep running on whatever it
  read at startup. `CONFIG_KEY_CHANGED` carries the dotted key, its ownership
  scope (daemon/client/user) and the new value — except for a secret-bearing
  key, which travels by NAME ONLY, with `secret: true` and no `value` property
  at all (absent rather than nulled, so a subscriber cannot mistake a withheld
  credential for a cleared one). Wired at the composition root from
  `ConfigManager`'s existing per-key subscription
  (`runtime/config/emit-bridge.ts`), which also widens the external-file-edit
  diff: that reload walks the keys something subscribed to, so a key nobody
  watched was never compared.

- **`evaluateDaemonCompatibility` — the client's half of the build-floor
  handshake.** The daemon has published `X-Goodvibes-Client-Floor` on `/status`
  for a while. This is the reverse: a client declares the oldest daemon build it
  can work against and checks it against the version `/status` already returns,
  getting back a verdict whose refusal names both versions and the one action
  that fixes it — the same wording pattern the settings reader-floor refusal
  uses, because the verb that happened to 404 is the symptom and the version is
  the cause. A daemon whose version cannot be read is `unknown`, not `ok`. The
  floor is the consumer's, not the SDK's; consumers adopt it and state what they
  raised it for.

- **Five declarations that consumers were copying because they could not import
  them.** Each one was already implemented here and reachable by nothing: a
  consumer that needed the name wrote the name out again, and a hand copy of a
  contract it must stay assignable to is a copy that drifts silently.
  - `RemotePeerAuth` and `DistributedRuntimeRouteService`
    (`@pellux/goodvibes-daemon-sdk/remote-routes`) were declared without the
    `export` keyword, so the daemon product mirrored the alias and all seventeen
    method signatures by hand to implement the service the facade injects.
  - `SharedSessionContinuationRunner` (`@pellux/goodvibes-sdk/platform/control-plane`)
    was the one member of `session-intents` the barrel did not re-export, beside
    nine of its siblings that were, so a client naming the seam it implements
    declared the runner structurally.
  - `ManagedServiceActionResult` (`@pellux/goodvibes-sdk/platform/daemon`) is the
    return type of the injectable `actionRunner`; a host supplying one has to
    name it, and only `ManagedServiceStatus` was on the barrel.
  - `createBrokeredPermissionManager` and `BrokeredPermissionManagerOptions`
    (`@pellux/goodvibes-sdk/platform/runtime/client-services`) join the two types
    that module already published. Three compositions broker their asks and all
    three need the same mapping from a background-agent attribution to the
    raise's `routeId`/`metadata`.

- **`OrchestratorUsageTotals`** (`@pellux/goodvibes-sdk/platform/core`) and
  **`TurnInjectionRecord`** (`@pellux/goodvibes-sdk/platform/agents`). Both were
  reachable as shapes and not as names: the usage totals were an inferred object
  literal on `Orchestrator.usage`, and the injection record was only the element
  type of `AgentRecord.turnInjections`. A caller that has to declare the type —
  folding usage across conversations, rendering one injection row — wrote the
  fields out again or derived them positionally from an array.

- **`resolveWebPort`** (`@pellux/goodvibes-sdk/platform/daemon`), beside the
  daemon host/port resolvers the barrel already publishes. Two products
  re-implemented the web endpoint's port coercion inline for their endpoint
  displays, because only the daemon-port half was reachable — so one binding was
  validated by this package and its neighbour by a transcription of what this
  package used to do before `resolveWebBinding` existed.

- **The tree-root and daemon-home resolution policy (`platform/config`,
  `goodvibes-home.ts`).** `resolveGoodVibesHome`, `resolveGoodVibesDaemonHome`,
  `resolveGoodVibesTreeDirectory`, `resolveGoodVibesHomeOwnership` and
  `hasOverriddenGoodVibesHome`. What `GOODVIBES_HOME` and
  `GOODVIBES_DAEMON_HOME` mean is a platform contract, not a per-product one:
  the terminal app and the daemon each carried a byte-identical copy, which is
  two places for one meaning to drift in — and the incident that produced the
  module was exactly one entry point disagreeing with another about which tree
  it was running out of.

- **Tolerant `provider:model` parsing (`platform/providers`,
  `provider-model.ts`).** `getProviderIdFromModel`,
  `getModelIdFromProviderModel` and `formatProviderModel`, for reading the
  configured `provider.model` value where it may be blank, bare or half-typed.
  `splitModelRegistryKey` next door stays the STRICT reader for a value already
  established as a registry key; the two now sit together with the line between
  them written down instead of one of them living in each product.

- **`getConfiguredProviderId` and `isEffectiveDangerMode`
  (`platform/config`).** The two config-derivation helpers the terminal app's
  barrel had that this one did not, so the barrel itself carries nothing a
  product cannot get here.

- **The prompted crash-restore mechanism (`platform/runtime`,
  `recovery-snapshot-apply.ts`): `applyRecoverySnapshot` and
  `confirmRecoveryRestore`.** Reading the recovery snapshot, checking what came
  back is actually a conversation, putting it on an injected conversation
  (`RestorableConversation`), folding in the journal tail, and reporting the
  restored count — beside the journal-replay seam it builds on. Three products
  run conversation loops now, and ask-then-retire and never-auto-load are
  behavioral contract rather than terminal idiom, so both are structural here:
  the entry point will not run without a confirmation token that only a user's
  answer produces, and retirement happens inside the same call that applies, so
  a caller cannot restore a snapshot and leave it on disk to be offered again.
  An adopting surface supplies the surface, the session id, a conversation with
  `resetAll`/`fromJSON`/`toJSON`/`title`/`getTitleSource`/`getMessageCount`
  (plus an optional `rebuildHistory`), a persist callback, and the answer to its
  own ask. The ask itself stays with the product.

- **The `sql.js` ambient declaration now ships (`./sql-js`).** `sql.js`
  publishes no types, and tsc treats an ambient declaration as an input it
  never emits, so this package's copy never reached dist and each consumer kept
  its own. `prepare:sdk` copies it into dist and the `./sql-js` export makes it
  reachable: a consumer writes
  `/// <reference types="@pellux/goodvibes-sdk/sql-js" />` once and has no
  declaration of its own to keep in step.

- **`DOMAINS`, `DOMAIN_READ_MATRIX`, `getAllowedReadsFor` and `DomainName`
  (`platform/runtime/store`).** The cross-domain read authorization the store's
  domain slices are governed by was written down, correctly parameterized, and
  exported from nothing — reachable only by a file inside the same directory. A
  rule no consumer can import is a rule each surface re-types by hand, which is
  the opposite of a single source of truth. It now leaves the barrel with the
  domain state factories it governs.

- **`channels.inbox.list` is callable, and its advertised path is served
  (`platform/control-plane/method-catalog-channels`, `daemon-sdk/gateway-rest-routes`).**
  It was the eighth and last of the channels route-reconcile debt: seven of
  those verbs got a store and handlers here, and this one kept `invokable:
  false` because its answer needs provider credentials and the synced mirror
  behind them, which live in a host and not in this SDK. Serving it meant
  building the aggregator, not adding a route, and a host has now built one — so
  the flag is off, `GET /api/channels/inbox` is in `GATEWAY_REST_ROUTES` beside
  its `channels.routing.*` / `channels.drafts.*` siblings, and the plain-REST
  call and the methodId invoke reach the same handler.

  Removing the flag did not move the lie: a build that composes no inbox
  attaches no handler and answers 501 `NOT_INVOKABLE` naming the missing
  composition step, which is the truthful answer for a process holding no
  mailbox — the same self-dispatch guard `runtime.metrics.get` rides.

  The descriptor's shape says what a mirror-backed answer has to say. Alongside
  `items` / `total` / `truncated` (unchanged, so an already-shipped reader keeps
  working) the output carries `hasMore` and an opaque `nextCursor` for paging,
  `cursor` kept as the freshness watermark you feed back as `since`, `partial`,
  and `providers` — one entry per provider the host knows about, on every call,
  including the ones that returned nothing. Its `state` distinguishes `ready`,
  `empty`, `unconfigured`, `error` and `pending`, because zero Slack items can
  mean "nothing arrived", "no token was ever set" or "Slack refused the last
  four polls", and a client acts differently on each. `partial` is true when a
  CONFIGURED provider's items are missing because its sync failed; an
  unconfigured provider never sets it, since nothing is missing from a provider
  nobody wired up. Input gains `cursor` beside `provider` / `limit` / `since`.
  `CHANNEL_INBOX_ITEM_SCHEMA` also names the triage overlay
  (`triageScore` / `triageLabel` / `triageTags`) it was already carrying — an
  item field a client receives and the schema does not name is the contract
  lying by omission.

### Fixed

- **A conversation the daemon dispatches to a surface now gets its answer back
  to the channel it came from (`sessions.inputs.deliver`, `platform/runtime/client/session-dispatch`).**
  When the daemon spawns a continuation itself, `SharedSessionBroker.bindAgent`
  pairs the agent with the input it was started for, announces the pairing, and
  the daemon's completion poll delivers the answer. None of that could happen
  for work the daemon handed to a client process: `createWireSessionDispatch`
  discarded the id its runner returned, so no pairing existed, and the
  completion poll only ever sees agents the daemon spawned itself, so no answer
  arrived either. A message from Telegram/Slack/ntfy could be received,
  answered on the surface, and heard by nobody.

  `sessions.inputs.deliver` now takes three optional fields, and the dispatcher
  reports both halves of the pairing over them: `agentId` with the collected
  acknowledgement ("this agent is answering this input"), which binds the reply
  through the same announcement path (`SharedSessionSurfaceReplyBinding` reason
  `continuation-runner`); then `answer` + `status` with the consumed
  acknowledgement, which writes the answer into the shared session and pushes it
  down the reply pipeline. The finish half needs the surface's own read of its
  agent register — the new `readAgentOutcome` option, with
  `readSurfaceAgentOutcome` as the mapping from an agent record. A host that
  supplies no reader keeps one acknowledgement and still names the agent, so the
  reply binds either way.

  The answer text is now one rule in one place (`platform/agents`:
  `renderAgentCompletionAnswer`), used by the daemon's completion poll and by a
  surface reporting a dispatched run, so an answer does not read differently
  depending on which process happened to execute it.

### Changed

- **BREAKING: no first-party OAuth client ids ship with the product
  (`platform/calendar`).** `OAuthProviderProfile` no longer carries
  `bundledClientId` or `placeholderClientId`, and the
  `GOOGLE_PLACEHOLDER_CLIENT_ID` / `MICROSOFT_PLACEHOLDER_CLIENT_ID` exports are
  gone. A profile now carries `clientIdConfigKey` and `clientSecretRefConfigKey`
  — the names of the config keys the OPERATOR's own registered app is read from
  (`calendar.google.clientId`, `calendar.microsoft.clientId`, and the
  `...clientSecretRef` keys beside them). `ResolvedClientConfig` replaces
  `usingBundledDefault` / `isPlaceholder` with `isConfigured` plus those two key
  names, so a refusal can quote the exact key without rebuilding the string.

  **Who is affected:** anyone reading `isPlaceholder` / `usingBundledDefault`, or
  importing the two placeholder constants, from
  `@pellux/goodvibes-sdk/platform/calendar`. **What changes for an operator:**
  nothing that was working stops working — the previous default was a
  placeholder string that could never authenticate. Connecting a calendar
  requires registering your own OAuth app with the provider and setting its
  client id; until then the flow refuses with `client-not-configured`, before any
  network call, naming the key to set. `CalendarConnector.resolveConfigFromSettings()`
  and `platform/calendar`'s `readCalendarClientOverrides` read those keys (and the
  client secret from the secret store under the derived name). See
  `docs/calendar-oauth-setup.md` for the provider-console walkthrough.
  `calendar.microsoft.clientId` joins the daemon-owned config paths, closing a
  split where Microsoft's client SECRET was daemon-owned while its client id was
  not — the daemon held half a credential and reported no account connected.

- **BREAKING: the `daemon.embedInProcess` setting is removed (`platform/config`,
  `platform/runtime`).** The key offered a choice no surface could act on: every
  product starts host services adopt-only, and the adoption policy answers
  adopt-only before it reads any embed preference — so a settings file with
  `embedInProcess: true` behaved exactly like one without it, while the
  schema-driven settings UI presented it as a live toggle carrying a "NOT
  RECOMMENDED" warning for a branch that could not run.

  A stored value is swept on load by a receipted migration
  (`migrateDaemonEmbedInProcessRemoval`), which rewrites the settings file once
  and files a one-line announce-once receipt naming the key, quoting the value it
  removed, and stating that nothing about how the daemon runs changes. No
  replacement setting is invented to receive the value.

  **The embed capability itself stays**, re-scoped to what it always really was:
  composition machinery. `startHostServices` takes `embedDaemonInProcess` in its
  options, for an embedder that owns the daemon's lifetime deliberately and for
  tests that need a real daemon without a detached child outliving the run. No
  settings key reaches it. **Who is affected:** a caller reading or writing
  `daemon.embedInProcess` through `ConfigManager`, or typing against
  `DaemonProcessConfig` / `ConfigKey`; the key is gone from all of them. An
  embedder that relied on the setting passes the option instead.

  `daemon.enabled` is unaffected and keeps a live meaning, now stated precisely
  in its schema description: whether THIS surface uses a daemon at all — adoption
  plus every daemon-backed feature gate — as distinct from how one is hosted. It
  does not control the daemon process, which runs regardless.

- **BREAKING: the daemon's identity home follows a redirected tree root
  (`platform/workspace`, `platform/owner-profile`, `platform/daemon`).**
  `resolveDaemonHomeDir` derived its default from `homedir()` directly, ignoring
  `GOODVIBES_HOME`. Since `GOODVIBES_HOME` relocates the tree root for
  everything else — settings, workspace state, every secret tier — a daemon
  started under a redirected root kept its identity files (auth users, operator
  tokens, daemon settings) in the REAL `~/.goodvibes/daemon`. An isolation
  boundary a process can walk out of is not a boundary. The resolver now derives
  from the platform's one tree-root resolution; precedence is unchanged in shape:
  an explicit `--daemon-home` first, then `GOODVIBES_DAEMON_HOME`, then
  `<tree root>/.goodvibes/daemon`. `resolveOwnerProfilePath` and
  `resolveDaemonCliPaths` had the same gap and are fixed with it.

  **Who is affected:** only a process running under a `GOODVIBES_HOME` redirect —
  test harnesses, sandboxes, and service units that set it. Such a daemon now
  reads and writes its identity under the redirect instead of under the real
  home; if it had identity state at the real path, point `GOODVIBES_DAEMON_HOME`
  at that path to keep using it. **A default install sees no change at all**:
  with no redirect set the tree root is the login home, which is exactly what
  `homedir()` returned.

- **Terminal-shell's public surface is gated
  (`packages/terminal-shell`, tooling).** `packages/terminal-shell` is the other
  package consumers import directly and nothing watched its exports, so a change
  to its public surface could reach a consumer with no review step in between. It
  now has both mechanisms the SDK has: an api-extractor rollup
  (`api-extractor.terminal-shell.json` with its own
  `packages/terminal-shell/tsconfig.api-extractor.json`, reporting to
  `etc/goodvibes-terminal-shell.api.md`) and coverage in
  `scripts/check-subpath-api-surface.ts`, which is now driven by a table of
  tracked packages rather than one hardcoded path and records
  `etc/subpath-api-surface-terminal-shell.json`. The subpath gate is what covers
  `./conformance` and `./terminal-output-guard`, which a rollup config cannot
  see. Both run inside `api:check`, so an unreviewed surface change fails
  `validate`.

- **The provider-health latency field says what it holds: a MAXIMUM, not a
  percentile (`platform/runtime/ui`).** `ProviderHealthEntry.p95LatencyMs` is
  now `maxLatencyMs` and `ProviderLatencyStats.p95Ms` is now `maxMs`. Both were
  populated from `record.stats.maxLatencyMs` — the largest observation, which
  the domain state has always documented as such — so every surface rendering a
  "p95" latency was showing the worst call it had ever seen under a label that
  claimed 95 percent of calls were at least that fast. The genuine computed
  percentiles elsewhere (diagnostics panels, the state inspector, the hotspot
  sampler) are untouched and keep their names.

- **`getConfiguredSystemPrompt` degrades instead of throwing.** An unreadable
  `provider.systemPromptFile` now reads back as "no configured system prompt"
  with a debug line, rather than propagating the read failure. The setting names
  a file the user may have moved or deleted, and a boot that dies over an
  optional preference strands the session. This is the behaviour the terminal
  app's copy already had; adopting it is what made deleting that copy safe.

- **Every node in the provider-health fallback chain reports its STORED registry
  key (`platform/runtime/ui/provider-health`, `platform/runtime/ui/model-picker`).**
  Node 0 read `modelState.registryKey` while nodes 1..N recomposed
  `${providerId}:${modelId}`, so one model was described by two different keys
  depending on whether it happened to be active or a fallback — and for any id
  that already carries a namespace (an OpenRouter `vendor/model`, a Bedrock-style
  id) the recomposed form matches nothing in the registry. `FallbackChainEntry`
  now carries `registryKey`, and both the visualizer and the model picker's
  position map read it.

- **`loadPlugin` takes three parameters and `PluginPathOptions` has no
  `entryDefault`.** Neither was read by anything: no caller passed a fourth
  argument and no reader consulted the option, so `manifest.main ?? 'index.js'`
  was already the whole rule.

- **The daemon updates itself from the daemon's own repository.** The shipped
  default of `update.releasesUrl` is now
  `https://github.com/mgd34msu/goodvibes-daemon/releases/latest`; it named the
  terminal app's repository because the daemon binary used to be built and
  released there. This one default is what carries an already-installed daemon
  onto the new release line without anyone touching the machine: the release
  asset names are unchanged (`goodvibes-daemon-<os>-<arch>`,
  `sqlite-vec-<os>-<arch>`) and the service unit's `ExecStart` is path-stable,
  so the running daemon's next hourly check resolves a tag from the new
  repository, downloads the same-named asset, and swaps itself in place. A user
  who explicitly wrote `update.releasesUrl` into their settings keeps their
  value — an override is an answer, and this default never re-derives over one.
- **A daemon update no longer replaces the terminal app binary beside it.**
  `resolveDaemonInstalledFiles` listed `goodvibes` in the same directory as
  cargo, which was right while one release carried both binaries. A
  daemon-repository release publishes no `goodvibes-<os>-<arch>` asset at all,
  so keeping it listed would have the daemon looking for a file that does not
  exist — and, if one ever appeared under that name, overwriting a product that
  updates itself from a different repository on a different version line. The
  daemon binary and the sqlite-vec addon beside it are still owned and still
  refreshed in one verified pass. The crash-loop rollback reads the same list,
  so it now restores exactly what the update it is undoing replaced.
- **`ApprovalBroker.raiseApproval`** returns both the record and the pending
  decision; `requestApproval` is now a thin wrapper over it that keeps the
  decision. The body moved to a free function in `approval-broker-raise.ts`
  (same convention as `session-broker.ts` → `session-broker-intent.ts`), which
  is also what kept that file under the source cap. Behaviour is unchanged
  including the persist-before-publish ordering, the rollback on a failed
  persist, and a local prompt running only for a record the call actually
  created.
- **The CI-watch verb group's construction** moved out of
  `routes/register-gateway-verb-groups.ts` into
  `routes/ci-watch-composition.ts` as a free function over the same deps object
  — the split that file's line budget required, with no behaviour change.
- **`platform/daemon`: `reportFatalBootFailure`, `writeFatalLine`,
  `writeExitingStdoutLine` are now exported.** Both the TUI and the agent
  carried an identical local mirror of this module because the 1.21.0
  exports map had no entry for it despite the compiled file shipping in the
  published tarball. The write loop now loops `writeSync` until every byte is
  accepted (adopted from the agent's copy) rather than issuing one call,
  because a large payload (e.g. `--help`/status-render output) can return a
  short count and truncate rather than merely silence.
- **`platform/daemon`: `createSafeHostServeFactory`, `createHostRequestFailureResponse`.**
  The port-conflict-honest `Bun.serve` wrapper, hoisted from the TUI's
  `daemon/safe-serve.ts` verbatim (it wraps only the request-handler
  callback; a bind-time failure like `EADDRINUSE` still propagates
  unchanged).
- **`platform/workspace`: `CheckpointSessionResolver`, `CheckpointSessionResolveContext` types are now exported from the top-level barrel.** Previously reachable only from the non-public `platform/workspace/checkpoint` subpath; both the TUI and the agent had structurally mirrored the resolver's shape by hand.
- **`platform/power`: `postPowerKeepAwakeSet`, `forwardKeepAwakeToAdoptedDaemon`.** The keep-awake-forward-to-adopted-daemon helper, unifying the TUI's and the agent's parallel implementations onto the agent's richer failure-classified version (the TUI's config-subscription and status-poll wiring stay consumer-local).
- **`platform/providers`: `buildFallbackModelDefinition`, `ensureConfiguredModelIsRoutable`.** The pre-catalog fallback-model registration, unified onto the TUI's version (family-aware context-window and reasoning-effort inference) rather than the agent's flat 128k/32k + fixed-level-set copy.
- **`platform/providers`: `createLaunchTolerantProviderRegistry`.** A `ProviderRegistry` construction that never throws over a missing provider API key at boot, hoisted unchanged from the agent (previously agent-only; the standalone daemon has the identical must-boot property).
- **`platform/runtime/session-spine`: `createSessionSpineRestTransport`, `postSessionSpineRegister`, `postSessionSpineClose`, `createSessionSpineRestProbe`, `createSessionSpineReceiptConsumer`, `extractSessionSpineReceipts`.** The version-tolerant raw-REST `SpineTransport`, unified onto the agent's superset (folds failures into `ok`/`offline`/`rejected` — a durable auth/route rejection no longer retries forever — plus a reachability probe and a daemon-receipt consumer).
- **`platform/runtime/memory-spine`: `createMemorySpineRestTransport`.** The full fifteen-verb REST `MemoryTransport`, unified onto the TUI's superset (implements `reviewQueue`/`vectorStats`/`doctor`, which the agent's copy left unwired, and reuses this platform's own `transport-http` helpers).

## [1.21.0] - 2026-07-30

Hardens the daemon's own lifecycle after a night it handled badly: the
auto-updater no longer rolls a healthy daemon backwards and tells the owner
when updates keep failing, a fatal boot error now says what is wrong on the
terminal instead of dying silently, an unreadable setting is skipped loudly
instead of killing the daemon or being silently ignored, state migrated by a
newer component names the version floor instead of crashing an older reader,
`--daemon-home` actually governs the daemon's state directory, and a compiled
daemon no longer dies at startup over an absent optional package.

### Changed

- **`zustand` moved from `optionalDependencies` to `dependencies`.** It backs
  `runtime/store/index.ts`, and a daemon without a runtime store is not a
  daemon — so declaring it optional was untrue, and the fix belongs in the
  manifest rather than in the import. Unlike every other package in this
  release's optional-dependency work, its import is left exactly as it was:
  making a synchronous store lazy would break every synchronous consumer to
  honour a declaration that was simply wrong. No real install changes, because
  a default `npm`/`bun install` has always installed optional dependencies; what
  changes is that an install which deliberately omits them now still gets the
  store. (The `tree-sitter-*` grammars stay declared optional and keep their
  static `with { type: 'file' }` asset imports, which exist so `bun build
  --compile` embeds the WASM; the build lane below is what makes that
  declaration honest.)

### Fixed

- **A compiled build now survives an optional package it is allowed to be
  without.** Making the SDK's imports dynamic fixed the RUNTIME half of the
  optional-dependency defect, but not the build: bun resolves a dynamic
  `import('pkg')` at bundle time exactly as it resolves a static one, so with
  the package absent `bun build …/daemon/cli.ts --compile` still failed with
  `Could not resolve: "jsdom"` and produced no binary at all. The lazy
  resolution never got the chance to govern.

  `@pellux/goodvibes-toolchain`'s compile path (`lib/optional-externals.ts`,
  wired into `runBuildBinaries`) now screens every declared dependency of the
  building repo and of the SDK it bundles against what is actually installed:

  - a package declared **optional** and not installed is passed as
    `--external`, so bun leaves the specifier for runtime, the binary is
    produced, and the SDK's own unavailability report is what the operator
    sees;
  - a package declared **required** and not installed **fails the build**, by
    package name and by the manifest that asked for it. Externalising that one
    would trade a loud failure at build time for a binary that dies in the
    field, which is the exact trade this line of work exists to undo;
  - a package declared optional by one manifest and required by another is
    treated as required — the stricter declaration wins;
  - an optional package that IS installed is left alone and still gets bundled,
    so an ordinary build is unchanged, and a caller that supplies no manifests
    gets the argv it always got.

  `test/toolchain/build-binaries.test.ts` pins both the produced argv and the
  behaviour end to end: it screens a package name that resolves nowhere,
  compiles a fixture with the real `bun build --compile`, and runs the artifact
  — the binary exists, boots, and reports the package unavailable, against a
  control whose static import of the same name does not compile at all.

- **`test/daemon-isolation-guards.test.ts` no longer leaves scratch directories
  behind.** It created a throwaway home per harness and per compiled case and
  removed only the two holding the compiled binaries — **10 directories leaked
  per run**, measured, and the development host had accumulated roughly three
  thousand of them. Every directory now comes from one `scratchDir()` helper
  that records what it made, and a file-level cleanup removes exactly those.
  Deliberately a registry of paths rather than a prefix sweep of `tmpdir()`: a
  second copy of the suite may be running alongside, and a sweep would delete
  the directories it is still using.

- **A package the SDK says it can live without could stop the daemon from
  existing.** `packages/sdk/package.json` declares thirty packages under
  `optionalDependencies`. That declaration is a promise: an install that skipped
  them, or one where a build failed, still produces a working SDK, and the
  features that need them report themselves unavailable. A **static** import of
  such a package breaks the promise in both of the shapes that ship. Measured
  here with `packages/sdk/node_modules/jsdom` moved aside:

  - `bun build packages/sdk/src/platform/daemon/cli.ts --compile` failed with
    `error: Could not resolve: "jsdom"`. There was no daemon binary at all.
  - The same graph run from source died at **module init** with
    `Cannot find package 'jsdom'` — before `main()`, before the activity logger
    had a destination, and before `daemon/fatal-boot-report.ts` existed to
    report anything. One step earlier in boot than the mute-daemon failure
    above, and just as silent.

  `knowledge/html-readability.ts` was the entry point for this: the daemon
  reaches it through `knowledge/extractors.ts`. It now loads `jsdom` and
  `@mozilla/readability` through the new `utils/optional-dependency.ts` at the
  moment an extraction needs them, caches the outcome (including the failure)
  once per process, and returns `null` with a stated reason when they are
  absent; `extractKnowledgeArtifact` falls back to its lightweight HTML path and
  carries that reason as a warning, so a missing package never looks like an
  empty page. `extractReadableHtml` is now async as a result.

  The same treatment was applied to every other optional package the daemon
  graph reached statically and could be reached lazily: `jszip` (the Office
  extractors), `bplist-parser` (Safari bookmarks), `fuse.js` (the registry
  tool's fuzzy ranking, which now falls back to exact substring and says so in
  its result), `node-edge-tts` including its `dist/drm.js` subpath (the
  Microsoft voice provider), and `sqlite-vec` (resolved through `createRequire`
  rather than `await`, because the loader is called from synchronous store
  constructors — the same technique, for the same reason, as the `bun:sqlite`
  resolution in `knowledge/browser-history/readers.ts`).

  Seven more optional packages needed the module restructured rather than the
  import moved, because each was reached by building a client in a
  **constructor**, extending an **imported base class**, running a **class
  static**, or **re-exporting** a value — all of which run at module init:

  - `openai` (`providers/openai.ts`, `providers/openai-compat.ts`,
    `providers/lm-studio-helpers.ts`). The client is a memoised promise built on
    first use instead of in the constructor. Every method that uses it was
    already async, so no public signature moved; constructing a provider no
    longer needs the package, and the first call that does reports it by name
    through the provider-error path the caller already handles.
  - `@anthropic-ai/bedrock-sdk` (`providers/amazon-bedrock.ts`,
    `providers/amazon-bedrock-mantle.ts`), including its `core/auth.js` subpath
    for the SigV4 signer the control-plane model listing reuses.
    `AnthropicSdkProviderOptions.createClient` may now return a promise, which
    the one caller — already inside an async retry body — awaits.
  - `@anthropic-ai/sdk` and `google-auth-library`
    (`providers/anthropic-vertex.ts`). `AnthropicVertexClient extends
    BaseAnthropic`, and a class cannot extend a dynamically imported base: the
    `extends` expression is evaluated when the declaration is. The class is now
    declared **inside** an async factory called once and memoised, so the
    declaration runs after the import resolves and every `new` still gets one
    class object.
  - `@agentclientprotocol/sdk` (`acp/host.ts`, `acp/agent.ts`,
    `acp/connection.ts`, `acp/protocol.ts`). A re-export cannot be lazy —
    `export { x } from 'pkg'` links the specifier exactly like an import — so
    `acp/protocol.ts` no longer re-exports `ndJsonStream`,
    `AgentSideConnection` and `PROTOCOL_VERSION`; the three consumers and the
    ACP test fixture take them off `loadAcpSdk()` instead. Its type re-exports
    are untouched, because `export type` is erased. `serveAcpAgent` is async as
    a result — it cannot build a connection before the package resolves.
  - `simple-git` (`git/service.ts`, `agents/worktree.ts`,
    `workspace/checkpoint/side-git.ts`). The two constructor cases hold a
    memoised promise their already-async methods await, so each client is still
    built exactly once, with the `.env()` scoping the checkpoint runner depends
    on applied to it.
  - `graphql` (`knowledge/graphql.ts`, `knowledge/graphql-schema.ts`).
    `buildSchema` and `printSchema` ran in class-static initialisers; they are
    lazily-computed accessors now, cached after the first use. The
    `KnowledgeGraphqlService` constructor primes the package through the
    dynamic import a bundler follows, so a compiled binary has it in hand
    before any route reads `schemaText` — which the daemon-sdk route contract
    requires to stay a synchronous string.

  When any of these packages is absent the feature throws an error whose
  message is the same stated reason: the package name, that it is an optional
  dependency of `@pellux/goodvibes-sdk`, and that installing it enables the
  feature. Nothing returns empty or defaults silently.

  Two optional packages are deliberately NOT converted. `zustand` backs
  `runtime/store/index.ts`, which is synchronous and which a daemon cannot run
  without — the mismatch there is in the declaration, not the import.
  `web-tree-sitter` and the five `tree-sitter-*` grammars are
  `with { type: 'file' }` asset imports that exist precisely so
  `bun build --compile` embeds the WASM into the binary; a dynamic import would
  defeat the embedding that makes the feature work in a shipped artifact.

  Proven against a compiled artifact, because source cannot show it: under
  `bun` with a full node_modules tree a static import and a dynamic one behave
  identically. `test/optional-dependency-boot.test.ts` compiles both shapes with
  `bun build --compile --external <pkg>` and runs them from a directory where
  the packages do not resolve. `--external` rather than hiding a package, so the
  test never mutates this repository's node_modules underneath the suite running
  beside it. The static controls — one importing `jsdom`, one importing
  `graphql` and building a schema at module scope — exit 1 with **zero bytes on
  stdout**; they never reach their first statement. The lazy shapes exit 0, name
  every package they are missing, and still return an extraction.

  Measured on the real daemon binary, compiled from
  `platform/daemon/cli.ts` with the package left as a runtime specifier and run
  where it does not resolve, against a home holding an unparseable
  `daemon/settings.json`:

  - `openai`: before, exit 1 with 0 bytes on stdout and **99 bytes** on stderr
    saying only `Cannot find package 'openai'`. After, exit 1 with **1232
    bytes** naming the settings file, `could not be read as JSON`, and the parse
    error. The daemon booted and reported the thing that was actually wrong.
  - `@agentclientprotocol/sdk`: before, exit 1 with 0 bytes on stdout and **113
    bytes** saying only `Cannot find module '@agentclientprotocol/sdk'`. After,
    exit 1 with **1205 bytes** reporting the settings file.
  - All seven left external at once: the daemon still boots and still reaches
    its settings check.

- **Every shipped daemon to date has died mute on a fatal boot error. This is
  the release that makes them speak.** Measured against the released 1.27.0
  binary, in an isolated home, with an unparseable `daemon/settings.json`: exit
  code 1, **zero bytes on stdout, zero bytes on stderr, and no activity log
  written at all**. The operator's only signal was that everything had stopped.

  The cause was not output buffering and not a bypassed handler. The daemon
  entrypoint that ships reports a fatal boot failure to the activity **logger**
  and then exits — and at that point in boot the logger has no destination, so
  the line goes nowhere and no file descriptor is ever touched. A `logger.error`
  is not a disclosure.

  Every early-exit site in the daemon boot path now routes through
  `platform/daemon/fatal-boot-report.ts`, which writes **synchronously to file
  descriptor 2** (`writeSync(2, …)`) before anything else and before the exit:
  the fatal handler, the settings refusals, the crash-loop rollback notice, and
  the `--install-service` output. The descriptor is used rather than
  `process.stderr.write` because the latter is a replaceable property on a
  mutable global — goodvibes-tui really does replace it, to keep a rendered
  screen clean — and because a stream write issued immediately before
  `process.exit()` can still be in flight when the process stops existing.

  A settings refusal is now disclosed by the SDK **at the point of refusal**,
  so a host whose own fatal tail is silent still speaks. Proven against a
  compiled binary, not source: `test/daemon-isolation-guards.test.ts` builds the
  daemon fatal-boot path with `bun build --compile` and asserts bytes on stderr
  for an unparseable file, a safety-gate refusal, and a reader-floor refusal —
  alongside a control that pins the shape that shipped at zero bytes.

- **`--daemon-home` governed only half of what it names.** The flag (and
  `GOODVIBES_DAEMON_HOME`) names the daemon's own state directory, and four
  modules already resolved it that way — but `daemon/cli.ts` threaded it into
  the identity files only, while the `ConfigManager` derived its daemon config
  tier from `homedir()` regardless and the credential store was never told at
  all. A daemon pointed at another state directory therefore read the real
  home's daemon settings and the real home's daemon-scoped secrets, which is the
  second half of the isolation incident `runtime/secrets-composition.ts`
  records. The resolution moved to `platform/daemon/cli-paths.ts` (extracted so
  it can be tested at all — `cli.ts` ends in a top-level `void main()`, so
  importing it to check its path math would start a daemon), and the resolved
  home now reaches the daemon config tier and `SecretsManager`.

  Separately, `runtime/bootstrap-services.ts` passed the **user home** as
  `--daemon-home` when spawning a detached daemon, where every reader expects
  the state directory — so a spawned or serviced daemon filed `operator-tokens.json`
  and `daemon-settings.json` one level above where all of them look. On a normal
  machine the config half still landed correctly, because the user home is the
  default parent, which is exactly why this went unnoticed. It now passes the
  state directory, and the `GOODVIBES_DAEMON_HOME` it sets on the child matches.

- **A setting the daemon cannot ingest is now said out loud, and does not take
  the daemon with it.** A daemon read `calendar.google.clientSecretRef` — the
  `goodvibes://secrets/…` reference a newer component's credential sweep had
  written into the shared daemon settings file — and exited 1 with nothing on
  stderr, nothing in the journal, nothing anywhere. It crash-looped 77 times
  overnight and the owner found out by everything being dead.

  Settings ingestion now has one stated rule, in
  `platform/config/settings-ingestion.ts`, and the reader follows it for every
  settings file it reads (global surface, project surface, shared tier, daemon
  tier):

  - **Every failure names the FILE, the KEY and the REASON**, on stderr — where a
    service journal captures it — and in the activity log, before anything
    decides whether to carry on.
  - **The default is to quarantine the single unreadable key and keep serving.**
    It is dropped, the tier below it answers, and the notice says so. A daemon
    running one setting short, loudly, is recoverable; a daemon that will not
    start is not.
  - **A key whose fallback could permit MORE than the operator stored refuses
    instead** — the per-tool approval gates, `permissions.mode`,
    `permissions.engine`, and the whole `policy.` domain, declared in
    `SAFETY_GATE_CONFIG_PREFIXES` with the evidence for each. Deliberately not
    `danger.*`, `behavior.autoApprove`, `controlPlane.allowRemote/trustProxy` or
    `sandbox.enabled`: those ship as the restrictive value, so falling back to
    them can only ever close something.
  - **A whole file that will not parse is also a refusal**, because the reader
    cannot tell whether the unreadable bytes held a gate — but it now names the
    file and the parse error rather than dying with a bare exit code.

  Four failure modes that were previously **silent** are now announced:
  a value of the wrong shape on a known key (`controlPlane.port` set to a string
  became the live port, unvalidated); a section of the wrong type (a string where
  `controlPlane` belongs silently returned the daemon to port 3421); a key form a
  newer component wrote that this build does not know; and a credential key
  holding a reference that cannot be resolved. `ConfigManager.getIngestionQuarantine()`
  reports them all, and each is also filed as a startup receipt the daemon serves
  from `/status`.

- **A migration that rewrites shared settings records the reader version it
  requires, so an older reader reports the version gap instead of the symptom.**
  `~/.goodvibes/daemon/settings.json` is read by every component on a machine and
  they are not all the same version at once. The credential sweep and the
  daemon-owned config migration now leave a `$goodvibes.minReaderVersion` marker
  beside what they rewrote (`platform/config/settings-reader-floor.ts`). A reader
  below the floor says exactly that — *"settings were migrated by a newer
  component; this daemon (X) is older than the floor (Y) — update it"* — checked
  before any key is ingested, so the version gap is reported rather than whichever
  key happened to be shaped in a way the reader could not parse. The marker never
  reaches the resolved config, a floor is never lowered, and a floor that cannot be
  written never undoes a migration that already succeeded.

## [1.20.0] - 2026-07-30

The daemon now raises the dates that matter on its own, pushes occasion nudges
over Telegram and into the agent conversation, and heals a route binding whose
session is unusable instead of dropping messages against it. The wake word
becomes fully usable: audio capture on every surface, a noise-suppression
stage, our own speech gate, and the model installed with the product. A sweep
of the whole configuration surface made every previously inert key govern what
its description says, in every consumer.

### Added

- **`voice.wake.vadThreshold` screens frames now, with our own model — the second
  row that named a stage nothing ran.** It refused at any value above 0 because no
  voice-activity model was pinned. There is one now, and it is ours, trained by
  us: a **speech/non-speech head over the SAME 96-dimension embedding the wake
  classifier consumes**, so it adds one inference of **0.025 ms per 80 ms frame**
  and no extra front-end pass, and provisions with artifacts the surface already
  downloads. 15.9 kB, 3,713 parameters, Apache-2.0, onnx and tflite twins pinned
  by byte count and sha256 in `WAKE_VAD_MODEL` beside the wake classifier.

  - **A withheld frame reaches no classifier.** Below the threshold the frame is
    kept out of the 2.4 MB classifier entirely, and it breaks any run of
    above-threshold frames in progress — patience counts CONSECUTIVE scored
    frames — while leaving the cooldown alone, so withholding cannot let one
    utterance fire twice.
  - **Measured on 106,390 held-out frames** (44,286 speech) from recordings
    disjoint from training by file and by speaker: at the recommended 0.30 it
    passes **96.0 % of speech frames** and withholds **95.7 % of non-speech**
    ones. The manifest carries the whole threshold table so a surface can say what
    a chosen value does instead of guessing. On the two individual held-out
    recordings replayed by the test suite, 0 % of the noise recording's frames
    pass and 95.8 % of the speech recording's do.
  - **Trained on the same commercially-clean corpora class as the wake model** —
    LibriSpeech train-clean-100 and MUSAN speech against MUSAN noise and music,
    with per-file gain randomisation and half the speech mixed with noise at
    0–18 dB SNR, because a head trained on loud clean speech would learn "loud"
    and gate the case the detector most has to survive. Attribution travels in
    `goodvibes-vad-1.0.0.NOTICE.txt`, pinned and checksummed like every other
    asset.
  - **The twins decide identically**: 1.8e-07 (onnx vs Keras) and 5.4e-07 (tflite
    vs Keras) over 2,000 frames, zero gating decisions changed at 0.2, 0.3 or 0.5.
  - **`voice.wake.vadThreshold` still ships at 0**, the gate off — the
    configuration that has been exercised, and a gate can only ever cost a
    detection. 0.30 is the measured operating point to set when turning it on.
  - **Provisioned with the wake models, reported separately.**
    `voice.wake.provision` fetches the gate and its NOTICE beside the classifier;
    `voice.wake.status` reports them as `vad` / `vadNotice` / `vadReady`, which is
    NOT folded into `ready`, because the detector runs without the gate and
    folding it in would make every existing installation look broken until it
    re-provisioned. The recovery sweeper reaps a gate that fails verification and
    an unpinned gate version, like any other pinned artifact, and
    `voice.wake.model` serves the gate's bytes to a browser tab
    (`component: "vad"`), which cannot fetch the release asset itself.
  - **A gate that fails passes frames through and says so** (`WakeFrameResult.vad`
    carries `failed`), because gating on failure silently turns the wake word off
    — indistinguishable to a user from a microphone that stopped working. A
    surface that has not loaded the gate still refuses any threshold above 0
    rather than leaving frames unscreened while the row claims otherwise.

- **`voice.wake.noiseSuppression: "speex"` filters audio now, on every surface —
  the value that refused everywhere is a filter that runs.** The row shipped with
  two values and one of them named a stage nothing applied, so selecting it
  stopped the detector with a written reason rather than pretending. The filter is
  now **SpeexDSP 1.2.1's preprocessor, compiled to WebAssembly and carried in the
  package**: 53,678 bytes, sha256
  `4829d9fa97e648ab9c45e9a685adba7bd762a4f948ec499c59b073bd03cce2bb`, imports
  nothing at all. Nothing to install, nothing to provision, no per-host library —
  which is what makes the setting honest, because there is no state in which the
  filter is configured but not running.

  - **One application point, so no consumer can be missed.**
    `createNoiseSuppressingOpener` wraps whatever a host opens, and both
    consumers wrap the opener they are handed: the classifier scores filtered
    frames, the utterance recorded after a wake is filtered, the pre-roll from
    before the wake fired is filtered, and push-to-talk voice input is filtered.
    A host passes the same plain opener it always did — no surface wiring
    changed. Wrapping is idempotent (the wrapper asks the opener underneath it
    for `none`), so a host that also wraps its own opener filters once.
  - **Measured on signal, not smoke-tested.** Against a 1 kHz tone gated on and
    off under white noise: **noise floor down 13.20 dB, SNR up 12.83 dB, tone
    correlation 0.9990** — the floor falls by about the 15 dB the filter is asked
    for while the tone survives. Asserted numerically in
    `test/voice-noise-suppression.test.ts`, which also asserts that `none` is a
    true passthrough: the same frame objects, so the byte path with suppression
    off is exactly the path that shipped.
  - **Cost: 0.100 ms per 80 ms frame** (p95 0.112 ms) — 0.13 % of one core,
    beside the detector's own 3.46 ms. Frames are filtered in 20 ms blocks
    through one continuous state, because the suppressor estimates its noise
    floor over a window twice the block length and an 80 ms block would track a
    room four times more slowly than SpeexDSP is tuned for.
  - **Denoise only, stated in the build.** No echo canceller is compiled in, and
    automatic gain control (which would move the loudness the classifier was
    trained against), the voice-activity gate and the dereverb stage are disabled
    explicitly rather than left at upstream defaults, so a default that moves
    upstream cannot silently change what the setting does.
    `voice.wake.vadThreshold` still has no model behind it and still refuses.
  - **BSD-3-Clause, with the notice carried.** SpeexDSP requires its copyright
    notice, conditions and disclaimer to be reproduced with binary
    redistribution, and the embedded base64 is binary redistribution:
    `native/speexdsp-wasm/NOTICE.txt` is that reproduction, the upstream license
    is beside it verbatim, and `SPEEXDSP_PREPROCESS` points at both. Nothing in
    the chain is NonCommercial, ShareAlike or NoDerivatives. The upstream archive
    is pinned by sha256 and the toolchain by version, and
    `bun scripts/build-speexdsp-wasm.ts` rebuilds the artifact from them
    (`--check` re-verifies the committed one without a compiler).
  - **A surface that genuinely cannot run it still says so.** The blocker did not
    go away, it narrowed: a runtime with no `WebAssembly`, or a surface that
    declares it does not apply the stage, refuses with that reason instead of
    capturing unfiltered audio. So does a filter that fails mid-stream — the
    stream stops rather than passing half-filtered frames on.

- **The wake-word model ships with the installation, so a fresh machine can
  actually use the wake word.** Everything needed to detect the phrase was
  already here and provisioning was reachable only by asking for it — typing
  `/voice wake setup` or calling `voice.wake.provision` — which made the ordinary
  outcome of installing goodvibes a feature that could not start, waiting on a
  download most people would never go and find.

  - `platform/voice/wake/install-provision.ts` is the policy, and three seams
    call it: an installer, a package postinstall, and every daemon boot
    (`startWakeBootProvisioning`, which also finally starts the recovery sweeper
    that `recovery.ts` had been exporting with no caller). `ensureProvisioned()`
    on the wake setup service routes a boot attempt through the SAME single
    flight as a user-triggered provision, so the two join one download.
  - **A failed download never fails an installation.** No path throws — not an
    absent network, not DNS, not a proxy serving HTML, not an unwritable home
    directory, not a provisioner that itself threw. A failure degrades to exactly
    the previous behaviour: status reports `not-provisioned` **by content**, and
    the recovery command still works. It says so once, in one line of prose that
    names what happened and how to retry, and the next boot tries again.
  - **It reaps before it retries.** Each attempt sweeps first, so an attempt
    killed mid-download leaves no partial and no torn file to be re-inspected
    forever — which is what makes the boot retry converge.
  - **Turning the feature on still downloads nothing.** `voice.wake.enabled`
    moving to `true` reads the artifacts and refuses honestly when they are
    missing, naming the recovery command. Installing and booting are the
    sanctioned acts; a switch is not one.
  - `GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD=1` installs without the model, and says
    so in the same one line, so opting out never looks like a silent failure.

- **Every attribution NOTICE travels with the artifact it attributes.** Three
  redistributable artifacts come out of this tree — our classifier, Google's
  Apache-2.0 `speech_embedding` build, and the speech gate above — and only the
  classifier's NOTICE was ever fetched. The front end's was pinned in the
  manifest, never downloaded, never served, and not counted in the reported
  download size, while the daemon handed the embedding's bytes to browsers over
  the same chunk path it uses for the classifier's. All three are now fetched
  (`embedding-notice` and `vad-notice` are components of the provisioning plan,
  each fetched immediately after the artifact it attributes so a network that
  drops part-way never leaves bytes on disk with no attribution beside them), all
  three are served (`voice.wake.model.get` gains `component=embedding-notice`,
  `component=vad` and `component=vad-notice`), and all three are reported
  (`WakeProvisionStatus.embeddingNotice` / `vadNotice`,
  `WakeProvisionResult.embeddingNoticePath`). The classifier's and the front end's
  count toward `ready` — an artifact whose attribution is not on disk is not one
  this tree may hand to anything — and the gate's is held to the same rule inside
  `vadReady`, which is where the gate itself is reported. `downloadBytes` now
  comes from the manifest's own `wakeWordProvisionBytes` +
  `wakeWordFrontEndProvisionBytes` + `wakeVadProvisionBytes` rather than a
  hand-written field sum, which is how the omission happened.

- **Both pinned formats of the classifier are provisioned and served.** The
  `.tflite` twin was pinned, counted in every reported download size, and never
  fetched — so `voice.wake.status` quoted a 6.1 MB download for a 3.7 MB one, and
  `voice.wake.model.get` could not serve a format it did not have. It is fetched
  now (last, after everything the detector needs and after the speech gate, so a
  partial network still leaves a working detector) and is a `component=tflite`
  chunk read. It does not gate readiness: `WakeProvisionStatus.ready` still covers
  what the detector loads, with the twin reported separately as `mobileClassifier`
  / `mobileFormatReady`, because a host that missed only the twin is a host that
  detects.

- **Audio capture, as a capability the whole voice stack shares — so the wake
  word actually listens and the terminal can finally talk to speech-to-text.**
  The detector shipped complete and unused: twenty-five `voice.wake.*` rows, a
  pinned classifier, a front end computed in code, and nothing anywhere that
  opened a microphone. Capture now exists in
  `platform/voice/capture`, and it is deliberately NOT a wake-word detail — two
  consumers share one device path.

  - **A wake starts a capture session, it does not end one.** On a confirmed
    detection the same stream switches to recording the utterance that follows,
    seeded with the pre-roll from before the wake fired, and ends on
    `voice.wake.silenceStopMs` or at `voice.wake.captureMaxSeconds`. Re-opening
    the device at that moment would drop the front of the sentence and race
    whatever still holds it, which is the whole reason push-to-talk and wake
    detection cannot be separate stacks.
  - **Push-to-talk voice input is the other consumer**, and it is what the
    terminal never had: whisper was provisioned there and transcribed on
    request, while nothing on that surface had ever captured a sample.
    `PushToTalkSession` is the shared state machine — asking for the device is
    its own visible phase, and the device is released on every path out,
    including the failing ones.
  - **The recorder argv was checked against the real tools.** Most
    consequentially, `pw-record` is given `--container raw`: without it the
    stream carries a container header before the samples, byte-misaligning
    everything downstream — which does not fail, it just never detects. `sox`
    cannot select a device from its arguments at all, so the resolved command
    reports that instead of quietly ignoring `voice.wake.inputDevice`, and a
    recorder named explicitly and not installed is reported rather than silently
    swapped for another one, because pinning it was the point.
  - **Frames carry int16 magnitudes as floats**, the scale the classifier was
    trained on. Normalised −1..1 audio scores near zero forever and looks
    exactly like a microphone that is picking nothing up, so the frame contract
    says so in writing and `AudioFrameSlicer` re-cuts a recorder's ragged pipe
    reads into exact frames, carrying the remainder rather than dropping or
    padding it.
  - **`resolveWakeRuntimeSettings` is the one place every row becomes
    behaviour**, and the keys it reads are asserted against the schema in both
    directions — a row nothing reads is a row that configures nothing, which is
    precisely the state this change found. Rows that cannot take effect are
    reported as blockers (the detector does not start) or limitations (it runs,
    with that row not in force), each with a written reason.
  - **Three new verbs on the existing voice-setup group**:
    `voice.wake.status` (content-verified state of the pinned artifacts),
    `voice.wake.provision` (explicit, single-flight, ~3.7 MB) and
    `voice.wake.model`. The last exists because a browser tab cannot fetch the
    pinned assets itself — they answer with no CORS header — so it reads them
    from the daemon in bounded chunks, each restating the pinned sha256, and
    verifies the file it reassembled before creating a session.


- **Occasions and plans — the daemon raises important dates on its own, before
  they matter.** A new `## Important dates` section and a new `## Plans` section
  in the owner profile hold his own declarations, as prose lines he can hand-edit
  and that nothing rewrites. The daemon reads them, works out which are entering
  their lead window, batches them into one message, and delivers it — with the
  answer remembered so it does not keep asking, and remembered only until the
  date passes, because birthdays are annual. See `docs/occasions.md`.

  - **The kind is his, and is never inferred.** `gift-giving`, `remember-only`
    or `neither`, chosen in the same interaction that confirms the date.
    `occasions.confirm` refuses without one: no rule that reads a label tells a
    birthday from a death anniversary, and a cheerful "you'll probably want to
    sort something" against the wrong one would be genuinely bad.
  - **A nudge names the occasion and the person and never the date.** Not the
    date string and not a day count either — "in ten days" is the date with
    arithmetic applied. Proximity is a word chosen from a count that never
    leaves the composer, so a reminder delivered to Telegram cannot put a family
    member's birth date into a message channel.
  - **Telegram and the agent. Never the TUI**, which is refused as a
    destination structurally rather than left unconfigured. The TUI is a
    get-work-done interface and life admin does not belong in it.
    `occasions.nudgeChannel` takes a comma-separated list, so `telegram`,
    `agent` and `telegram,agent` all mean what they say, and each entry may
    carry an address (`telegram:12345,agent`). Telegram alone is the shipped
    default, so nudges push without being configured first; setting the key to
    empty makes the feature pull-only. Each destination is pushed on its own, so
    a broken credential on one cannot silence the other, and the sweep reports
    per destination which landed and which did not.
  - **The push and the pull cannot say the same thing twice.** The agent both
    receives pushes and pulls what is outstanding at a turn boundary, and both
    read the same open item: a push that lands on the agent stamps the item, and
    while the agent is a push destination `occasions.pending` leaves stamped
    items out. An item no push has ever landed there carries no stamp, so a
    missing sender or a failed send still leaves the pull as the way that nudge
    gets raised.
  - **Nothing unresolved is ever dropped.** One open-item mechanism behind all
    three cases: an unanswered nudge continues on its own rhythm, a "later"
    comes back roughly halfway to the date, a conflict between two declared
    dates is re-raised until he settles it, and a gift interview he walked away
    from resumes at the question he did not answer.
  - **A yes opens a short interview, not a shopping trip.** Three questions that
    guide him to his own idea, opened from what his profile already says about
    the person, recording what he landed on so year three is not steered by year
    one. It never recommends anything.
  - **The machine's bookkeeping stays out of his file.** Answers, gift history,
    open items, interviews and calendar mirror records live in a separate
    machine-owned store that is bounded, validated record by record, reaped on
    schedule, swept, and discloses what it holds through `occasions.state`.
    Every write is ordered.
  - **The calendar is a mirror, never a source.** Occasions can be written out
    to a calendar and are then left to the calendar's own reminder; nothing is
    ever read back the other way, and deleting a calendar entry cannot remove an
    occasion.
  - **It runs on its own.** A repeating pass in the daemon looks for dates
    entering their window; the interval is a live setting and the pass is
    strictly serial, so a slow one delays the next rather than delivering the
    same batch twice, and a failing one re-arms rather than ending the loop.
  - Sixteen `occasions.*` control-plane verbs and twelve `occasions.*` settings,
    all daemon-owned. Every operation a surface needs is a verb; nothing a
    surface renders has to be computed there.

- **The agent is a delivery destination, not only a place that asks.** `agent`
  is now a channel delivery surface kind, and every `ChannelDeliveryRouter`
  carries a strategy for it. The SDK owns the destination and the message
  contract; the agent product supplies the callable that lands the message in its
  conversation, registered through `router.agentDelivery.register(sender)` and
  removable through the undo it returns. A second registration is refused unless
  the takeover is explicit, and a push that arrives before the product has
  registered fails saying exactly that instead of looking like an unknown
  surface. New exports from `@pellux/goodvibes-sdk/platform/channels`:
  `AgentDeliveryRegistry`, `createAgentDeliveryStrategy`,
  `AGENT_DELIVERY_STRATEGY_ID`, `CHANNEL_DELIVERY_SURFACE_KINDS`, and the
  `AgentConversationSender` / `AgentConversationMessage` types. Route bindings
  are unchanged and still transport-only: nothing dials into an agent
  conversation, so `agent` is a destination that can be sent to, never a route
  that can be bound.

- **The paired-device posture is a platform contract, so every daemon host
  honours the `device.*` settings.** The mapping from those settings to the
  policy the stores and the capability service enforce, the peer/approval wiring
  around them, and the `phone` tool itself now live in `platform/devices`:
  `readDeviceCapabilityPolicy` / `readDeviceGrantPolicy` /
  `readDeviceArtifactPolicy` / `readDeviceSweepIntervalMs`,
  `createDevicePostureRuntime` (transport, approval bridge and config reader are
  the only seams a host supplies), and `createDevicePhoneTool` /
  `registerDevicePhoneTool`. Written in one consumer, those eleven keys were dark
  in every other host — including the terminal app's daemon.

  - **Every policy is now read live rather than frozen at construction.**
    `DeviceCapabilityService`, `DeviceGrantStore` and `DeviceCaptureArtifactStore`
    accept a resolver as well as a fixed partial, and `DeviceHousekeeper.start`
    accepts a cadence resolver and re-arms its timer after a sweep when the
    cadence changed. A `device.*` change governs the next request, the next
    grant, and the next sweep without a restart — the liveness
    `device.nodes.maxPaired` already had at the pairing path.
  - **A broken value reads as the stock posture, never a wider one.** A number
    that is not finite or not positive, or an enum value outside its list, falls
    back to the shipped default instead of being passed through.

### Changed

- **`voice.wake.enabled` no longer lies, in either direction.** The
  `wake-word-detection` registry entry's `notOperable` declaration is gone,
  removed in the same change that wired capture up as its own comment required,
  so the feature gate now follows the setting instead of refusing it outright.
  Every settings description was rewritten to say what is true PER SURFACE
  rather than that the feature does nothing: the terminal and the agent capture
  through a recorder subprocess (the terminal on by default), a browser tab
  captures through `getUserMedia` and is opted in per origin, and the rows that
  remain limited name their own limit — `voice.wake.vadThreshold` above 0
  refuses to start because no VAD model is pinned to screen frames with, and a
  browser tab has no filesystem for `voice.wake.retainAudio` or a local
  `voice.wake.activationSoundPath`.
- **The wake engine takes its warning sink from the host**, alongside the
  inference session it already took. It imported the platform logger, which
  writes files and therefore imports `node:fs` — enough to make the engine
  unbundleable for the browser tab it claims to run in, which nothing had
  exercised. A new `platform/voice/wake/runtime` subpath exports the
  runtime-neutral half of the module (front end, engine, rules, settings,
  listener) so a tab can import it without pulling provisioning's filesystem
  code in behind it.

### Fixed

- **Setting the occasions nudge channel to `agent` configured nothing at all.**
  The owner's ruling was that a nudge pushes to Telegram **and** the agent, but
  the agent was missing from the delivery surface vocabulary, so the router had
  no strategy that could claim the target and every push addressed to it was
  refused as an unsupported surface — silently, from the operator's point of
  view, because the setting accepted the value happily. The agent is now a real
  push destination (see above), `occasions.nudgeChannel` accepts one channel or
  a list of them, and every value it accepts reaches somewhere or reports why it
  did not.

- **The recovery sweeper no longer deletes an artifact the provisioner just
  verified.** Its pinned-filename sets listed the classifier's `.onnx` and NOTICE
  and the front end's `.onnx`, but not the `.tflite` and not the front end's
  NOTICE — so once either was provisioned every hourly sweep would have reaped it
  as an unpinned version, forever. Both directories now carry an explicit
  name-by-name set covering everything the provisioner writes, and a torn copy of
  either is reaped for failing verification (so the next provision refetches it)
  rather than for being an unpinned version.

- **A route binding is now a hint, validated every time it is used — a channel
  can no longer be stranded by a stale one.** A persisted binding whose session
  is closed, missing, corrupt, or not serviceable from this node is healed at
  the resolve seam per its own `sessionPolicy` (a `create-or-bind` binding rolls
  over to a fresh session) instead of throwing `Session is closed` at the
  ingress forever. This is surface-agnostic — it applies to every channel-bound
  adapter, not just the one it was observed on (Telegram messages were being
  dropped permanently against a session closed days earlier). When a rollover
  happens, the broker says so on the channel in one line, so a fresh
  conversation reads as a comprehensible reset rather than silent amnesia.
  Direct HTTP callers that name a `sessionId` themselves still get their 409 —
  healing applies only where no client exists to react.
- **A failed inbound owner message is an incident, not a log line.** The first
  failure to process an inbound message marks the channel degraded in channel
  health with the real reason and notifies the owner through a channel that
  still works — rate-limited, so the first failure pings, repeats within the
  window do not, and recovery notes itself once. Skipping past a poison update
  stays (a wedged cursor is worse) but is now loud, never a debug-log whisper.
- **Eight settings that described behaviour their value could never reach are now
  wired.** Each had a schema row, a validated default and a user-facing
  description, and a read chain that ended nowhere — so the key configured
  nothing and the coverage read as complete because the schema half was thorough.
  Every one is now read on a live path, at both of its positions.

  - **`runtime.eventBus.maxListeners`** reached no bus. `RuntimeEventBus` took the
    cap only as a constructor option and all three SDK construction sites passed
    none, so the cap was always 100 no matter what the key said. The hosts that
    own the config now point the module default at it at startup — the same shape
    `configureActivityLogger` already uses — which covers buses built by
    components that hold no ConfigManager, and an explicit constructor option
    still wins.
  - **`telemetry.decisionOtlpEnabled` / `decisionOtlpEndpoint` /
    `decisionOtlpSignal`** described an export the SDK could not perform: the
    exporter was complete — attribute mapping, spans, logs, the POST, the
    off-by-default guards — and called from nowhere. The permission layer now
    hands each decision it records to it, fire-and-forget, so an unreachable
    collector cannot stall a tool call. Still off by default, still export-only.
  - **`telemetry.otelMode`** made no difference at any of its three values. Its
    two feature gates were read only inside `createTelemetryProvider`, which had
    no callers, and the live meter was built without reference to either — so
    'off', 'in-process' and 'remote-export' all produced no spans. The composed
    runtime now builds its telemetry through the provider and installs the
    tracer, so 'in-process' records provider-call spans and 'remote-export'
    additionally ships them to the collector named by the OpenTelemetry standard
    environment variables. Selecting remote-export with no collector configured
    says so once rather than quietly behaving like the mode below it. The key's
    description said the export was OTLP/gRPC; the exporter has always spoken
    OTLP/HTTP JSON, and the description, the config type's doc comment and the
    `otel-remote-export` capability blurb now say so and name where the endpoint
    comes from.
  - **`cache.enabled`** did not stop prompt caching. The Anthropic provider built
    its cache context unconditionally, so 'false' still placed breakpoints and
    still paid cache writes. False now places none — off means off, not a shorter
    TTL. **`cache.stableTtl`** fed a `configuredTtl` field no caller populated, so
    its '5m' position produced the same 1h breakpoints as its '1h' one; the value
    now reaches the stable-content breakpoint. Both read per request, like their
    two live siblings.
  - **`watchers.recoveryWindowMinutes`** had no reader at all. It now bounds the
    missed-event catch-up a restart performs: a watcher restored inside the window
    runs immediately and picks up what it missed, rather than waiting out a full
    interval on top of however long the process was down; one restored outside it
    waits for its normal tick, and the skipped catch-up is stated rather than left
    to be inferred from a hole in the heartbeats.
  - **`web.staticAssetsDir`** was ignored by the daemon that serves static files;
    only `controlPlane.webui.bundleDir` was read. The precedence is now explicit
    in both descriptions: the specific `controlPlane.webui.bundleDir` wins when it
    names a directory, and `web.staticAssetsDir` supplies the directory when it is
    empty — so a host that puts its bundle where the build does needs only
    `controlPlane.webui.serve`. Neither directory key turns serving on by itself.
  - **`surfaces.email.imap.secure`** was never read: the surface config reader
    translated its SMTP twin and skipped it, and every IMAP connection went
    through the implicit-TLS factory unconditionally. False now selects a plain
    IMAP connection, exactly as the key describes, on both the mailbox service and
    the inbound-mail poller. The default TLS path is unchanged, and a transport
    with no plaintext factory is refused by name rather than quietly upgraded.

- **`runtime.unifiedTasks` claimed off; the shipped behavior was always on.**
  The key's recorded default was `false` and the `unified-runtime-task` flag's
  `defaultState` was `disabled`, but every consumer composition root built its
  task manager without a feature-flag manager at all, and the gate underneath
  is permissive with none wired — so the setting never actually governed
  anything, and task tracking (including the `/tasks` command and operator
  interventions) has always run regardless of this key. The default now
  records the truth (`true`/`enabled`) instead of a value the software never
  actually honored, so consumers can wire the flag manager and have `false`
  genuinely turn the runtime task manager off, with zero behavior change for
  any install that never touched this setting.

## [1.19.2] - 2026-07-29

Repairs inbound message delivery for every configured chat, notification and
telephony surface. Anyone on 1.19.1 with a surface configured through the
settings UI should update: their surfaces are refusing inbound traffic.

### Fixed

- **A correctly-configured surface answered 401 to every inbound POST.** 1.19.1
  added a sweep that moves credentials still sitting in the clear in a config
  file into the encrypted secret store, leaving a `goodvibes://secrets/…`
  reference in the config. Delivery paths resolve that reference; the inbound
  webhook adapters did not. Each compared its config value byte-for-byte
  against the secret the caller presented, so it was comparing the reference
  TEXT against the real secret — a mismatch on every request. Nothing reached a
  session: messages sent to the daemon were rejected, and the only symptom was
  an unexplained 401.

  Operators who never had a plaintext credential to sweep were affected too.
  The settings modal has written references for these keys since before this
  round, so a surface configured through the UI has always been in this shape;
  1.19.1 is simply when a fresh sweep put existing installs there as well.

  Telegram in webhook mode was the worst case, because the two halves of one
  surface disagreed: the daemon registers the webhook with the RESOLVED secret,
  so Telegram sent exactly the right value and the adapter rejected it against
  the unresolved reference. Polling mode never reads that config value and was
  unaffected.

  Fifteen credential reads across twelve adapters now resolve through one
  shared helper before comparing: webhook, telegram, ntfy, google-chat,
  whatsapp (verify token and signing secret), msteams, matrix, mattermost,
  bluebubbles, imessage, signal, and telephony (webhook secret, token and
  Twilio auth token). A credential set as a literal — an operator who was never
  swept, or one configuring by environment variable — keeps working unchanged.

- **A credential that cannot be resolved now refuses the request instead of
  waving it through.** Seven of these adapters skip the comparison entirely
  when no credential is configured, which is the correct reading of an
  unconfigured surface. Resolving the reference in place would have made a
  BROKEN credential indistinguishable from an ABSENT one, and those seven
  surfaces — telegram, google-chat, matrix, mattermost, bluebubbles, imessage
  and signal — would have accepted any caller, including one presenting no
  secret at all. The shared helper reports "resolved", "absent" and
  "unresolvable" as three different answers, and a surface whose credential is
  configured but unresolvable now answers 503 and logs which config key is at
  fault, naming the key and never the value. A setting containing only
  whitespace counts as configured-and-broken for the same reason, rather than
  being trimmed into looking unconfigured.

### Changed

- **BlueBubbles reads its password from the request header first, and falls
  back to the `?password=` query parameter.** The query parameter still works,
  because the BlueBubbles server can only be configured to send it that way and
  removing it would break every existing install. But a credential in a URL is
  copied into access logs, proxy logs and referrer headers by things that were
  never asked, so a caller that can send the header no longer has its query
  parameter read instead. The comparison is also constant-time now, matching
  every other adapter.

## [1.19.1] - 2026-07-29

Write-ordering fixes for state held in `PersistentStore`. The entries below are
one defect shape appearing in different stores: a whole-file write built from a
snapshot taken when the write was requested, with nothing ordering the writes,
so two in flight at once finish in whichever order their renames land and an
older snapshot can come down on top of a newer one. The file then disagrees
with memory, and after a restart the state has silently gone backwards.

### Fixed

- **An approval that had been answered could go back to `pending` on disk.**
  `ApprovalBroker` wrote its whole store on every change, and the window is the
  one every create passes through: `requestApproval` puts the record in memory
  before it writes it, so a surface can resolve an approval while the write that
  created it is still in flight. When that happened, the
  create's rename landed second and restored the snapshot it took before the
  approval was answered. After a restart the record read back as `pending`, and
  because silence on a payment approval means denied, an approved purchase was
  eventually a denied one — the decision lost, in the path whose whole job is to
  keep it.

  Writes now go through a per-broker queue (`StoreWriteQueue`): one at a time,
  in call order, so the newest write is the one that survives. The snapshot is
  still taken when the write is requested; ordering is what was missing, and
  deferring the snapshot would let a write serialise records belonging to
  callers that had not committed yet. A failed write rejects for its own caller
  only and never becomes the queue, so one unwritable moment cannot wedge every
  write after it. `requestApproval` also writes the corrected store when it
  rolls a failed create back out of memory, so a record a neighbouring write had
  already carried to disk does not outlive the create that disowned it.

  This fix adds no API. `StoreWriteQueue` is internal to the SDK, and is the
  remedy the other entries in this section reuse where the store is written by
  a single process; one written by more than one takes the advisory lock at
  `PersistentStore.lockPath` instead.

- **The same unordered-write defect, in twelve more stores.** `ApprovalBroker`
  was where CI happened to catch it; the shape it caught is the shape every
  store built on `PersistentStore` had. Each of these now writes through the
  same per-call queue, and each is pinned by a test that fails with the real
  symptom when its queue is removed:

  - `UserPermissionRuleStore` — a revoked "always allow" rule came back and
    silently auto-approved the next matching ask. Durable user rules are
    consulted before anything prompts, so the revocation had no effect at all
    after a restart.
  - `DaemonBatchManager` — a cancelled batch job read back as `queued` and the
    next tick submitted it to the paid provider.
  - `SharedSessionBroker` — the 60-second GC sweep persists without waiting, so
    it could land over a `cancelInput`; the input read back as `queued`, and
    boot reconciliation spawns an agent for queued work.
  - `ChannelPolicyManager` — the audit flush is scheduled on every inbound
    message and was ordered only against itself, so a "disable this surface"
    ruling or an owner-allowlist seed could be overwritten by it.
  - The four automation stores (`jobs`, `runs`, `routes`, `sources`), shared by
    `AutomationManager` and `AutomationService` — the manager is designed for
    four concurrent runs plus a 2-second reconcile timer, and a completed run
    that read back as `running` was re-executed after a restart.
  - `TaskScheduler` — `add`/`remove`/`setEnabled` each fire a save nobody waits
    for; a deleted cron task came back and spawned an agent on the next start.
  - `CiWatchService` — a poll's write is requested before its network round trip
    returns, so a deleted watch could be restored and keep notifying.
  - `PrincipalRegistry` and `ChannelProfileRegistry` — a deleted identity
    mapping or channel binding could be restored by a create/set that started
    before it.
  - The distributed-runtime store — writes are fired unawaited from ordinary
    list calls; a rejected pair request read back as `pending`, which is a peer
    the operator turned away still able to complete pairing.
  - `CheckinReceiptStore` — an append-only log where the earlier write's
    snapshot does not contain the later receipt, so a check-in that contacted
    the owner could leave nothing on disk saying it ran.
  - `KVState` — `dispose()` racing a debounce that had already fired; a cleared
    key came back when the session was resumed.
  - `InboundMailHousekeeper`'s disclosure log — the one case where ordering the
    write alone would not have been enough, because each write is the file's own
    previous contents plus one entry. Its READ is inside the serialised unit too,
    so two overlapping sweeps cannot drop one sweep's record of what it reaped.


- **A lost workspace registration.** `WorkspaceRegistrationStore.add` / `remove`
  / `decline` were read-modify-writes with no exclusion of any kind, and this is
  the one daemon store a second PROCESS writes — `goodvibes register` in a
  project directory writes the same user-scoped file the running daemon writes.
  Two registrations that interleaved lost one of the two roots outright: no
  coverage for that project, and nothing anywhere saying so. Each mutation now
  runs under both an in-process chain and the advisory lock at
  `PersistentStore.lockPath`, which is the shape `PushSubscriptionStore` already
  uses and which that class's header directs read-modify-write callers to.

## [1.19.0] - 2026-07-28

Three capabilities the platform did not have — spending money, knowing who its
owner is, and reading mail as it arrives — plus the two boundaries they made
non-optional: every verb's input and output now carries its real type, and
externally-authored text is marked as such wherever it enters.

The operator surface goes from **443 to 464 methods**. Events (32) and peer
endpoints (6) are unchanged.

### Added

- **Payments — `payments.*` (7 verbs), new subpath `./platform/payments`.**
  `payments.checkout.begin`, `payments.checkout.fillCard`,
  `payments.cards.create` / `.list` / `.delete`, `payments.purchases.list`,
  `payments.budget.status`. The SDK owns budget arithmetic, the decision order,
  both approval-window state machines, the shipping ladder, message rendering,
  the audit ledger and the taint gate — all pure and injectable under
  `platform/payments/*`. The daemon serves the verbs; surfaces are wiring and UI
  only, with no decision logic. Card material and settings live in the
  daemon-owned config and secret tiers. Design of record: `docs/payments.md`,
  including §12.1's list of rulings taken and their reasoning.

  The premise is stated in the design and worth repeating here: a card turns a
  successful prompt injection from "sends an email" into "buys something", so
  the untrusted-content work below is a precondition of this feature rather than
  a companion to it.

- **Owner profile — `profile.*` (9 verbs), new subpath
  `./platform/owner-profile`.** `profile.get`, `.set`, `.append`, `.read`,
  `.person`, `.provenance`, `.forget`, `.undo`, `.status`. One Markdown file at
  daemon scope, read once into memory at boot and read back out at the cost of a
  property access. `profile.read` carries its own scope so enumeration is gated
  separately from keyed reads, and the closed-tier prose sections are reachable
  only through `person(name)` — `section()` refuses them. Every write takes an
  authority argument; it is never defaulted. Design and the four owner rulings
  it is built from: `docs/owner-profile.md`.

- **Real-time inbound email — `email.*` (4 verbs).** `email.inbound.status`,
  `email.expectation.open` / `.list` / `.cancel`. The daemon could send mail and
  could read mail when asked; nothing ever asked on its own, so there was no
  delivery path to fix — there was no delivery path. `platform/email/inbound/*`
  adds an IMAP IDLE watcher with a poll-loop fallback and backoff, a Gmail
  history-delta source preferred when Google is adopted, per-source cursor,
  record and expectation stores, a probed body-access capability check, health
  reporting on the daemon's own health surface, and an owner-notice path.
  Design of record: `docs/inbound-email.md`; read §5 first.

- **`mcp.servers.reveal`** — reads back a configured MCP server entry.

- **New public subpath `./platform/runtime/path-shadow`** — resolves which
  binary on `PATH` actually answers for a command name, and reports the losers.
  Written after a stale `~/.bun/bin/goodvibes-agent` link shadowed a current
  install and the symptom looked like a version that would not update.

- **Typed IO for every catalogued verb.** `OperatorMethodInputMap` and
  `OperatorMethodOutputMap` go from 368 entries to **464** — every verb in the
  catalogue, generated rather than hand-maintained, with the coverage ratchet
  dropped to zero. The OpenAPI contract now renders 365 paths across 464
  methods with **0 marked `untyped-client-io`**.

- **An untrusted-content boundary that covers the paths it claimed to.**
  `platform/calendar/untrusted-events.ts` marks invitation-authored summary,
  description, location and attendee text; `platform/tools/fetch/untrusted-ingest.ts`
  closes the `fetch` tool, which recorded nothing at all while the browser
  engine and both mail surfaces recorded their reads — a page loaded through
  `browser.*` could not steer a send and the same page loaded through `fetch`
  could. `platform/security/untrusted-surface-language.ts` gives the refusal
  wording one owner. Card-shaped content is refused on remote channels and
  redacted out of inbound mail.

- **A credential scope registry.** `platform/config/credential-scope-registry.ts`
  names every credential the platform stores and whether the daemon needs one,
  so daemon-needed credentials are written at daemon scope no matter which
  surface captured them.

### Changed

- **`OperatorMethodInput` and `OperatorMethodOutput` are now indexed accesses,
  not distributive conditionals — and the permissive fallback is gone.**
  Every id has a rendered entry, so the lookup no longer needs a conditional
  branch. It could not keep one: relating a client object literal to an
  interface generic over the 464-id union instantiated the conditional once per
  id and produced **TS2590, "Expression produces a union type that is too
  complex to represent"** in `packages/operator-sdk/src/client-core.ts` and
  `packages/sdk/src/browser-scoped.ts`. Rationale:
  `docs/decisions/2026-07-28-operator-method-io-is-an-indexed-access.md`.

  **This is the breaking part for consumers.** Ids with no map entry used to
  resolve to `{ [k: string]: unknown }`, which accepted anything. They now carry
  their real shapes and their real `required` arrays. Measured against the webui
  as the worst case: of the 33 distinct method ids it invokes, **22 now enforce
  at least one required field**, and a bridge type that still declares them
  optional is a compile error at the re-pin. That is the wanted outcome — the
  server was already refusing those calls and the consumer could not see it. The
  full table is in `docs/decisions/2026-07-28-webui-repin-required-fields.md`.

- **Every catalogued verb declares its handler requirement**, so a composition
  that cannot serve a family says so at registration rather than at call time.

### Fixed

- **A channel reported `healthy` because its token was in config, not because it
  worked.** `ChannelStatusSnapshot.state` was computed from credential presence
  alone, so a Telegram bot whose ingress had stopped kept reporting healthy for
  as long as its token stayed configured: a message was sent, no reply came, and
  every surface agreed everything was fine. Four surfaces were worse — Slack,
  Discord, ntfy and the generic webhook reported healthy whenever their delivery
  switch was on, without checking for a credential at all. Meanwhile
  `BuiltinChannelRuntime.telegramIngressStatus()` — the function that knew the
  answer, including the named reason ingress was inactive — had no caller.

  The reported state now answers whether the channel can send and receive right
  now. `ChannelHealthState` distinguishes `healthy`, `degraded`, `dead`,
  `unknown`, `unconfigured` and `disabled`, and every snapshot carries the
  `ChannelRuntimeObservation` its state was derived from, reason included. One
  rule resolves it (`resolveChannelHealthState`), so a surface cannot report
  health without an observation behind it.

  Telegram is read from the ingress supervisor (webhook mode counts as armed —
  it runs no poll loop by design, and reading `running` alone would have called
  a correctly registered webhook dead). Slack, Discord and ntfy are read from
  the provider connection manager. Every other built-in surface receives through
  a webhook this daemon merely registers and therefore cannot tell a working
  provider from a silent one — those report `unknown` and say in plain words
  that configuration is all they know. No invented greens.

- **A credential that is declared but resolves to nothing is now its own
  state.** Measured on this project's own machine: `daemon/secrets.enc` was
  `{}`, the Telegram token sat in `agent/secrets.enc` and `tui/secrets.enc`, and
  `daemon/settings.json` pointed at
  `goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN`. Every daemon send failed
  with "Missing Telegram bot token" while the agent's own path sent fine through
  its own store — and both reported the same health, because a reference is a
  non-empty string and that was all "configured" ever meant.

  `describeBuiltinSecret` now resolves what it describes, so
  `ChannelSecretStatus` carries `resolved` alongside `configured` and a `source`
  of `unresolved`, and the snapshot carries `credentialResolves`. The health
  state `unresolved` sits between `unconfigured` (nobody believes it works) and
  `dead` (it resolved and the runtime is down), and the reported reason names
  the field rather than the symptom. The doctor gains a matching
  `credentials-resolve` check. It costs a store read — no network, no trial
  send. An observed working path still outranks it, so a surface reading its
  credential through a path this describer does not model is never called broken
  while it is demonstrably carrying traffic.

- **A dead channel now reaches the owner instead of sitting in a field.**
  `ChannelHealthWatcher` sweeps the registry, and the daemon announces a channel
  that stops working over a channel that still does — never over the failed one.
  Recoveries are announced to whoever was told about the failure, a channel that
  stays dead is repeated on a long interval rather than mentioned once, and
  `unknown` is not treated as failure so webhook-delivered surfaces do not cry
  wolf. When nothing survives to carry the notice, that fact is logged at ERROR
  with the alert, so the log says both that a channel died and that nobody was
  told.

- **Credentials already stranded in a surface silo are lifted to the daemon
  tier on start.** Routing new writes correctly fixes nothing for someone who
  already ran setup — the owner ran `/google adopt` in the agent, it reported
  success, and the credential landed where that build put it. The daemon
  previously enumerated only its own surface root, so a credential left in
  `~/.goodvibes/agent/` was invisible to the one thing that could lift it.
  `listDetailedForMigration` now reaches every surface, project and user store
  on the machine, and `migrateOnSurfaceStart` gives a surface the same entry
  point so a machine whose daemon has not run yet is still repaired. A
  plaintext-credential sweep moves values out of settings files, and the
  migration no longer destroys the credential it has just saved.

- **The publish rehearsal was stricter than the publish.**
  `scripts/publish-packages.ts` applied a check on the `--dry-run` path that the
  real publish path did not, so a rehearsal could fail on something a genuine
  publish would have accepted. Both paths now run the same checks.

- **Test temporary directories leaked.** Several suites created throwaway home
  and store directories per case without reaping them; on a tmpfs that
  exhausted inodes. The suites reap, and a regression gate counts containment
  rather than reading the hook.

### Migration

- **Re-pin consumers to 1.19.0 and expect required-field compile errors.** Any
  bridge or wrapper type that declared an operator method's input fields
  optional because the id previously fell through to the permissive fallback
  must now declare the real required fields. See
  `docs/decisions/2026-07-28-webui-repin-required-fields.md` for the measured
  per-id table.

- **`./platform/payments` and `./platform/owner-profile` are published for the
  first time.** Consumers carrying a local overlay or `file:` tarball for either
  can restore their npm pin. The duplicated `WEBUI_CARD_ENTRY_CONDITIONS` copy
  in the webui can be deleted and imported from the SDK — see
  `docs/decisions/2026-07-28-payments-release-gates.md`.

- **Daemon-needed credentials move to daemon scope on first start of 1.19.0.**
  The migration copies rather than moves, and is idempotent. No action required;
  a capability that reported itself unconfigured next to a working credential
  should stop doing so.


## [1.18.1] - 2026-07-27

### Fixed

- **A mail route on a daemon without mail deps dispatched into itself 256 times
  and then blamed load.** 1.18.0 made `email.*` served and invokable, and its
  REST paths reachable — but only on a composition that hands the mail verbs
  their dependencies. On one that does not (a bare `bootDaemon`, an embed, a
  test harness), the handler is absent, and that turned out to be a cycle rather
  than an answer.

  `invokeGatewayMethodCall` has two arms: run the attached handler in process,
  or — no handler, but the descriptor advertises an `http` binding — synthesize
  a request to that path and feed it back into the real router. The second arm
  exists for verbs whose implementation is a genuine HTTP route elsewhere in the
  chain. It stopped being safe when the gateway REST table gained rows for the
  handler-backed families, because those rows map the advertised path straight
  back to the SAME methodId. The synthesized request re-entered the same arm and
  synthesized again. Before those rows existed the synthesized request 404'd and
  the loop ended in one hop — the "plain 404" the route-reconcile module
  documents. Adding them closed the cycle.

  Measured on a 1.18.0 daemon: one `GET /api/email/inbox` produced **256 nested
  dispatches**, then answered
  `503 ws-call-overloaded — Daemon is at its concurrent WS-call cap (256)`.

  Both halves of that were wrong. The capability was not wired, which is a fixed
  and terminal condition, not a transient capacity problem that might clear on
  retry — anyone reading that message would have gone looking at load, and load
  was never involved. And a single request consumed the daemon's entire
  concurrent WS-call budget, so a handful of them would have starved every other
  caller on the daemon.

  Two guards, deliberately independent:

  - An advertised binding that routes back to its own methodId is no longer
    dispatched at all. There is no other implementation to reach, so "no
    handler" is terminal, and the caller is told exactly that: **501** with
    `code: NOT_INVOKABLE` and a message naming the capability and saying it is
    not wired up in this composition — a supported configuration, described as
    one rather than as a fault.
  - A synthesized request now carries its dispatch depth, and one that re-enters
    the dispatcher is refused as a **loop** (500, `INTERNAL_ERROR`) rather than
    reported as capacity. Depth travels with the request rather than being
    tracked per path, because two clients legitimately asking for the same path
    at the same moment are not a cycle and a path-keyed set would call them one.

  Verified against a real daemon the same way the defect was found, counting
  dispatches: `/api/email/inbox`, `/api/email/inbox/{uid}` and
  `/api/email/drafts` go from **256 dispatches and a 503** to **0 dispatches and
  a 501**, while `calendar.events.list` — whose handlers do attach from
  `homeDirectory` alone — still returns its real `CALENDAR_NOT_CONFIGURED`, and
  `/status` is untouched.

- **The gate that should have caught it.** `test/gateway-self-dispatch-loop.test.ts`
  reads the self-routed method ids out of the real REST table rather than a
  hand-kept list, so a family added later is covered without anyone remembering
  to add it. For each one it asserts the two invariants that matter — never a
  `ws-call-overloaded` answer, and never a re-entry into the router — plus the
  honest 501 for the verbs that reach the dispatch arm unobstructed. Checked by
  reverting the guard: 41 of its 68 assertions fail without the fix and all 68
  pass with it, so it is a gate rather than decoration.

### Changed

- `readBodyBounded` moved from `platform/daemon/control-plane.ts` to its sibling
  `platform/daemon/helpers.ts`. No behaviour change; the guards above pushed
  control-plane.ts over the 800-line cap, and an unrelated helper was the honest
  thing to move rather than trimming comments off the file until it fit.

## [1.18.0] - 2026-07-27

Mail, calendar and a browser stop being things a surface implements and become
things the platform serves. Everything below follows from that one move: the
Google connector, the IMAP/SMTP email service and the Playwright browser engine
were implemented inside products, so a daemon — the one runtime with no surface
attached — could not read a mailbox, answer a calendar request or open a page.
Scheduled work, triggers and inbound channel messages had no way to do any of
it. All three are now SDK code, served over the operator contract, with the
products consuming them instead of carrying their own copy.

Serving them from an unattended process is what makes the security half of this
release necessary rather than optional, and it is the larger part of the work.

### Added

- **`./platform/google`** — the Gmail and Google Calendar connector, hoisted out
  of the agent. `./platform/google/node` holds every node built-in it needs, so
  the connector proper stays runtime-neutral: sockets, files, processes and
  listeners are injected.

- **`./platform/email`** — the IMAP4rev1 client, the SMTP submission client, the
  service that resolves config and secrets and drives them, the writing-style
  draft composer and the Personal Ops lane descriptors. `./platform/email/node`
  carries the node-only half for the same reason.

  New capability inside the client, not just relocation: `fetchMessage(uid)`
  reads a whole message over UID FETCH (a sequence number from an earlier
  listing may now be a different message), reads headers and BODYSTRUCTURE and
  then only the `text/plain` and `text/html` sections — attachments are reported
  from the structure and their bytes are never downloaded, so a 30 MB archive
  costs a filename and a size. Every fetch is `BODY.PEEK`, asserted on the wire
  bytes a fake server receives, because a plain `BODY[` marks the owner's mail
  read behind their back. `appendDraft` uploads as a literal counted in BYTES,
  discovers the Drafts folder by `\Drafts` special-use (RFC 6154) then by name
  then by fallback — Gmail's is `[Gmail]/Drafts` and a hardcoded name creates a
  stray folder there — and refuses CR/LF in every caller-supplied header field
  rather than sanitizing it. `APPENDUID` is reported when the server advertises
  UIDPLUS and `null` when it does not; no id is invented.

- **`./platform/browser`** — the Playwright browser engine, hoisted out of the
  agent, with the session-ownership vocabulary it enforces: `launch` starts a
  browser this daemon owns and may close, `attach` connects to one it did not
  start and may never close, `release` lets go of an attached browser while
  leaving it running.

- **`./platform/security`** — the untrusted-content contract: the standing rule
  text, the per-process ingest ledger, the outward-effect decision and the port
  factory a browser engine is handed. This was the agent's module, which was
  correct while the agent was the only runtime that could both read a page and
  send a message. It is not any more.

- **Nine mail and calendar methods are served and invokable.**
  `email.inbox.list`, `email.inbox.read`, `email.draft.create`, `email.send`
  and the `calendar.*` family reconcile live: handlers behind an
  `EmailGatewayService`/`CalendarGatewayService`, rows in the gateway REST
  table, flags cleared. The advertised paths are unchanged — the catalog was
  always honest about where these live; what was missing was an implementation
  the daemon could reach.

- **CalDAV as a second calendar backend** alongside Google: discovery, event
  list/get/create, `.ics` import and export, reading `surfaces.calendar.*`
  through injected config and secret ports and speaking to an injected HTTP
  port. Which backend answers is decided in the composition — a configured
  CalDAV server, else a connected Google account.

- **24 `browser.*` verbs, with routes and handlers**, so a caller with no
  surface process attached can drive a browser: navigate, snapshot, click,
  type, select, press, scroll, wait, read text, extract, screenshot, tabs,
  history and the full session lifecycle. That is the whole surface a product's
  browser tool exposes rather than a convenient subset, and a test maps each of
  the tool's actions to the verb that serves it so a later change cannot quietly
  leave the daemon a smaller browser than a surface has. The route layer imports
  nothing from `platform/browser`, so the engine's guarantees are preserved by
  not re-deciding them: a session the daemon did not launch is still refused a
  close by the session registry rather than by a second opinion in the routes.

- **A daemon-owned secret tier, and 25 new `surfaces.email.*` /
  `surfaces.calendar.*` schema keys.** The paths were already daemon-owned,
  which fixed WHERE a value is stored; it did not make them settable, because
  the settings modal renders from `CONFIG_SCHEMA` and none of these were in it.
  So the handlers' own errors — "Set `surfaces.calendar.caldavUrl` and
  `surfaces.calendar.caldavUser`" — named keys no operator could reach through
  the UI that told them to set them. Both spellings of the IMAP settings are
  declared, because both are read: the inbox provider reads the flat
  `imapHost`/`imapPort`/`imapUser`/`imapPassword` and the triage tagger reads
  the nested `imap.*`.

- **`describeSenderClaimNeutrally`** — a shared sender-claim describer for a
  product with no wording of its own. The SENTENCE a person reads belongs to the
  product, so `EmailServiceDeps.describeSenderClaim` stays a required port; the
  DECISION it reports does not. A `From:` header is a claim, sender
  authentication raises display confidence and nothing else, and
  `commandAuthority` is the literal `'none'` — the type makes any other
  authority value a compile error.

### Changed — the email trust model

- **A derived outward send is refused, not disclosed.** A send from the daemon
  used to be allowed with a disclosure attached, on the reasoning that an
  unattended process has nobody to take a refusal to. That is backwards: a
  disclosure is a note in a receipt nobody reads, on the one surface with no
  human watching, and an unattended daemon is exactly where an injection pays
  off.

  What makes the strictness affordable is asking a narrower question — not "has
  this process read anything untrusted", which is permanently true in a daemon
  and therefore decides nothing, but "does THIS action's content derive from
  what was read". A scheduled report built from a database proceeds. A send
  whose recipient, subject or body repeats text from a page or a mailbox is
  refused, and the refusal shows the overlapping text so it is checkable rather
  than asserted. Disclosure is kept for the sends that pass; it stops being the
  only protection.

  **The check is connected to the paths that read.** A peer round verified this
  at runtime rather than by reading and found it inert: no production path
  supplied the text it compares against, so `taintSourcesThisTurn()` returned
  empty and the refusal refused nothing. A security check that silently passes
  everything looks exactly like a working one. `UntrustedContentPort.recordIngest`
  and `EmailServiceDeps.recordUntrustedIngest` now carry content,
  `createUntrustedContentPort` forwards it, `BrowserEngine` records page text
  from `readText`/`snapshot`/`extract`, and `EmailService` records subject and
  body — proven end to end: two ingests, two taint sources, a send repeating the
  injection refused.

  **Recipient redirection is caught by exact containment**, not by length:
  `accounts-payable@vendor.example` is 3 words and 31 characters, under both
  thresholds, so an injection that only changes where mail goes slipped past a
  length test while the comment claimed it was covered. One exemption: replying
  to the ENVELOPE SENDER, established from delivery evidence rather than a
  `From:` header.

  **A turn now begins on `explicitUserRequest`.** `startTurn()` had no
  production caller, so "this turn" meant "since process start" — harmless
  driving a disclosure, wrong driving a refusal, since a daemon up for a week
  carried a week of strangers' text as evidence against every send. Automated
  work deliberately does not reset it, so content cannot arrange for the record
  of itself to be erased.

  Two false-positive classes are fixed without touching `MIN_SHARED_CHARS`
  (which would weaken the verbatim-token case the check exists for): a span
  appearing in two or more distinct origins is boilerplate rather than
  derivation, and quoted regions are stripped from a reply body before checking.
  An injection placed outside the quote is still caught.

- **Links are validated before navigation.** Every rule exists because a naive
  check fails to a specific attack, and each refusal names which: userinfo
  (`https://accounts.google.com@evil.example` reads as Google), scheme,
  homograph (mixed-script labels refused outright rather than similarity-scored),
  eTLD+1 comparison (`google.com.evil.example`, `google-verify.example` and
  `accounts-google.example` all defeat `endsWith` or `includes`), redirect
  chains where every hop is re-validated and any hop leaving the domain refuses
  the chain, shorteners refused by name, IP literals, and non-443 ports. Refusal
  is loud and carries both domains, because a refused verification link is often
  something the owner has to finish by hand.

  **The public-suffix snapshot is generated, not curated.** Its drift check
  found on first run that the hand-written list held 174 of 5,484 ICANN
  multi-label suffixes, leaving 5,332 under which two different registrants
  compared equal. It is 5,501 entries now and the check is green. It is bundled
  and never fetched at runtime; a weekly workflow outside `ci.yml` fails on
  drift, and its text says what a red run means — a narrowing of coverage, not
  an outage, because the single-label fallback keeps unknown suffixes resolving
  correctly.

- **Verification expectations are scoped to what the agent is doing now.** An
  expectation is opened only for a signup it is completing or a login it is
  performing, so unsolicited verification-shaped mail with no open expectation
  can never cause an action. The login case correlates far more weakly than the
  signup case — the address is one the owner already gave out — so it is
  compensated: the link must be on the EXACT domain rather than a tolerated
  subdomain. Ambiguity stops everything: two messages matching one expectation
  act on neither and surface both, because a phisher racing a genuine login is
  precisely what produces two, and choosing is a coin flip.

- **Trust tiers are declared per surface**, with no middle tier — a middle tier
  is where "this one is probably fine" lives, and the attack is content that
  looks fine. Sender authentication informs the sentence a human reads and never
  the tier: a phisher who owns their domain and configures DNS correctly passes
  DKIM, SPF and DMARC.

- **A send to the owner himself is exempt from the taint refusal** (owner
  ruling: he is the trust root, not a third party, and telling him what arrived
  is the point of an assistant reading his mail — "what came in overnight"
  necessarily reuses the words of what came in). The exemption is drawn as
  narrowly as it can be, and every narrowing is tested as an attack that must
  fail: his configured addresses only, never a domain (that would exempt every
  colleague, and a forward to a colleague is third-party disclosure), never a
  pattern (no plus-address folding), and never partial — a send to the owner AND
  anyone else is refused, because naming him first and slipping a second
  recipient in beside him is exactly how this would be used. Identity comes from
  configuration alone (`email.fromAddress`, `email.username`,
  `surfaces.email.from`/`.user`/`.username`) and never from a `From:` header,
  `Reply-To:`, delivery evidence, the ledger or the body. Nothing configured
  means no identity, so the exemption cannot fire and the refusal stands. It
  exempts the taint rule and nothing else: link validation, the confirmation
  gate and the explicit-user-request rule all still apply.

### Changed

- `browser.tabs.new` is now **`browser.tabs.create`**, on `POST /api/browser/tabs`
  beside the GET that lists them — opening a tab IS creating one, so it took the
  core verb rather than an exemption. The other seventeen flagged browser verb
  tails get a documented exempt category instead: these are the operations a page
  and a browser process actually have, and renaming them to CRUD words would
  describe something else. Navigate is not update; press is not set.

### Fixed

- **A Telegram 409 is never terminal, and its cause is established rather than
  guessed.** Inbound Telegram went permanently dead on a live machine: polling
  stopped at 12:24 and stayed stopped until a human restarted the daemon, with
  every message in between unread. Telegram uses 409 for two unrelated
  situations — a registered webhook, and another process long-polling the same
  token — and they were told apart by matching the description against
  "terminated by other getUpdates", with `isWebhookConflict` defined as "409 and
  not concurrent". Webhook was therefore the DEFAULT for every 409 whose
  description was missing, reworded, or replaced by an intermediary's error
  body. A string that has to be exhaustive to be safe is a guess, not a
  classification.

  `getWebhookInfo` is now the authority and the description only enriches what a
  person reads; the decision moved to `conflict-policy.ts` as pure data, so every
  branch is provable without a socket. Neither cause is fatal: a proven stuck
  webhook escalates to an error naming the fix and keeps retrying, and a
  competing consumer is reported so a cluster coordinator can stand the node
  down, then retried anyway — with `cluster.enabled` off there is no election to
  stand down to, which is exactly how the failure became permanent. Retries are
  jittered so two consumers cannot settle into lockstep terminating each other's
  long poll, and a surface that is up but not consuming reports itself blocked
  with the reason instead of sitting silent.

- **A throwaway daemon could replace the machine's daemon.** A daemon started
  from a scratchpad with `--daemon-home` found the machine's service unit not
  running, wrote its own scratchpad `ExecStart` into the systemd unit and
  exited; systemd then supervised the throwaway, which read the real home's
  config and the real home's credentials and long-polled the real bot — the
  collision that produced the 409 above. A daemon whose home was overridden now
  never adopts the machine service unit, and the check runs BEFORE
  `service.enabled` deliberately: that key is client-owned and resolves against
  the real home, so a test tree's own opt-out was written and never read.
  Isolation that depends on the isolated process reading its own settings file
  is not isolation.

- **`SecretsManagerOptions.daemonHome` is finally passed.** Its own doc always
  said a caller honouring `--daemon-home` should resolve and pass it; no
  composition root ever did, so the override moved the identity directory and
  nothing else while the credential store stayed in the real home.
  `describeSecretIsolation` reports which tier still reaches it, because the
  interesting answer is not "isolated: false" but which of the three roots
  leaked.

- **Surfaces filed daemon credentials where the daemon could not read them.**
  The daemon-owned secret set is derived by walking enumerated daemon-owned
  config paths, not by prefix; `surfaces.` has always been a daemon-owned
  prefix, but nothing enumerated `surfaces.email.password` or
  `surfaces.calendar.caldavPassword`, so the password went to whichever client
  store the operator happened to be sitting in. The whole mail and CalDAV
  connection is now declared, not only the passwords — a password with no host
  and no user is not a usable credential either. An explicit scope also beat
  daemon ownership, and `/secrets set` passes one on every call, so the ordinary
  path a person takes to store a credential defeated the routing outright.
  Daemon ownership now wins, the write is relocated rather than refused, and the
  relocation is disclosed: `set()` logs it naming both scopes, and
  `resolveSecretWriteScope` is exported so a surface can say where a credential
  is going before it asks. `delete()` gets the same treatment, or a revoke
  narrowed to the wrong scope would report success and leave the live copy in
  place.

- **A daemon-owned app-layer key bricked `ConfigManager` construction.**
  `email.*`, `calendar.*` and `google.*` are app-layer sections a product
  materializes at runtime, and the daemon-tier overlay runs inside the
  `ConfigManager` CONSTRUCTOR — before any product has called its `ensure*`
  seeding. So a daemon settings file containing `email.imapHost`, a path the
  platform itself declares daemon-owned, made `resolvePath` throw "section
  'email' does not exist" and every `ConfigManager` built against that directory
  failed to construct: storing a value correctly made it impossible to read
  back. The overlay now creates the missing section, which cannot become a hole
  for arbitrary keys because it only ever yields paths on the declared
  daemon-owned list.

- **Config reads go through one guard.** `resolvePath` throws on an absent
  section and every connector path is app-layer, so on a machine where nobody
  ran setup the first read threw `Invalid config path` instead of reporting that
  nothing was connected.

- Mail addresses reach log fields as a digest and never as themselves.

- Two IMAP defects found while building on the module: literals were consumed by
  CHARACTER count while the socket decodes UTF-8, so any message with an
  accented character desynchronized the reader until it timed out (now counted
  in bytes); and mailbox names went through the credential quoter, which rejects
  8-bit characters, making every non-English folder name unusable (now encoded
  as RFC 3501 modified UTF-7).

- `email.draft.create`'s output no longer requires `uid` — it is the `APPENDUID`,
  which only a server advertising UIDPLUS returns, and inventing one for every
  other server produces a number a later fetch cannot resolve. It reports the
  Drafts mailbox it actually landed in instead.

- Errors from the mail composition translate into honest statuses rather than
  collapsing into a 500: not-enabled and not-configured are the operator's own
  unfinished setup and answer 400, a refused password answers 401.

- Layer 2 of the Google browser-flow test no longer launches a real Chromium
  behind an availability gate — it ran nothing on machines without a provisioned
  browser. It drives the adapter against a fake engine now and runs everywhere.

## [1.17.2] - 2026-07-27

### Fixed

- **1.17.1 asked consumers for something it did not hand out.**
  `RuntimePollerOwners.cancelHostedAgentRuns` shipped as a REQUIRED member, and
  the shared implementation it names — `cancelAllAgentRuns` — was reachable from
  no published subpath at all. Every fork that composes its own runtime graph
  (goodvibes-tui, goodvibes-agent) therefore had a contract it could satisfy
  only by re-writing the cancel loop by hand. It is now exported from
  `./platform/tools`, alongside the `AgentManager` those forks already import
  from there.

  Worth stating because it bears on the gate added in 1.17.1: the subpath
  surface check did NOT catch this, and could not. It records what a subpath
  exports, so it sees a required member being added and it sees an export being
  removed — but "a required member that nothing published can satisfy" is a
  different shape, and it took a consumer failing to compile to find it. There
  is now a test that builds the owners object the way a fork builds it, from the
  published barrel, so the contract cannot again demand what the package does
  not offer.

## [1.17.1] - 2026-07-27

### Fixed

- **A daemon that never bound a socket still left work running.**
  `DaemonServer.stop()` released only what `start()` had wired, so a daemon
  constructed and stopped without ever accepting a connection — a failed bind, a
  short-lived embed, a test — kept 78 constructor-owned pollers ticking.
  Construction-owned work is now released whether or not a socket was bound.

- **`PushService` had no `dispose()`.** Its escalation scheduler outlived the
  service.

- **The `ProjectIndex` built by `registerAllTools` was never released.** The
  orchestrator builds one per non-default agent working directory, each holding
  a debounced flush timer reachable only from the tool closures of a cached
  registry.

- **A close during initialization raced in the inbox cursor store.**

- **`RuntimePollerOwners` is all-required for a reason.** `homeGraphService` had
  a `dispose()` from the day it was written and simply was not named in the
  list, so its post-sync self-improvement pump — a rescheduling loop with as
  many as ten rounds — kept running after disposal.

### Changed

- **Graph disposal now cancels the agent runs the graph was hosting**, and
  reports how many. This is a deliberate behaviour change, not a leak fix: by
  `dispose()` time the fleet registry, orchestration engine, process registry
  and event bus are already gone, so an agent still described as "running" is
  orphaned rather than preserved — its provider call stays in flight and it
  sleeps out its retry backoff with nothing left to report to.

- **`RetryConfig` gained an optional `signal`**, threaded through ten provider
  call sites. Additive and optional — no consumer has to change — but it does
  touch a public type in a patch release, which is worth saying plainly.

  Equally worth saying: mutation testing showed this threading is NOT
  load-bearing for the test that motivated it. An aborted request fails
  non-retryably before it ever reaches the backoff, so the test passes with the
  signal removed. It is kept on its own merit — a caller that cancels should not
  wait out a sleep it no longer needs — and not as a fix for that failure.

### Internal

- **The published subpath surface is now gated.** `api:check` runs api-extractor
  over `index.d.ts` and `embed.d.ts` only, so everything reachable exclusively
  through a subpath export was invisible to it: `RuntimePollerOwners`,
  `PushService`, `RetryConfig`, `HttpListener`, `AgentOrchestrator` and
  `cancelAllAgentRuns` appear in NEITHER rollup. Consumer forks implement some
  of those contracts, so adding a required member to one is a breaking change
  that no gate in this repository caught — which is exactly what happened when
  `cancelHostedAgentRuns` went in, surfacing only because somebody checked by
  hand.

  `api:check` now also records every exported name across all 135 typed subpath
  exports, plus the required member names of every exported interface, and fails
  on drift with the consumer impact spelled out. What it does NOT capture, so
  nobody reads more into it than is there: parameter and return types, generics,
  member types, and optional members. A required member whose TYPE changes
  incompatibly still passes. The two rollups remain the authority for the root
  and embed entry points.

## [1.17.0] - 2026-07-27

### Added

- **LAN leader election, so one network runs one reader of your inbox.** When
  the same install runs on more than one machine, every copy independently
  polled the shared inbox and one message was answered twice. Nodes now elect
  exactly one consumer, PER SURFACE: a laptop can hold the work Slack account
  while a desktop holds the mailbox, and losing a machine moves only the
  surfaces it was reading. Off by default (`cluster.enabled`) — sharing inbound
  work is something you switch on.

  A surface's identity never reaches the network in the clear. It travels as a
  domain-separated digest, so what a neighbour can capture names no topic, chat
  or account. Slack and Discord are contested under the workspace the provider
  reports rather than a placeholder, because a placeholder would put two
  different workspaces into one election and starve whichever lost.

- **Group membership with real keys** (`platform/cluster`). Which machines are
  "us" is a roster you state, not whoever happens to be on the subnet. Every
  datagram is signed under a group key, rotation runs with a dual-generation
  acceptance window so a rotation does not look like a dead leader, and a
  removed machine stops being heard on the same tick. Group key material is
  daemon-owned and deliberately NOT replicated: a node without it is a node
  outside the group, and replicating it over the group bus would let anyone who
  can hear traffic gain membership.

- **A daemon secret tier** (`<daemonHome>/secrets.enc`). Daemon ownership of a
  credential is derived from daemon ownership of the config path that names it,
  so a secret cannot drift out of step with the setting it serves, and mail
  credentials follow a handover to whichever node takes over.

- **A runtime disposal seam** (`platform/runtime/disposal`). `RuntimeServices`
  now disposes, and `DaemonServer.stop()` calls it, so a daemon told to stop
  stops what it started instead of leaving timers and pollers running.

- **Config replication across the group**, fail-closed: a key replicates only
  if it is daemon-owned AND a replicated path names it, and a daemon-owned
  domain nobody has ruled on stays local.

### Changed

- **Updates catch up after downtime, and a bad one rolls itself back.** A
  daemon that was off while releases shipped now settles and checks on boot
  rather than waiting out a full interval, and repeated failed starts restore
  the kept previous version and hand over to it.

- **`agent_harness` catalogs disclose a shortened page.** A populated page used
  to carry no note, on the reasoning that it speaks for itself. "Showing 20 of
  300" read as a complete answer is the same failure as an empty page read as
  "no such capability", only slower.

### Fixed

- **A path the daemon owns is now stored somewhere.** `isDaemonOwnedConfigKey`
  consulted the schema keys and the daemon-owned prefixes but not
  `DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS`. That list previously held only paths
  that also matched a daemon prefix, so the gap was invisible — until this
  round added five credential paths with no such prefix. A key nobody claims is
  not stored twice, it is stored NOWHERE: setting `email.passwordRef` was
  accepted, returned a `goodvibes://` reference, wrote the secret, and
  persisted the reference to neither tier. The password was gone on next start.

- **A stale-lock takeover could hand out two holders.**
  `acquireCrossProcessLock` judged a lock stale, then built a staging file,
  wrote a payload, and renamed it over the lock path — without re-checking that
  the lock was still the file it had judged. The takeover ticket serializes
  takeovers against each other but not against the plain-create path, so a
  stale holder could release, another waiter's `open(…,'wx')` could land a
  fresh live lock, and the rename replaced it. The winner now re-checks the
  lock's inode identity immediately before the rename.

- **A machine refused re-entry to its group was told nobody answered.** A
  refused `REJOIN` got no reply at all, so the machine waited out its full
  admission timeout and reported that the group was unreachable — when the
  group had heard it and decided against it. There is now an explicit
  `REJOIN_REFUSE`, signed with the refuser's identity key, which a returning
  machine can verify against the roster it stored before it left. Only an
  AUTHENTICATED refusal is final; unverifiable replies are reported as such and
  never treated as proof, so nothing on the network can evict a machine by
  shouting at it.

- **The activity log keeps what it said it wrote.** A line logged immediately
  before an exit could be lost with the process. Every handover, rollback and
  orderly exit now flushes first, so an update that goes wrong no longer reads
  as a daemon that vanished mid-sentence.

- **`McpPermissionManager.registerServer` skipped the security refresh** when a
  server was re-registered, and the URL-encoding detector read ordinary format
  strings as obfuscation.

- **A surface rescued from a dead machine is not handed straight back to it**,
  and a surface that keeps being refused is retried less and less often.

### Internal

- The build no longer deletes the output tree before rebuilding it. For the
  length of a rebuild the compiled SDK did not exist, and a dev-linked consumer
  could resolve none of its imports — the mechanism behind a run of test
  failures that only appeared under concurrent load. Orphans are now swept
  after the build from tsc's own emitted-file list. The workspace lock also
  moved to the shared git directory, so worktrees of one checkout serialize
  instead of racing.

## [1.16.1] - 2026-07-26

### Fixed

- **A consumer could not pass `conversationGateConfig` to `SharedSessionBroker`
  at all.** `ConversationGateConfigReader.getCategory` was typed with the
  literal `'conversationGate'`, and `ConfigManager.getCategory` is generic over
  `keyof GoodVibesConfig` — a union `conversationGate` only joins through the
  module augmentation in `config/schema-domain-conversation-gate.ts`. Inside
  this package that augmentation is always loaded, so the SDK's own composition
  root compiled and the defect was invisible. A consumer's program loads only
  the declarations its own imports reach, so there a plain `ConfigManager` was
  rejected by the very interface written to accept it:

      Type '"conversationGate"' is not assignable to type 'keyof GoodVibesConfig'

  Which meant the one line that makes the daemon honor `conversationGate.mode`
  and `gatedSurfaces` on the live-agent handover path could not be written in
  `goodvibes-tui` or `goodvibes-agent` — the gate silently ran on defaults in
  both. The parameter is now `string`, so the contract depends on no
  augmentation, and `test/types/conversation-gate-config-reader.ts` pins the
  assignment from a consumer's vantage point by resolving through the package
  name rather than a relative path (which is the only vantage point from which
  the failure was visible).

## [1.16.0] - 2026-07-26

### Added

- **A work proposal is deliverable on every surface the conversation gate
  covers.** The gate answers an inbound channel message conversationally and,
  when the message reads as a work request, proposes the work over the channel
  it arrived on. Delivering that proposal went through a direct per-surface
  push implemented for Slack, Discord and ntfy only — so on Telegram, Google
  Chat, Signal, WhatsApp, telephony, iMessage, Microsoft Teams, BlueBubbles,
  Mattermost, Matrix and Home Assistant the proposal existed and could never
  be shown. The owner was asked nothing, saw nothing, and the work sat waiting
  for an answer to a question that was never posed.

  The notice now travels the same path a conversational reply already
  travels — the surface's channel plugin, its `renderEvent`, and the channel
  delivery router — so any surface the platform can talk to can carry a
  proposal. There is no second, gate-only delivery path to keep in sync. A
  channel that reports non-delivery and a transport that throws are both
  refusals, named in the log and in the returned outcome; neither is reported
  as a delivery. The direct per-surface push remains as the fallback for a
  surface with no registered plugin, and still throws by name for a surface it
  does not implement.

- `listDaemonOwnedConfigPaths()` and `DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS`
  from `platform/config`: the set of daemon-owned config paths including those
  that have no scalar schema entry. `listDaemonOwnedConfigKeys()` is unchanged
  and still returns schema keys only.

### Fixed

- **A live agent could take over an inbound channel message and skip the
  conversation gate.** The handover path (`continued-live`) reached the spawn
  boundary without the gate's configuration in hand, so on all sixteen surface
  adapters a message landing in an already-running session started work
  immediately regardless of `conversationGate.mode`. The gate config now
  travels with the intent through the shared session broker.

- **A surface notice that was never sent reported itself delivered.** Eleven
  surfaces had no notice implementation at all, and the send path read a clean
  return as proof of delivery. A proposal was marked deliverable and left
  answerable while nothing had been sent — so the owner's next message, about
  anything, was matchable against a proposal they had never seen. Unsent now
  refuses at error level, naming the surface, the binding and the reason, and
  the proposal is dropped rather than left answerable.

- **The shipped daemon discarded every log line it produced.** The daemon
  entrypoint never called `configureActivityLogger`, so the logger had no sink
  and `~/.goodvibes/logs/` stayed empty — every failure above was invisible on
  a real machine for exactly this reason. The logger sink is now established as
  a boot guarantee during facade construction rather than by each entrypoint
  remembering.

- **An enabled channel surface that could not start did so silently.** A
  surface configured on but unstartable now reports at error with the surface,
  the reason it cannot start, and the action that would fix it.

- **`conversationGate.gatedSurfaces` was stored where the daemon never read
  it.** The key is an array, so it has no scalar `CONFIG_SCHEMA` entry and was
  invisible to every walk of the daemon-owned set: `set` routed it to the
  daemon store by prefix, while the config migration never moved it, the
  daemon-tier overlay never read it back, and a whole-config save never
  stripped it from the surface file. A machine could hold the gate's mode in
  the daemon store with its surface list stranded in a client silo. All four
  paths now walk `listDaemonOwnedConfigPaths()`.

- **A completed migration marker no longer hides a key promoted later.** The
  marker records the ownership set it covered, and a grown set re-runs the
  migration once — which is what carries `conversationGate.*` across on
  machines that migrated before it was daemon-owned.

### Changed

- `conversationGate.*` is daemon-owned. The daemon is the process that receives
  inbound channel messages, so it is the process that decides whether one
  becomes a conversation or a workstream. Left client-owned, a `mode` set from
  the TUI or the agent reported success, landed in that client's settings file,
  and changed nothing about what an inbound message did. Existing values are
  moved into `~/.goodvibes/daemon/settings.json` by the migration, which
  discloses every value it moved and every duplicate it discarded.

### Migration

No action required. Daemon-owned `conversationGate.*` values are relocated on
first start and the move is disclosed in the migration record next to the
daemon store. Consumers constructing `SharedSessionBroker` directly should pass
`conversationGateConfig` (their `ConfigManager`) so the gate's configuration is
honored on the live-agent handover path; without it the gate falls back to its
defaults.

## [1.15.0] - 2026-07-26

### Added

- **Triggers: watch something, and act when it changes.** `platform/triggers`
  adds three shapes over one supervision spine. An on-exit trigger watches a
  long-running command and runs the follow-up work when it finishes, with the
  command's exit status, signal and output tail carried into that work. A
  stream trigger watches a running command's output as it is produced and acts
  on the first line that matches, batching by line count and interval so a
  chatty process cannot flood a turn. A condition trigger runs a cheap check on
  a schedule with no model in the loop at all, keeps a small ring of past
  observations, and starts work only when the answer actually changes rather
  than on every poll.

  Everything a trigger runs is registered up front and pinned by digest, and
  on-exit commands are spawned from argv with no shell in between, so nothing
  in a watched command's output can become part of what runs next. Failing
  probes back off along a ladder and a repeatedly failing trigger is broken
  open with a stated reason instead of retrying forever.

  Off by default: `watchers.triggers.enabled` ships `false`, and nothing
  watches anything until it is turned on. Nineteen `watchers.triggers.*` keys
  configure supervision, batching, history retention and the failure ladder.

- **A paired phone is now a set of agent capabilities.** `platform/devices`
  defines the contract: either camera, the phone's screen, its location, its
  clipboard, and a small set of device commands (notification, link, buzz),
  carried over the existing peer transport as a new `device.capability` work
  type. It is a native contract, not an MCP server, and it is node-kind
  neutral by construction — a node announces which capability ids it
  implements, and nothing in the catalog branches on what KIND of node it is,
  so a native app node pairs and serves through the same code path as the web
  app node shipping first.

  Every capture and every effect asks the person before it runs. Choosing
  "always allow" on that prompt writes ONE durable grant for that one
  capability on that one phone — offered on every capability, front camera,
  screen capture, precise location and clipboard read included — listed and
  revocable through `devices.grants.list` / `devices.grants.revoke`. A revoked
  grant is deleted rather than flagged, and grants are re-read from disk on
  every request, so revoking one takes effect on the very next request from
  any surface.

  Both persisted stores do real recovery-time housekeeping: grants carry an
  age TTL and per-node/total count caps and are reaped when their node is gone
  or their record fails content validation; captures are kept 24 hours by
  default and are validated by re-hashing their bytes, so a torn or truncated
  file is reaped instead of served. Sweeps run at recovery AND on an interval,
  and every sweep writes an itemised disclosure of what it removed and why
  (`devices.housekeeping.run` returns the same report).

  Configured through the twelve `device.*` keys, each a shaped choice with a
  written purpose rather than an on/off toggle: `device.capabilities.mode`,
  `device.capabilities.allowAlwaysOffer`, `device.location.precision`,
  `device.clipboard.readMode`, `device.capture.retentionHours`, and the grant
  and node bounds.

- **Wake-word detection has platform support — and says plainly that it does
  not run yet.** `platform/voice/wake` carries the whole surface-independent
  half: the audio front end computed in code rather than downloaded, the
  buffering the published classifier was trained against, the patience and
  cooldown rules, checksum-pinned provisioning with its own recovery
  housekeeping, and a supervisor that latches off with a written reason after
  repeated crashes instead of restarting forever. The same engine runs in a
  daemon child process and in a browser tab, because it takes an inference
  session from its host rather than importing a runtime.

  Audio capture is deliberately not here — it is genuinely per-surface — and no
  surface supplies it yet. So `voice.wake.enabled` is off by default and its
  own description opens by saying that turning it on does nothing in this
  build, the setting is remembered for the release that adds capture, and the
  feature reports itself unavailable rather than pretending to listen. The
  classifier it will use shipped in 1.14.0. Twenty-five `voice.wake.*` keys
  configure models, thresholds, capture, restart policy and per-surface
  enablement.

- **A setting is now stored by the runtime that acts on it.** Every product used
  to write every key into its own file (`~/.goodvibes/agent/settings.json`,
  `~/.goodvibes/tui/settings.json`, …), but the daemon reads exactly one of
  them — so a Telegram bot username set from the agent reported success, landed
  in the agent's file, and configured nothing, because Telegram runs in the
  daemon. Keys now carry an owner. Anything the daemon executes unattended
  (chat surfaces, control-plane binding, watchers and triggers, device pairing
  and grants, local voice provisioning, delivery, at-rest retention) has one
  home in the daemon tier no matter which client edits it. Presentation and
  per-installation lifecycle stay local to each client, and that is the default,
  so adding a schema key never silently relocates an existing value. Setting a
  key reports back where it was actually persisted, which tier that is, and
  whether the daemon owns it, so a client can no longer claim success for a
  write that changed nothing.

- **Push registration refuses a subscription that could never receive a push.**
  Registration and delivery now judge endpoints and key material with one shared
  set of rules and one shared set of words. Previously registration only checked
  that the strings were non-empty while delivery checked the actual byte
  lengths, so a malformed key was accepted with a 200 and surfaced weeks later
  as a delivery failure; it is refused at the moment it is offered, with the
  reason, and never written to disk. Housekeeping removes only provably-dead
  records — a 404 or 410, repeated hard refusals, unusable key material, a torn
  record — and age alone expires nothing, so a device that still works is never
  reaped. The VAPID contact address is held to the same rule by the config gate
  and the signer, rather than an invalid one being signed into every message the
  daemon sends.

### Fixed

- **A conversation that had already written to you could get no reply.** Every
  channel surface built its reply directory only from optional configuration —
  a default chat id, a bot username, and their per-surface equivalents — so on
  an install where those were left blank the directory was empty, and an
  incoming message from a real conversation had no target to answer on. The
  directory is now built from the route bindings each adapter already writes on
  ingress, so any conversation that has ever sent a message is answerable with
  no configuration at all. The optional fields keep their real job: starting a
  conversation somewhere nobody has written from. One rule, applied identically
  across all fourteen surfaces.

- **`bg_output` returns output while a process is still running.** Background
  process output is collected as it is produced rather than assembled at exit,
  so asking a long-running process what it has printed so far now answers with
  what it has printed so far instead of nothing until it finishes.

- **A background command that timed out is now reported as finished even when
  it left a child behind.** A process's output pipe is inherited by everything
  it starts, so it signals end-of-output only when the last holder closes it. A
  timeout kill reaches the command itself, not the descendants it spawned — so
  for any command that left one running, the pipe stayed open and the process
  was never reported as done at all: `bg_status` showed it still running
  indefinitely and an on-exit trigger never fired. Whether a given command hit
  this depended on something as incidental as which `/bin/sh` the machine has,
  since some shells replace themselves with a single command and leave nothing
  behind. Completion now follows the process exiting. Output already written is
  still collected, and output that only a survivor is still producing no longer
  holds the result open.

- **A model's thinking no longer arrives as part of its answer.** An
  OpenAI-compatible endpoint's reasoning format describes which parameter it
  accepts on the REQUEST; it was also being applied to the RESPONSE, so an
  endpoint registered as taking no reasoning parameter had any returned
  reasoning folded into ordinary content. Cerebras returns reasoning on exactly
  that field, so its thinking became answer text — interleaved with the answer
  and past every visibility setting meant to control it. Reasoning returned on
  its own field is now carried on the reasoning channel, and reasoning wrapped
  in a tag inside the content stream is split out incrementally, so a tag that
  spans two chunks is not missed and no partial tag is shown. The split can
  never empty a reply: a model that writes nothing outside its reasoning still
  yields an answer.

- **A spent account is reported as a billing problem instead of retried as a
  rate limit.** Providers report an exhausted balance with wording, and often a
  status code, that the rate-limit path keyed off — so a condition that never
  clears by waiting was announced as "rate limited, retrying in 60s" three times
  over before failing. Both the retry decision and the error classifier now read
  the message, so an exhausted balance is reported once, in its own category,
  with guidance about credit rather than a countdown.

## [1.14.0] - 2026-07-25

### Added

- **The `hey goodvibes` wake-word classifier is published and pinned.** The
  model is hosted at the same append-only release tag as the voice engine
  bundles, in both onnx and TensorFlow Lite form, each with a checksum sidecar
  and a required attribution NOTICE. `WAKE_WORD_MODELS` pins the URL, byte size
  and sha256 of every artifact, and adopting a newer model is a one-line pin
  change rather than re-plumbing — an accent-diverse retrain is expected to
  replace this one.

  The manifest records a recommended detection threshold of **0.9**, not
  openWakeWord's shipped default of 0.5, which is too low for this phrase. It
  also records, as data rather than a footnote, that the recall figures come
  from synthetic speech: no human recording of the phrase exists yet, so
  recall has no real microphones behind it. The false-accept figures are
  measured on 81 hours of real human speech.

  This is the artifact, its pin, and its attribution only — the wake-word
  engine, config surface, provisioning flow and UI are not built yet. See
  `docs/wake-word-model.md`.

### Changed

- **A message from a channel no longer starts a workstream on its own.** An
  inbound message from ntfy, Telegram, Slack, or Home Assistant used to spawn an
  agent run directly. It now gets a conversational reply, and when the agent
  judges that the message warrants actual work it PROPOSES that work and waits
  for you to agree. The confirmation is answered on whatever channel the
  proposal arrived on, so a proposal made over Telegram is accepted over
  Telegram.

  Work you already authorized is unaffected and never re-asks: schedules,
  triggers, on-exit chains, generic webhooks, and a proposal you just agreed to
  were all authorized when they were set up. The terminal app is unchanged —
  you are sitting in front of it and typed the thing, so work starting is the
  expected outcome.

  The behavior is configurable. `propose` is the default described above;
  `confirm-all` asks before every agent run, including messages that read as
  pure chat, for a noisy or shared channel; `off` restores the previous
  behavior where an inbound message starts work immediately.

  Pending proposals are bounded, expire on their own, are validated when
  reloaded, and report what they dropped and why, so a proposal that vanished
  is never a mystery.

### Fixed

- **Notifications send what is new instead of the whole log.** A progress
  notification used to re-send the entire accumulated event log every time, so
  each update was longer than the last and mostly a repeat of it. Delivery now
  tracks which events have already been published and sends only the ones that
  have not, and an identical repeated message is suppressed rather than sent
  twice.
- **One inbound message can no longer start two agents.** The same message could
  reach the adapter over both a long-lived subscription and the webhook route,
  and each delivery ran the whole pipeline. Inbound messages are now
  de-duplicated across ingress paths by message id, with a bounded, expiring
  cache shared by every route.
- **The release pack gate works on npm 11 and newer.** `npm pack --json` used to
  emit an array of pack results and now emits an object keyed by package name.
  The gate read the first array element, so on a newer npm it got `undefined`
  and failed with an opaque error about a missing filename. It now accepts the
  array, bare-object and name-keyed shapes, and ignores `npm notice` chatter
  printed onto stdout by version-manager shims. CI pins node 22 and was never
  affected; a contributor on a newer npm was.
- **Notification links point somewhere reachable.** When the control plane is
  configured to bind every interface, a notification's click target could carry
  the wildcard bind address verbatim, so tapping it on a phone went nowhere.
  The link now carries the machine's own routable address on the network, and
  when there is no such address to use, the link is omitted rather than
  shipped broken. A loopback address is left alone — it is the shipped default
  and is correct for a notification clicked on the host itself.

## [1.13.1] - 2026-07-25

### Fixed

- **The append-only retention scheduler is reachable.** `RuntimeServices`
  requires an `appendOnlyRetentionScheduler`, but `AppendOnlyRetentionScheduler`
  and its options type were not exported from any public entry point in 1.13.0.
  A host that composes its own `RuntimeServices` — rather than taking the one
  `createRuntimeServices` builds — could not satisfy the interface at all, and
  so could not run the periodic sweep that release introduced. The class,
  `AppendOnlyRetentionSchedulerOptions` and `APPEND_ONLY_SWEEP_INTERVAL_MS` are
  now exported from the retention barrel, which means they arrive with the rest
  of `operations` from `@pellux/goodvibes-sdk/platform/runtime`.

## [1.13.0] - 2026-07-25

### Added

- **Telegram inbound.** The Telegram adapter now receives messages instead of
  only sending them. Polling mode keeps a persisted cursor, so a restart
  resumes from the last update it handled rather than replaying or skipping.
  Webhook mode registers and serves an endpoint instead. The two modes are
  mutually exclusive by construction — configuring both is rejected rather
  than silently running one of them. `/start`, `/help` and `/stop` are handled
  as commands rather than forwarded into the conversation as chat text.
- **Per-model reasoning effort.** Effort is now two distinct values: the level
  held in configuration (what the operator asked for) and the effective level
  the current model can actually deliver. The effective level carries
  provenance, so a caller can tell whether it reflects the request or a model
  ceiling.
- **Persisted-state housekeeping.** Session and orchestration stores expose a
  recovery-time housekeeping pass that reaps stale records, bounds growth, and
  reports what it removed rather than silently discarding it.

### Changed

- **Reasoning effort no longer ratchets down permanently.** Selecting a model
  that cannot honor the configured effort level no longer rewrites
  configuration. The configured level is preserved and restored as soon as a
  capable model is selected again. Previously a single low-capability model
  permanently lowered the level for every later session.
- **Persisted-state validation checks content, not existence.** Recovery
  decisions are made from the record's actual contents; a present-but-unusable
  file is no longer treated as valid state.

### Fixed

- **Telegram bot tokens resolve secret references.** A token configured as a
  secret reference is now resolved before the API call. Previously the literal
  reference string was sent to Telegram, so every request failed to
  authenticate.
- **Config writes during watcher startup are no longer lost.** A configuration
  file change that landed in the window while the watcher was still starting
  up was dropped. The change is now picked up.
- **A torn migration marker no longer strands legacy session data.** An
  interrupted migration left a marker that made the migration look complete
  while the legacy data was still unmigrated, hiding those sessions. The
  marker is now written so that an interruption leaves the migration
  resumable.

## [1.12.1] - 2026-07-24

### Fixed

- **Recovery offers respect live writers.** A snapshot whose file was written
  within the last 90 seconds is being actively maintained by a running
  process — including one on an older build or another product — and is no
  longer offered as an orphaned crash at boot. The explicit per-session probe
  (`checkRecoveryForSession`) still answers honestly about live sessions.
- **Snapshot retirement is exact.** `consumeRecovery` and `removeRecoveryPoint`
  retire precisely the snapshot that was offered or loaded, in whichever
  directory it lives (scoped or legacy shared), and never bulk-clear a
  directory.

## [1.12.0] - 2026-07-24

### Added

- **Declare-once product storage surfaces.** `createSessionSurface({ surfaceRoot,
  workingDirectory, homeDirectory })` returns a `SessionSurface` from which
  session stores, the last-session pointer, recovery snapshots, retention
  sweep roots, KV state, and workspace checkpoint locations all derive.
  Session-persistence functions, `SessionManager`, `WorkspaceCheckpointManager`,
  and the integration helpers accept `{ surface }`; the loose per-call scope
  options keep working with a one-time deprecation warning, and mixing the two
  forms is a compile error. A marker-guarded one-time migration copies the
  legacy pointer forward, relocates flat agent journals, and adopts a legacy
  checkpoint store with an on-disk disclosure marker.
- **Ask-then-retire recovery lifecycle.** `consumeRecovery` (load-then-delete of
  exactly the identified snapshot), `removeRecoveryPoint` (user-driven discard),
  and `checkRecoveryForSession` (does a named session hold unsaved crash data
  newer than its store). Offers now use per-session supersession — a snapshot is
  live while newer than its own session's durable store — so unrelated session
  activity can no longer bury crash data; the global pointer mtime is no longer
  consulted.
- **Cross-process checkpoint lock.** Workspace checkpoint git operations are
  serialized across processes: populated-create via hardlink (no zero-byte
  publish window), mtime refresh while held, ticket-serialized stale takeover
  by atomic rename, ownership-verified release, and same-process FIFO queueing.
  Validated by an eight-process contention harness (zero overlaps across
  6,400+ critical sections).

### Fixed

- **User-saved sessions never expire.** `SessionMeta.saveSource` ('user' | 'auto',
  sticky once 'user') exempts explicitly saved conversations from retention;
  files without the field are treated as user-saved. The agent-journal sweep is
  content-verified so a conversation whose name merely looks like a journal can
  never be swept or relocated.
- **Retention sweeps the directories that are actually written**: recovery
  snapshots (workspace-scoped), agent journals under sessions/agents/, and the
  dead legacy event store; every reclaim logs a disclosure line.
- **KV state** gains a surface scope with dual-read of the legacy directory and
  tolerance for corrupt legacy files (treated as absent, logged once).

## [1.11.4] - 2026-07-17

### Fixed

- **Secrets store key-mismatch class closed.** Keyfile generation is exclusive
  (a process losing the creation race adopts the winner's key instead of
  caching a private one); every store write revalidates the cached key against
  the keyfile and refuses to encrypt on mismatch (restoring a missing keyfile
  from the cached key); and store envelopes now record the writing key's
  fingerprint, so a mismatched store reads back as "written with key X,
  current keyfile is Y" instead of a bare authentication failure. Additive and
  backward compatible: stores without the fingerprint decrypt exactly as
  before and the store format version is unchanged.

## [1.11.3] - 2026-07-17

### Fixed

- **Missing hooks file no longer logs an error.** `HookDispatcher.loadFromFile`
  skips cleanly (debug log) when the hooks file does not exist. An absent
  `hooks.json` is the normal state for most installs and previously produced a
  WARN (permission probe) + ERROR (read failure) pair on every startup.
- **Error summaries keep redaction tokens.** The error-summary JSON stripper no
  longer eats `[REDACTED*]` placeholders, which turned redacted paths like
  `/home/[REDACTED]/hooks.json` into the misleading `/home/ /hooks.json` in logs.
- **`publish-package` resolves tarball paths to absolute.** npm parses a bare
  relative `dir/pkg.tgz` as a GitHub owner/repo spec; caller-supplied relative
  paths are now resolved before they reach the npm argv (closes the hardening
  item deferred from 1.11.2).

### Added

- **`COMPACTION_HANDOFF_HEADER` export (platform/core).** The mandatory first
  line of every compaction-continuation message is now exported so transcript
  renderers can recognize the compactor-authored user message and fold it
  instead of re-printing the full re-injected instruction wall after every
  automatic compaction.

## [1.11.2] - 2026-07-17

### Added

- **The SDK now carries the toolchain.** `@pellux/goodvibes-sdk` declares
  `@pellux/goodvibes-toolchain` as a runtime dependency, so installing the SDK
  installs the shared CI/CD toolchain as well. Consumer repos can drop their
  separate toolchain pin and rely on the one the SDK brings.
- **Zero-touch releases (auto-tag on green).** CI gains a final `auto-release`
  job that runs only after every gating job is green on a push to `main`. When
  the release commit's version has no tag yet, it creates the annotated
  `v<version>` tag at that commit and dispatches the release workflow at the tag
  ref with `mode=release` — no human step between a merged release commit and a
  published release. A tag that already exists is a logged no-op, and the manual
  tag-push path is unchanged for redos. The release workflow gains a `mode`
  input (`dry-run` | `release`, default `dry-run`); every job previously gated to
  a tag push now also runs for a `mode=release` dispatch, while the dry-run job
  is fenced to a non-release dispatch so it can never publish.
- **`reusable-npm-publish.yml` gains a prebuilt-tarball publish mode.** A new
  optional `tarball-artifact` input downloads a packed `.tgz` into
  `./release-tarball/` before publishing, for repos whose npm bytes come from a
  separate pack job. With no `tarball-artifact` the default pack-and-publish-cwd
  behavior is byte-identical.

### Fixed

- **`publish-package` can publish a prebuilt tarball (`--tarball <path>`).** When
  set, the tool publishes the given `.tgz` (`npm publish <path>`) instead of
  packing the current directory, while keeping the already-published skip, the
  propagation poll, and a dry-run that verifies the staged tarball is present.
  A missing or non-`.tgz` path is rejected up front (exit 2) so a broken
  pack→publish handoff fails loudly. This is the fix for consumers — such as the
  agent, which bundles a runtime before packing — whose published bytes are
  produced by a pack job rather than a bare checkout, so the publish must ship
  the staged artifact.

## [1.11.1] - 2026-07-17

### Fixed

- **`@pellux/goodvibes-toolchain` gains a dispatcher bin named after the
  package (`goodvibes-toolchain`).** `bunx @pellux/goodvibes-toolchain <tool>`
  resolves the bin whose name matches the package's final path segment; with
  only the eleven `goodvibes-*` tool bins exposed, bunx silently fell back to
  the FIRST bin in the map (sdk-pin-gate) and ran it with the intended tool
  name as a stray argument — crashing release-verify in checkout-less
  workspaces and, worse, capable of "passing" while running the wrong tool
  where a toolchain config exists. The dispatcher accepts bare
  (`per-job-green`) and prefixed (`goodvibes-per-job-green`) tool names, so
  every existing invocation string now reaches the intended tool; all eleven
  direct bins are unchanged, and the dispatcher sits first in the bin map so a
  first-bin fallback also lands on it.

## [1.11.0] - 2026-07-16

### Added

- **`@pellux/goodvibes-toolchain` — a shared CI/CD toolchain package (the 11th
  workspace package).** The release, publish, and verification scripts that
  previously lived as 2–3 parallel copies across the GoodVibes repos now have one
  published home. Each tool — `sdk-pin-gate`, `build-binaries`, `release-cut`,
  `coverage-gate`, `verification-ledger`, `post-build-smoke`,
  `package-install-check`, `publish-package`, `per-job-green`, `changelog-gate`,
  `sha256sums` — ships as a policy function with injectable I/O plus a thin CLI
  (`bin`) entry. Repo-specific values are supplied by a documented
  `toolchain.config.json` contract (see `docs/release-and-publishing.md`);
  behavior lives in the package. Consumers dev-depend on it.
- **Reusable GitHub workflows (`workflow_call`), hosted here and consumed
  cross-repo.** `reusable-release-verify.yml` verifies a commit's push-CI run is
  per-job green by reference (the toolchain `per-job-green` tool, with a
  503-resilient check-suites fallback) and emits the run id + head SHA;
  `reusable-npm-publish.yml` (provenance + propagation poll),
  `reusable-gh-release.yml` (changelog excerpt + `SHA256SUMS`), and
  `reusable-binary-matrix.yml` (build-binaries + post-build-smoke) round out the
  set. The composite setup action gains a single-source `bun-version` input.

### Changed

- **CI builds once; the platform matrix and eval gate restore that artifact.**
  `ci.yml` no longer rebuilds the workspace inside each matrix leg and the eval
  gate — they restore the single `build` job's `workspace-build-output`. Gate
  coverage is unchanged.
- **The SDK release is now by reference.** `release.yml` replaces the
  ~45-minute `validate-release` re-run with `reusable-release-verify` plus an
  artifact-integrity handoff: `publish-npm` restores the CI build for the
  recorded run id and asserts its head SHA equals the tagged SHA before
  publishing. `verify-tag-version`, the SBOM release, provenance publish,
  empty-or-complete verification, the propagation poll, and the GitHub release
  are all preserved.

## [1.10.1] - 2026-07-16

### Added

- **A stable public name for the full runtime-services interface.** Apps that
  compose their own runtime services (rather than letting the SDK build them)
  need to name the complete runtime-services type. The previous release narrowed
  the foundation-clients options to a small slice of that interface, which
  removed the only public name for the whole thing and forced consumers to
  re-derive it from the position of an argument in a function signature — a
  fragile anchor. The full interface is now exported by name as `RuntimeServices`
  from the runtime bootstrap surface (`@pellux/goodvibes-sdk/platform/runtime`,
  the `bootstrap` namespace), alongside the existing narrow
  `RuntimeFoundationServicesSlice`.
- **The managed local-voice setup service is now importable on its own.** The
  daemon composes its local-voice install-and-status service from a single
  factory, but that factory had no import path of its own, so an app composing
  its own runtime had to rebuild it from lower-level pieces. It is now published
  at `@pellux/goodvibes-sdk/platform/runtime/voice-setup` (`createVoiceSetupService`),
  so a consumer constructs the exact same service the daemon does — with its
  provisioner and status-read seams injected — instead of duplicating the wiring.

## [1.10.0] - 2026-07-16

### Added

- **Local voice now installs itself in one act, with a default voice and speech
  engine — nothing downloads until you ask.** A new managed setup downloads and
  checksum-verifies the piper text-to-speech engine and a good default voice
  into a goodvibes-managed folder, then points the local-voice settings at them
  so speech works immediately, without any manual path configuration. It never
  overwrites a setting you already customized, it is resumable (re-running skips
  anything already installed and verified), and every state is honest: a
  size-labeled offer before you start, a clear message on a failed or
  checksum-mismatched download (which keeps nothing), and an honest
  "not available on this platform" where no verified build exists. Local
  speech-to-text is managed too: whisper.cpp ships no official prebuilt binary,
  so goodvibes builds it reproducibly (static, portable, smoke-verified) and
  pins the exact artifact per platform; setup installs it with the same
  checksum-verified, atomic discipline along with a default recognition model,
  and points the local-voice settings at both. Where the pinned bundle is not
  yet hosted, setup says so honestly and accepts the identical artifact placed
  locally (it must match the pin byte-for-byte). Installs are version-aware:
  when a newer pinned engine ships, re-running setup replaces the old binary
  atomically instead of silently keeping it, and the engine's failure state is
  cleared so the fresh install is retried immediately. Two reads/actions expose
  it: `voice.local.status` and `voice.local.install`.
- **The daemon now watches its own memory and defends against runaway growth.**
  A memory governor samples the daemon's memory use on an interval and, as it
  approaches a budget, sheds memory in stages: trim caches and run garbage
  collection, then flush caches and pause deferrable background work (knowledge
  self-improvement, memory consolidation, and code-index reindex all honor the
  pause), then refuse new expensive work with an honest message. If memory keeps
  climbing after a full flush — a genuine leak — it writes a diagnostic receipt
  and exits cleanly so a supervisor restarts it fresh, instead of being killed
  at the edge of running the machine out of memory. Every cache the daemon keeps
  is registered so the governor can see and shrink it, and a new `ops.memory`
  read serves the live state (tier, budget, memory use, per-cache footprints,
  paused jobs, tripwire status). New settings, with their defaults:
  `memory.budgetMb` (default `0` = auto: the smaller of 25% of system RAM or
  4096 MB), `memory.tier.elevatedPct` (`60`), `memory.tier.highPct` (`80`),
  `memory.tier.criticalPct` (`95`), `memory.tripwire.rateMbPerSec` (`25`), and
  `memory.tripwire.sustainSec` (`60`).
- **Local speech-to-text is now available out of the box on Linux x86_64.** The
  goodvibes-built whisper.cpp bundle is hosted, so `voice.local.install`
  downloads, checksum-verifies, and installs the speech engine and its default
  model with no manual build — verified end to end (download, verify, extract,
  transcribe). Voice engine bundles live at a single append-only release tag
  with a checksum sidecar per asset; other platforms report "unsupported"
  honestly until their bundle is published there. A new setting,
  `memory.hardLimitPct` (default `90`), adds an absolute-memory backstop
  anchored to the machine's real kill line — the daemon's own service/container
  memory limit where one applies, else physical RAM.
- **Voice install progress is visible while it runs.** `voice.local.install` is
  a plain request/response call, so surfaces could only show a spinner during
  the ~209MB download. `voice.local.status` now carries an `installInProgress`
  section while — and only while — an install is running: per-component progress
  (name, phase: download/verify/extract, byte sizes where known), fed by the
  installer's own progress events. Surfaces simply poll status during an
  install to render real progress; a second concurrent install call still joins
  the one in-flight run. No new streaming machinery. (Note for surface authors:
  labeling the STT `bundle-unavailable` state as "not yet published" is an
  accurate reading — the wire enum name is unchanged.)
- **Product-generated macOS launchd service files now carry a provenance key.**
  Because launchd has no description field, a `GoodVibesManagedBy` entry (a
  stable marker plus the service description) is written into every plist
  goodvibes generates, so a managed service file is identifiable as ours.

### Fixed

- **Concurrent daemon calls over the local network are now capped and can never
  pin memory without bound.** The socket path surfaces use to invoke daemon
  methods refused nothing before: a burst of calls retained one
  credential-carrying request context each without limit, and a call that hit a
  live event-stream endpoint buffered its endless response forever. Calls are
  now capped in flight for their FULL lifetime including response reading
  (beyond the cap they get an honest "busy, retry shortly" answer), responses
  are size-bounded, event-stream endpoints refuse the call shape with a clear
  message and tear down cleanly, and events to a stalled client are dropped
  (counted) instead of growing the socket buffer without bound. The failed-call
  retry path also genuinely releases the failed request during the token-refresh
  window now.
- **The daemon's memory self-defense acts instead of just observing.** Cache
  registrations reclaim real memory when trimmed (knowledge run history,
  session relay buckets, the event replay buffer), the "refuse expensive work
  under critical pressure" promise is enforced at the expensive entry points
  (knowledge runs, ingestion, reindex, consolidation, code indexing) with clear
  refusal reasons, the leak-detector exit flushes state and writes its
  diagnostic receipt even on a fresh install, the memory budget respects
  container/service memory limits, misordered pressure thresholds are rejected
  at startup with a clear error, the leak detector measures recent growth (so a
  slow-starting leak on a long-running daemon is still caught quickly), and a
  pause takes effect immediately - queued and in-flight background work stops
  at the next safe point instead of running through the pressure.
- **Background knowledge work can no longer stampede.** Every trigger routes
  through one governed scheduler: a burst across many distinct files collapses
  into a single sweep instead of hundreds of parallel runs, a repair request
  arriving during the quiet-period backoff with concrete evidence runs instead
  of being silently dropped (and merged requests keep their targets), the
  per-run history is bounded on disk and in memory, and full-store scans are
  single-pass with breathing room for other work.
- **A control-plane relay leak that could grow the daemon's memory without
  bound.** Requests tunneled to the daemon over the relay — each carrying its
  authorization header — and the secure channels behind them are now capped and
  released after delivery: too many open channels evict the coldest one, and a
  backlog of in-flight requests is refused with an honest "overloaded" response
  instead of piling up in memory. The 401 auto-refresh retry path also releases
  the failed request promptly so a burst of retries can't pin memory.
- **A background knowledge-improvement task that could spin in a tight loop.**
  After a burst of edits triggered knowledge enrichment, the follow-up
  self-improvement work could reschedule itself immediately over and over. It
  now waits a real minimum delay, collapses a burst of triggers into a single
  pending run, and — when a run finds nothing left to improve — stops
  rescheduling and falls back to the normal hourly pass. A single run also no
  longer loads the entire knowledge store into memory at once; it reads in
  bounded pages.
- **Interrupted voice-model downloads are no longer used.** A voice model
  (piper/kokoro `.onnx`) is now downloaded to a temporary file and only moved
  into place after its size and file signature check out, so a download cut
  short can never leave a truncated model that the speech engine would choke on.
  A failed download is cleaned up and reported honestly.
- **The local text-to-speech engine fails honestly instead of crash-looping.**
  When the installed piper/onnxruntime can't load a voice model on this host
  (for example, the model is newer than the engine supports), the provider now
  detects the hard failure on the first attempt and reports one clear,
  actionable "engine unavailable" state — what failed and what to check —
  instead of re-invoking the engine for every chunk and producing a storm of
  crashes. Reconfiguring the engine or model clears the state and retries.
- **The memory self-defense now also catches a SLOW leak and a service memory
  cap.** A leak too gradual to trip the growth-rate detector would previously
  ride all the way to a kernel out-of-memory kill with no receipt; an
  absolute-memory backstop now writes a diagnostic receipt and exits cleanly
  just before the machine's real kill line — 90% of the daemon's own
  service/container memory limit where one applies, else 90% of physical RAM
  (`memory.hardLimitPct`, default `90`). The backstop is deliberately anchored
  to that kill line and not to the (intentionally small) memory budget: a
  daemon with a large but stable, healthy working set above the budget on a
  big-memory host stays alive at the critical tier — refusing new expensive
  work — rather than being restarted in a loop while most of the machine's
  memory sits free. The budget also now honors a systemd `MemoryMax=` limit set
  on the daemon's own service unit (not just a container's), and the leak-exit's
  state snapshots run without being able to block the exit on a stalled disk.
- **Local speech-to-text updates apply honestly and never freeze behind a false
  version stamp.** A locally-provided engine archive is now verified against the
  pinned checksum BEFORE it is unpacked, so a stale or mismatched archive is
  never installed and then recorded as the new version; a mismatched archive is
  reported explicitly. A re-install whose speech-to-text half fails now keeps the
  recorded engine/model versions instead of erasing them, so a later correct
  update still applies. The default recognition model is pinned to an immutable
  source revision, so an upstream change can't break fresh installs.
- **A local web surface announcement no longer misstates its reach.** When the
  web host mode is an unrecognized or oddly-cased value, the daemon serves
  loopback-only under a safe default; the startup announcement now says the value
  was unrecognized and the surface serves this machine only, instead of printing
  a bare address that could read as a live network binding.

## [1.9.0] - 2026-07-14

### Added

- **The fix phase runs as a planned task graph.** A failing review no longer
  hands one fixer a prompt: findings parse into typed tasks with dependency
  edges feeding the one workstream engine, parallel where files allow, each
  task adversarially re-reviewed, and the merged result re-tested against the
  original ask. Surfaces render the graph via `fleet.graph.get` (nodes, edges,
  and the elastic-pool state), and an elastic pool spawns an agent for a ready
  task when none is free — all under the one fleet ceiling.
- **The fleet observes externally-launched coding agents on the host.**
  Claude Code / Codex sessions the daemon did not spawn or host are found by
  read-only process-table detection and listed as `observed-external` rows
  carrying an honest external kind, pid, working directory, start time, and
  CPU-based liveness (active/quiet, never claiming quiet is proof of idle).
  They are observed, not owned: they never count against `fleet.maxSize`, and
  stop is never offered. Steering rides whatever channel the foreign session
  genuinely exposes — a tmux pane, via send-keys — as a drill-in capability
  (`fleet.observed.steer`); where no channel exists the row says so instead of
  offering a dead action. Detection is opt-in at the daemon and degrades to a
  quiet empty set.
- **Third-party coding agents run as hosted daemon sessions.** Claude Code,
  Codex, and opencode connect over the Agent Client Protocol and appear as
  first-class fleet rows: steerable (the next prompt), stoppable, and their
  permission asks route through the shared approval machinery like any native
  ask.
- **Sleep ownership.** While real work runs the daemon holds an idle+sleep
  inhibitor (named holds, honest "held because X" state, a hard time cap so a
  wedged hold cannot pin the host forever); on the sleep edge it checkpoints,
  and on wake it re-arms timers and delivers missed receipts. The owner
  keep-awake toggle survives surface closes, states the lid-switch split
  honestly where the OS refuses that class, and applies live on a config
  change.
- **Local voice engines.** whisper.cpp / faster-whisper STT and piper / kokoro
  TTS run as free local peers beside the premium provider route, selected by
  the `voice.local.*` settings.
- **Per-tool cancel and editable queued messages.** A single in-flight tool
  call can be cancelled without killing the turn (`sessions.toolCalls.cancel`),
  and messages queued mid-turn can be listed, edited, and deleted before the
  model sees them (`sessions.queuedMessages.*`).
- **Memory consolidation actually runs.** The daemon (the memory store's
  single writer) drives the consolidation pass at idle with a slow scheduled
  fallback: reversible merges and never-referenced decay just happen with
  retained receipts; judgment outcomes (contradictions, cross-scope
  duplicates) become review-queue entries a human resolves — and the receipts
  plus pending proposals are served over `memory.consolidation.receipts`.
- **CI watches mint themselves and retire.** A push seam registers the watch,
  the daemon polls it, a red run offers the fix through the approval
  machinery, and the watch retires once its terminal verdict is delivered.
- **Per-device pairing tokens and a one-pass hand-off.** Pairing tokens are
  per-device and individually revocable, and a hand-off bundle moves a pairing
  to a new device in one pass.
- **Plain http on the LAN is a supported posture.** LAN access over http is
  labeled, not walled; the recommended https path is tailscale serve, which
  terminates TLS with tailscale's own certificates. The daemon never mints
  certificates — the certificate-minting helper was removed outright.
- **A block on a human escalates past an attached surface.** A turn blocked
  too long on an approval or input escalates to push delivery even when a
  surface is attached, on a configurable grace, with bounded follow-ups.
- **Missed automation runs become records, and schedules reconcile.** A run
  the host slept through lands as an honest missed-run record delivered
  through the job's own path, schedules reconcile automatically on wake, and
  the runs source reads incrementally from a moment.
- **Memory-injection provenance rides the turn wire.** TURN_COMPLETED carries
  the turn's memory-sourced injected record ids as
  `metadata.memory.recordIds` — the documented surface convention — with
  honest absence when nothing memory-sourced landed.

### Changed

- **`orchestration.maxActiveAgents` is now `fleet.maxSize`** ("Maximum fleet
  size") — the ONE ceiling on agents the daemon is responsible for: native
  spawned agents, hosted third-party agents, and elastic fix-task agents all
  count against it; merely observed external agents never do. **Migration:**
  an existing `orchestration.maxActiveAgents` value moves onto the new key
  invisibly at first load, with a one-line rename receipt on the announce-once
  queue; spawn refusals name the new key.
- **The WRFC reviewer verifies the contract, not the activity.** The reviewer
  derives an acceptance checklist from the original task, independently
  exercises the deliverable, and scores against that checklist — structural
  evidence (compilation, hashes, diffs, the engineer's own report) is
  supporting material only. The checklist gate is deterministic on BOTH review
  paths: any unverified item blocks a pass whatever the score, and an
  absent/empty checklist blocks (a review that records nothing verified
  cannot pass).
- **Config writes persist only user-set keys.** `save()` no longer freezes
  every default onto disk; previously-frozen defaults are stripped once by an
  invisible migration, external settings edits apply live through the config
  watcher (now wired at the composition root), and the shared activity log
  rotates at a size cap. Per-session crash snapshots restore silently with a
  one-line receipt, and every append-only store the platform writes — session
  journals, the activity log, telemetry ledgers, recovery snapshots — has a
  registered retention owner swept at startup.

### Fixed

- **Power holds can never outlive their owner.** Process exit and signals
  release every held inhibitor; the daemon releases holds on a real stop; and
  inhibitors are stamped with the owning pid so a crashed process's orphans
  are reaped at the next start instead of blocking host sleep forever.
- **Long-running and repeated sessions no longer accumulate orphaned system-bus
  watcher processes.** The sleep-edge watcher (a read-only `dbus-monitor`
  subscription to logind's PrepareForSleep signal) now dies with the process
  that started it: every watcher is tracked and killed on exit and on
  interrupt/terminate signals, is stamped with its owner pid so a crashed
  owner's watcher is reaped at the next start, and is spawned through an
  injectable seam so tests never launch a real one. Previously each start left
  a watcher behind; over many restarts they could pile up and exhaust the
  desktop's per-user D-Bus connection quota, cutting every process of that user
  off from the system bus.
- **The published ConfigKey union matched the schema domains again** (23 keys
  across `checkin.*`, `learning.consolidation.*`, `power.*`, `voice.local.*`,
  and `fleet.maxSize` had schema definitions but no typed entries), and a
  fail-closed gate now derives the key set from the schema domains so the
  drift class cannot return.
- **Three phantom exports closed** — `./platform/power`, `./platform/relay`,
  and `./platform/version` are declared in the package exports map, and
  `MemoryConsolidationScheduler` is re-exported from `./platform/state`, so
  consumer composition roots stop deep-pathing and fork-mirroring.
- **SSE streams outlive quiet periods** with a self-healing heartbeat, push
  subscriptions self-heal via device-identity reconcile with bounded-retry
  pruning, and a self-promoted service unit's ExecStart matches how the
  process was really started.

## [1.8.0] - 2026-07-13

### Added

- **Interactive commands answer their own terminal prompts through the
  approval flow.** A running command that stops on a terminal prompt (the
  "Ok to proceed?" class) now surfaces that prompt through the same approval
  machinery as a permission ask: your typed answer feeds the still-running
  command, and an unanswered prompt times out honestly with the prompt text
  on the result — no more silently wedged interactive commands.
- **Fleet nodes carry a headline and a stall tell.** Every fleet node
  exposes a one-line headline derived from its task/phase identity (never
  model output) and a quiet-too-long stall marker computed from timestamps,
  so every surface renders the same at-a-glance state without deriving it.
- **Finished work pushes by default.** Terminal fleet transitions
  (run-level kinds) push a completion notification to every paired target
  with zero setup, de-duped per node; per-class notification toggles
  (approval / needs-input / completion, default on, read live) exist only
  to silence a class.
- **CI watches poll themselves and offer the fix.** Registered CI watches
  are polled by the daemon on a configurable cadence (15s floor, overlap
  guarded); a red run raises a "fix this?" offer through the approval
  machinery whose acceptance starts a fix session seeded with the failing
  jobs' logs, and a watch retires once its terminal verdict is delivered.
- **A one-command service install.** `goodvibes-daemon --install-service`
  writes the service unit and prints the follow-up commands — and
  standalone spawned daemons now promote themselves to a supervised
  service at their first idle moment (`service.enabled=false` keeps them
  session-only), so the survives-reboots step stops being homework.

- **Chat channels are owner-gated, and the owner's reply resolves pending
  asks.** Each chat surface keeps a per-surface owner allowlist that seeds
  itself: the first identified sender becomes the owner (pairing the channel
  proves it by messaging first); unknown senders are denied before any route
  binding or session submit, with one log line per ignored message. A paired
  owner can approve, deny, or steer a pending permission ask by replying
  with an explicit verb (approve/yes/allow, deny/no/reject) — the reply
  resolves through the same approval broker every surface uses, the
  trailing text is delivered to the model as the decision's reason (deny
  guidance steers instead of behaving as a bare deny; approve text steers
  the running turn), non-verb text flows through as a normal message, and
  ambiguous multi-ask situations are left alone rather than guessed.
- **The chat-channel family defaults on behind that gate.** With the owner
  allowlist in place, route binding, the delivery engine, and the Slack,
  Discord, ntfy, webhook, and Home Assistant surfaces enable by default
  (each remains a real per-surface setting that can be turned off); the web
  surface, automation domain, watcher framework, and service management
  keep their separately-conditioned defaults.
- **Live model discovery for Amazon Bedrock, Anthropic Vertex, and GitHub
  Copilot.** The last three statically-listed providers now fetch their
  model lists live using their already-configured credentials (Bedrock's
  foundation-model listing via the same signing path as chat; Vertex's
  publisher-model listing via the same ADC path; Copilot's models listing
  on the chat host — its previous "no listing endpoint" claim was verified
  false for this auth mode). The packaged lists remain as dated offline
  fallbacks; a failed fetch logs and falls back, never breaks the provider.
- **CI fix-sessions start with the real logs and announce their id.** A red
  watch's fix-session brief now contains the failing jobs' actual log text
  (tail-bounded per job, capped in job count) instead of a pointer, and the
  started session's id reaches surfaces: on the verb result for auto-start
  watches, and via a follow-up channel notification (a machine-readable
  sessionId line) on both the auto and accepted-offer paths, so a surface
  can open or attach the session. When the acceptance came from an approval
  card, the started id is ALSO stamped onto the resolved approval record
  (`fixSessionId`, published live through the broker), so the surface that
  accepted has an in-process handle to jump straight to the session —
  denied offers are never stamped.
- **Feature announcements reach surfaces.** Announce-once lines (the web
  surface URL, the first contained exec run) now queue for delivery and
  ride the explicitly-consuming daemon status receipts read, so a surface
  attaching later renders them instead of them living only in the daemon
  log — still exactly once per install. The automation
  create-your-first-routine copy now actually ships: the jobs list carries
  an emptyState block while automation is enabled with zero routines.
- **Workspace registrations carry provenance.** Each registered root can
  record which surface/flow wrote it (`origin`) and whether it is in scope
  for automatic checkpoints (`checkpointEligible` — absent means NO), so
  one surface registering a workspace never silently widens another
  consumer's checkpoint scope. Re-registering an existing root with the
  flag upgrades it (how the checkpoint-owning consumer stamps its roots on
  boot); a plain re-registration never strips a stamp.

- **Model pricing is tracked, current, and actually used.** One pricing
  resolver per (provider, model): a user-set manual price
  (`pricing.modelPrices` config key, applied live) always wins, then a
  registration-supplied price on custom providers/models, then the
  provider's own machine-readable pricing (OpenRouter, aihubmix, and the
  Vercel AI gateway serve rates in their /models payloads — fetched on the
  same 24h TTL discipline as model lists, cache read/write rates included),
  then the models.dev catalog entry for that exact provider+model (dated),
  then honest UNKNOWN — never $0, never inferred-free. `costUsdCents` (plus
  a `costSource` stamp) is now computed from actuals at every
  LLM_RESPONSE_RECEIVED emit site; `priceUsage`, the cost-attribution verbs,
  and orchestration dollar budgets all price through the same resolver, so a
  dollar budget triggers on ANY resolvable model's actuals and reports its
  unpriced blind spot.
- **Approval decisions persist and generalize; deny is feedback.** Every ask
  carries remember-tier options (exact command / command class / edits under
  a path / whole tool / session). A generalizing decision writes a durable
  user-origin rule consulted before ever prompting (and folded into the
  policy engine); rules survive restart and are listable/deletable via the
  new `permissions.rules.list` / `permissions.rules.delete` verbs. Duplicate
  in-flight asks coalesce to one prompt; a remembered decision sweeps queued
  asks it covers. A denial resolves the tool call with the structured
  user-declined result — including the user's optional reason — in a
  continuing turn.
- **One request-time credential chain with live re-registration.** Provider
  keys resolve env → secrets store → subscription accounts; writing,
  rotating, or deleting a secret re-registers the affected providers in the
  same process (no restart anywhere). Every provider must declare its
  credential authority at registration (fail-closed, like the model-source
  contract), and provider-account `recommendedActions` are now structured
  `{ description, command? }` objects a surface can execute directly.
- **Public export paths for consumer-vendored modules:**
  `platform/runtime/feature-announcements`,
  `platform/runtime/permissions/localhost-fetch-approval`, and the shared
  bare-model-id resolver via `platform/providers`.
- **More public export paths consumers were fork-mirroring or casting
  around:** `platform/state/store-snapshots` (StoreSnapshotScheduler +
  snapshot/restore/list helpers, with the RetentionPolicy / SnapshotPruner /
  RetentionClass pieces they compose) and
  `platform/runtime/permissions/exec-prompt-wiring`
  (buildExecPromptAnswerHandler + its ask/answer/deps types). The
  `platform/control-plane` barrel now also exports
  `buildSharedSessionAgentSpawnRoutingInput` (+ its
  `SharedSessionAgentSpawnRoutingInput` type) and
  `hasFreshSurfaceParticipant` + `SURFACE_ROUTE_FRESHNESS_MS`, so surfaces
  derive spawn routing and surface presence from the SDK instead of
  re-implementing them.
- **Update lifecycle export paths:** `platform/runtime/self-update` (release
  artifact resolution, checksum verification, version banding),
  `platform/daemon/auto-updater` (DaemonAutoUpdater), and
  `platform/daemon/receipts` (DaemonReceiptStore) — with an export-map
  resolution test that imports every new subpath through the package name,
  proving each against the committed manifest rather than just compilation.

### Changed

- **The keyless default is honest.** Provider readiness is derived from the
  registered auth state, onboarding copy is generated from that state (a
  false "works without a key" promise is structurally unwritable), keyless
  claims on auth-required providers are red-flagged, and an unconfigured
  compat provider refuses chat before the wire instead of dead-ending in a
  401.
- **Worktree eviction never destroys work.** When the kept-worktree cap
  evicts an orchestration item's worktree, dirty state is committed onto
  the item's branch first and the branch survives — only the directory is
  removed, and the eviction event names the branch and preservation commit.
- **Bare configured model ids resolve instead of lecturing.** A bare
  `provider.model` value now resolves through the same shared resolver as
  every other entry point (unique ids auto-qualify; ambiguous ids list the
  real candidate keys; unknown ids get closest-match suggestions plus a
  concrete valid example).
- **Remote model pickers stay fresh.** Reading the models list triggers the
  same TTL-respecting live-discovery re-check the TUI's picker uses,
  without ever blocking the response on a slow provider.
- **Amazon Bedrock Mantle discovers models live** (same control-plane
  listing as Amazon Bedrock, dated offline fallback), and the provider
  contract now requires every provider to declare its model source — a
  bare hardcoded model array no longer passes.
- **CI fix sessions hand you a real session id.** The id on the approval
  record, the verb result, and the channel notification is the actual
  spawned session (attachable/resumable) — previously it was an internal
  scheduling handle that resolved to "Session not found". A failed start
  records the honest failure instead of a dead id.
- **The settings-migration receipt reaches your surface** via the same
  attach-time receipts feed as other daemon notices, exactly once — it no
  longer lives only in the activity log.
- **The auto-update loop takes the HOST artifact's identity.** The daemon
  facade previously compared the SDK package version against release tags
  and swapped `process.execPath` — wrong whenever the daemon is embedded in
  a host binary with its own version and release line. `DaemonConfig` (and
  `bootDaemon`) now accept `updateArtifact: { version, execPath? }`; the
  SDK's own daemon CLI passes its release version (behavior unchanged for
  the SDK-shipped artifact), while the embedded default — no artifact
  identity — means the host manages updates and no loop starts. An
  embedder's version is never compared against SDK release tags.

- **Priced values carry their provenance.** Every gateway verb that serves
  dollars now also says where the rates came from and how fresh they are, so
  a surface renders "your price" vs "catalog price, as of <date>" without
  deriving it client-side:
  - `cost.attribution.get`: rows and the aggregate gain `costSource`
    (`user` | `provider` | `catalog` | `mixed` | null) and `pricingAsOf`
    (oldest ISO date among the dated pricing snapshots that contributed;
    null when undated/unpriced).
  - `providers.usage.get` / `providers.get` / `providers.list`: every model's
    served price now resolves through the one pricing resolver (manual price
    wins — the price shown is the price charged) and carries
    `pricing.source` + `pricing.asOf`; the usage snapshot's `pricingSource`
    widens to `user | catalog | provider | mixed | none` plus `pricingAsOf`.
  - Fleet verbs (`fleet.snapshot` / `fleet.list` / `fleet.archived.list` /
    `fleet.attempts.*`): nodes and attempt usage gain optional `costSource`
    and `pricingAsOf`, stamped at pricing time and folded through aggregates
    (one shared source reports itself, disagreement is `mixed`, the oldest
    date wins). Usage records committed before this change report no
    provenance — honest absence, never back-filled.

- **`/status` receipt consumption is now explicit.** Daemon receipts
  (update/crash/migration notices) were delivered destructively to the FIRST
  authenticated `/status` reader — including identity probes and keepalives
  that parse only status/version — so a receipt could be eaten before any
  rendering surface saw it. Now a plain `GET /status` never returns or
  consumes receipts; a reader that wants them passes `?receipts=consume`
  (typed on the operator client as `control.status` input
  `{ receipts?: "consume" }`) and receives undelivered receipts exactly once.
  Consumers: probes and keepalives stop eating receipts with no change on
  their side; rendering readers must now pass the explicit flag to receive
  receipts.

### Fixed

- **Glob matching for scoped rules is built in a single pass, so `**` keeps
  matching under heavy use.** Path-scope approval rules (an "allow edits under
  this directory" grant), host/network-scope rules, and the credential-read
  defaults converted their glob patterns to regexes by round-tripping the `**`
  wildcard through a placeholder sentinel via repeated global `String.replace`.
  On engines that let a `/g`-flagged regex carry `lastIndex` state into a later
  `replace`, the sentinel-restore step could be skipped after many calls,
  leaving the placeholder in the pattern so a `**` rule silently stopped
  matching — a directory-scoped approval would then re-ask for a sibling file
  it had already covered. The conversion now runs as a single forward character
  scan that holds no state and cannot mis-fire, and the shared matcher's `**/`
  prefix expansion is fixed as well.
- **The HTTP approval route forwards the full decision, not just
  note/remember.** `POST /api/approvals/{id}/approve|deny` now carries
  `rememberTier` (tier grants mint durable rules and sweep queued asks they
  cover), the deny `reason` (rides the structured declined result so the
  model adapts), and `modifiedArgs` (an argument-modifying approval — e.g.
  the typed answer to a command's terminal prompt — reaches the waiting
  call; `selectedHunks`, when present, supersedes it). Previously these
  worked in-process only: over HTTP, tier grants minted nothing, deny
  reasons vanished beyond the audit note, and an exec-prompt answer never
  reached the waiting command. Responses now include a `recorded` block
  derived from the broker's returned record (never echoed from the request)
  reporting what was actually recorded; malformed decision fields are
  honest 400s. Surfaces already sending the forward-compatible body take
  effect with no change on their side.

- Absent-from-catalog models no longer look free: the models.dev transform
  kept a missing cost as null instead of coercing to $0 (catalog cache
  bumped to v2 so stale zero-coerced caches refetch).
- Two store snapshots requested within the same millisecond no longer
  overwrite each other (filenames uniquify).
- Daily store-snapshot dedup runs on the scheduler's own clock: each
  snapshot's file time is stamped with its logical creation time (a
  production no-op), so the once-per-day check and the listed creation
  times agree under an injected clock instead of misfiring against the
  wall clock.

## [1.7.1] - 2026-07-11

**1.7.0 broke local-provider discovery in production. Consumers on 1.7.0 should
upgrade straight to 1.7.1 — do not stay on 1.7.0.**

### Fixed

- **`GATE_SUITES` (the eval harness's standing-gate suite set, added in 1.7.0)
  was unreachable through any public import path.** `evaluateGate`'s new
  absolute per-dimension floor enforcement and `GATE_SUITES` — documented
  in-source as "the separate, all-floors-passing set the standing gate
  runs" and the intended migration off `BUILTIN_SUITES` — were exported only
  from the internal `platform/runtime/eval/index.ts` barrel. The public
  `platform/runtime/observability` subpath re-exported `BUILTIN_SUITES` but
  never `GATE_SUITES`, and there was no dedicated `platform/runtime/eval`
  subpath, so consumers had no way to import it. `GATE_SUITES` is now
  re-exported alongside `BUILTIN_SUITES` from `platform/runtime/observability`
  (the existing, idiomatic barrel — no new subpath needed). The registry
  install-smoke check now resolves `GATE_SUITES` through the public
  specifier as part of every release.
- **Local/discovered LLM providers (Ollama, LM Studio, llama.cpp, vLLM, TGI,
  LocalAI) threw at discovery, breaking every local-server user on 1.7.0.**
  The `openai` npm dependency's client constructor started throwing
  `"Missing credentials..."` on a falsy `apiKey` (previously it only threw on
  `undefined`) somewhere between 6.29 and 6.46. `platform/providers/discovered-factory.ts`
  registers every discovered local server with a hardcoded `apiKey: ''`
  (local servers don't need a real key), and that empty string reached
  `new OpenAI({ apiKey })` unchanged in `openai-compat.ts`, `openai.ts`, and
  `lm-studio-helpers.ts` — so `ProviderRegistry.registerDiscoveredProviders()`
  crashed at startup for anyone running a local model server. Fixed by
  substituting a harmless placeholder (`'gv-local'`, the same literal the
  builtin-provider registry's own anonymous-provider fallback already used)
  whenever the effective `apiKey` is empty, at the point each of those three
  files constructs an `openai` client. `configured`/`isConfigured()` status is
  still derived from the ORIGINAL `apiKey` value, so unconfigured/anonymous
  state is unaffected.
- **The SDK's own `openai` dependency range (`^6.29.0`) let the published
  package resolve to a version its own test suite never ran against.**
  `bun.lock` pinned `openai@6.35.0`, so `bun install --frozen-lockfile` in CI
  always tested a safe, older resolution — but a fresh consumer install
  (`npm install` / `bun add` with no matching lockfile) followed the semver
  range to whatever was newest (6.46.0), which carried the breaking
  constructor change above. The lockfile shielded CI from exactly what fresh
  installs got. `openai` is now exact-pinned to `6.46.0` in
  `packages/sdk/package.json` (matching this same dependency block's existing
  exact pins on `cloudflare`, `google-auth-library`, and `pdfjs-dist`), and
  the regression tests below run against whatever version is actually
  resolved so a future drift back to a range would surface as a real failure
  rather than a silent gap between the lockfile and a fresh install.

## [1.7.0] - 2026-07-11

### Added

- **Real WebAuthn step-up verification for mutating relay calls (server side).**
  The relay step-up policy previously shipped only a hook and a fail-closed
  injected verifier — every mutating call over the relay was refused. It now
  ships a working ceremony over node/Web Crypto with no external WebAuthn
  library. Two admin/authenticated operator verbs drive it:
  `stepup.credentials.register` (admin/local-only) stores a passkey — its
  `credentialId`, COSE public key, and starting signature counter — in the
  daemon secret store and records the deployment policy (rpId, allowed origins,
  user-verification requirement), accepting `'none'` attestation (the standard
  self-hosted posture, documented in `docs/relay-zero-knowledge.md`); and
  `stepup.challenge.mint` issues a short-lived, single-use challenge bound to the
  calling session/rendezvous (freshness window `ttlMs`, clamped 5s–300s, default
  120s). The daemon's real `StepUpAssertionVerifier` verifies a P-256 ECDSA
  assertion over `authenticatorData || SHA-256(clientDataJSON)` with full
  `clientDataJSON` type/challenge/origin checks, an rpIdHash check, the
  user-presence flag (and user-verification when required), and
  signature-counter regression detection; only a complete pass consumes the
  challenge and advances the stored counter, and everything else still fails
  closed with an honest reason. The challenge-mint path is exempt from the gate
  (it is the bootstrap for producing an assertion); credential registration is
  not. New: `stepup.credentials.register` + `stepup.challenge.mint` operator
  verbs, and the daemon-side `StepUpService`/`verifyStepUpAssertion` core wired
  as the relay gate's verifier.
- **Live event streaming over the relay tunnel.** The relay tunnel carried only
  unary request/response; live event subscriptions (SSE) fell back to polling for
  relay-connected surfaces. The hop/tunnel protocol now has a streaming frame
  family over the established E2E channel — `stream-open` / `stream-data` /
  `stream-overflow` / `stream-close` — all sealed as ciphertext to the relay
  exactly like every other payload. The daemon bridges its existing realtime
  event source into `stream-data` frames with a **bounded** per-stream send
  buffer and a per-pipe stream cap (consistent with the relay server's limits);
  on overflow it drops-with-notice via a `stream-overflow` frame carrying the
  dropped count (never a silent gap), and close is clean in both directions. On
  the client, the relay-backed `fetch` opens a `text/event-stream` request as a
  tunneled stream and returns a streaming `Response`, so the existing
  Server-Sent-Events connector idiom (`openServerSentEventStream`) works over the
  relay unchanged — a surface that rejects SSE over relay today can lift that
  rejection and call it directly. New tunnel frame types
  (`TunnelStreamOpenHeader`, `TunnelStreamDataHeader`, `TunnelStreamOverflowHeader`,
  `TunnelStreamCloseHeader`).

- **Sandbox boundary escalations now ride the ONE approval broker, plus an
  optional model-judgment tier for the residual ask-tail.** (a) When the
  per-command exec sandbox is active and a command needs host access a
  boundary-safe command would not (network, host-privilege escalation), that
  escalation is now brokered through the SAME approval broker as a permission ask
  and an MCP elicitation — attributed to the sandbox and the specific escalation
  (`{ kind: 'sandbox-escalation', sandbox, escalations }`) — so every surface's
  approval UI renders it and background bubbling applies. A refused escalation
  denies the command before it spawns; the frozen catastrophic block is enforced
  independently and untouched. (b) A new dark, graduation-tracked
  `sandbox-model-judgment` flag gates an optional model-judgment pass on the
  residual ask: a provider call over the command, its sandbox plan, workspace
  context, and the policy reasons produces a PROPOSED verdict with stated
  reasons. Per recorded doctrine — "permission settings are the sole authority
  for command-class risk; the exec-layer unconditional block is a frozen
  catastrophic-only list … that must NEVER expand without Mike's explicit
  approval" — the tier NEVER converts allow→deny and NEVER touches the frozen
  list; its verdict either annotates the human ask ("model judgment: looks safe
  because… / flags risk because…", the default) or, only when the operator opts
  into `sandbox.judgmentAutoApprove`, auto-approves a looks-safe verdict. A
  flags-risk verdict never auto-denies, and a judgment failure degrades to a
  plain ask. Every judgment leaves a receipt. New:
  `createSandboxEscalationApprovalHandler`, `runSandboxJudgment`,
  `applySandboxJudgment`, `createSandboxJudgmentProvider`,
  `buildSandboxEscalationHandler`, and the `sandbox-escalation` attribution
  member.
- **A decision-log → OTLP exporter: the permission/policy decision log maps to
  OpenTelemetry span and log semantics.** The decision log already records every
  allow/deny with its evaluation layer and reason; this exposes that
  ahead-of-field data by mapping each record to OTLP — `decision.id`, `tool.name`,
  `command.class`, `permission.mode`, `decision.layer`, `decision.reason`, and
  `decision.allowed` as attributes — and POSTing it as OTLP/HTTP JSON (which the
  protocol supports) with the platform's `instrumentedFetch`, so there is no new
  heavyweight dependency. Honest scope: EXPORT-ONLY, no ingestion. Off by default
  behind three new config keys — `telemetry.decisionOtlpEnabled`,
  `telemetry.decisionOtlpEndpoint`, `telemetry.decisionOtlpSignal`
  (`span` | `log` | `both`) — spans POST to `<endpoint>/v1/traces` and logs to
  `<endpoint>/v1/logs`. Export never throws: an unreachable collector never
  blocks a permission decision. New: `exportDecisions`, `buildTracePayload`,
  `buildLogsPayload`, `decisionToSpan`, `decisionToLogRecord`,
  `decisionAttributes`, and the OTLP shape types.
- **A fresh-context DISTILLER compaction strategy, as an alternative to in-place
  structured summarization.** Instead of assembling a handoff from many targeted
  extraction calls over the message history, the distiller makes ONE fresh model
  call that distills the conversation into a structured continuation brief (task
  state, decisions made, open threads, key file/symbol references) which seeds a
  fresh context. Selection is the new `behavior.compactionStrategy` config key
  (`structured` default | `distiller`), and the distiller graduates through the
  new dark, graduation-tracked `compaction-distiller-strategy` feature flag —
  when the flag is off, a `distiller` config value honestly resolves back to
  `structured`. Every distillation is scored through the SAME quality scorer as
  the structured strategy: a distillation below the quality floor (or a fresh
  call that is unavailable) FALLS BACK to the structured strategy, and the
  compaction receipt names the strategy that ran plus the requested strategy and
  the fallback reason. Standing instruction-chain / active-skill re-injection at
  the compaction boundary applies to both strategies (the distiller re-injects
  through the same `buildReinjectedInstructions` seam — parity, not a second
  copy). New: `distillConversation`, `resolveCompactionStrategy`,
  `CompactionStrategyChoice`, and the `requestedStrategy` /
  `strategyFallbackReason` receipt fields.

- **A steer message to a wedged agent now re-triggers its processing loop
  instead of being silently dropped.** `AgentManager.wakeWithSteer(agentId,
  steer)` re-triggers a terminally-FAILED agent — one whose turn loop has
  definitively exited (an exhausted turn / circuit-breaker loop, idle-after-
  error, or a watchdog kill) — by restoring honest prior context (a summary of
  the frozen transcript tail, not a risky tool-call replay) and injecting the
  steer as a fresh user turn. Only that safe subset is woken: re-running a
  still-live loop would race its promise, so a genuinely-running agent still
  receives its steer through the message bus and drains it at the next turn
  boundary exactly as today, and a completed/cancelled agent is not auto-woken.
  The fleet steer path (`ProcessRegistry.steer`) routes a failed agent's steer
  through the wake instead of the previous honest-but-dead-end refusal; a
  still-running ('stalled') agent is not re-run (no false success).
- **A model-invokable `context_accounting` tool: the model can read its own
  context composition honestly.** Registered on the standard tool roster (every
  consumer inherits it like `repo_map`), it reports — from existing records,
  never estimated-as-fact — what was passively injected this turn (memory record
  ids, sources, and why), the recall-contract outcomes (relevance floor, records
  dropped to fit the budget, lexical-fallback degraded mode, index-unavailable
  reasons), compaction state, and token-budget state. Provider-measured token
  counts are reported as fact; heuristic values (per-turn injection token cost,
  context-used percent) are flagged as estimates. This lets the model tell "no
  memory exists" apart from "recall was floored" apart from "the index is
  unavailable." The tool binds to a session via a settable
  `ContextAccountingHolder` (exposed as `runtimeServices.contextAccountingHolder`)
  that an interactive consumer populates with its Orchestrator-backed source;
  unbound, the tool says so honestly rather than inventing an accounting.
- **A child agent that dies abnormally now delivers a structured failure
  envelope to its supervising parent instead of a bare status.** When a spawned
  agent terminates on an API error, watchdog kill, budget exhaustion, an
  exhausted turn / circuit-breaker loop, or a cancel/kill, the parent's poll
  (`agent` tool `status` / `get` / `wait`) returns a `failure` envelope
  `{ agentId, phase, reason: { code, message }, partialOutputs }`. The reason
  code is classified from the child's own record (`max_turns`,
  `circuit_breaker`, `watchdog_timeout`, `budget_exhausted`, `claim_unverified`,
  `api_error`, `killed`, `interrupted`, `error`); `partialOutputs` is whatever
  the child genuinely produced — its last committed output and a role-tagged
  transcript-tail summary from the live-or-frozen conversation snapshot — never
  fabricated, with an honest note when it produced nothing. A failed WRFC
  owner's echoed failure message is not passed off as genuine output.
- **Per-model edit-failure and declared-exec-expectation-miss telemetry, so
  tool-format regressions surface as data.** A new process-wide recorder
  (`ToolFormatTelemetry`, mirroring `platformMeter`) counts, keyed by model id
  and failure class, the edit tool's no-match / multi-match / external-conflict
  / generic failures and its whitespace/fuzzy lenient fallbacks, plus each
  declared exec expectation miss (`exit_code` / `stdout_contains` /
  `stderr_contains`). It is fed at the two tool-execution loops (main session
  and background agents), which know the active model, and read through the
  existing runtime metrics snapshot at `GET /api/runtime/metrics` under a
  `toolFormat` key (`{ byModel: { [model]: { [class]: n } }, byClass }`). This
  is measurement only: nothing is read back to switch behavior, and it is
  explicitly NOT a per-model edit-format matrix. An ordinary non-zero exec exit
  (no declared expectation) is not counted — only genuine format regressions.
- **MCP server elicitation requests now reach the model and the human through
  the one approval broker.** An MCP server's `elicitation/create` request (the
  spec's ask-the-user channel) was previously hard-rejected by the client with
  a JSON-RPC `-32601` before anyone was consulted. It is now translated into a
  `PermissionPromptRequest` — attributed to the asking server
  (`attribution: { kind: 'mcp-server', serverName }`), category `delegate` —
  and routed through the same `ApprovalBroker.requestApproval` as a permission
  ask, so every surface's existing approval UI renders it and background-agent
  bubbling applies. Approve maps to the elicitation `accept` action (carrying
  any surface-supplied content, never fabricated); deny/expire maps to
  `decline`. The client advertises the `elicitation` capability at handshake
  only when the resolver is wired, and still returns `-32601` for genuinely
  unsupported server methods (`roots/list`, `sampling/createMessage`).
- **An agent-side ACP adapter: GoodVibes is now drivable from ACP-capable
  editors (Zed and others) over stdio.** `serveAcpAgent` /
  `GoodVibesAcpAgent` (exported from `@pellux/goodvibes-sdk/platform/acp`, run
  via `bun scripts/acp-agent.ts`) implement the Agent Client Protocol's agent
  interface on top of the new embedding API: `session/new` boots an embedded
  GoodVibes session against the editor's cwd, `session/prompt` submits text and
  streams runtime turn/tool events back as `agent_message_chunk` /
  `tool_call` / `tool_call_update` notifications, permission asks bridge to
  ACP `session/request_permission` (allow once / allow always / reject), and
  terminal turn events map to honest stop reasons (`end_turn`, `cancelled`,
  `max_tokens` for context overflow, `max_turn_requests` for the tool-loop
  circuit breaker, `refusal` otherwise). Unsupported protocol features are
  reported honestly as `capability: false` — `loadSession`, image/audio/
  embedded-context prompts, and client-supplied MCP servers — never stubbed;
  cancellation is best-effort (queued input cancelled via the broker, prompt
  resolves `cancelled`; an in-flight provider call is not aborted).
- **The operator contract published as a real OpenAPI 3.1 document, generated
  with a drift gate.** `bun run openapi:generate` derives
  `operator-openapi.json` from the committed operator contract: all 378
  cataloged methods appear — REST-bound methods as path operations with their
  real JSON Schemas embedded (OpenAPI 3.1 takes full JSON Schema unmodified),
  invoke-only methods listed on the generic invoke endpoint — plus the
  contract's bearer/session-cookie auth schemes. The 97 methods lacking typed
  SDK client IO are marked honestly (`x-typed-client-io: false`, counted in
  `x-untyped-client-io-count`, mirrored in the `x-operator-methods` index),
  never omitted; schema-less request/response bodies say so
  (`x-schema-coverage: schema-less`) instead of receiving invented schemas.
  Fetchable as `@pellux/goodvibes-contracts/operator-openapi.json` /
  `@pellux/goodvibes-sdk/contracts/operator-openapi.json` and committed at
  `docs/operator-openapi.json` (byte-identical copies from one generator).
  Drift in either copy reddens `contracts:check` — the generated-artifact idiom.
- **SDK Embedding API 1.0 — a documented, stability-marked entry point
  (`@pellux/goodvibes-sdk/embed`) for embedding a GoodVibes session in another
  application.** `createEmbeddedSession({ workspace, homeDirectory,
  requestPermission })` boots an in-process daemon for the workspace and returns
  an `EmbeddedSession` exposing the minimal stable contract: the runtime event
  bus to receive typed events, a `submit()` seam to send input, the approval
  broker with an injected permission callback bridged onto it, and an idempotent
  `stop()`. The surface is a curation of existing runtime machinery — it invents
  no new engine — and is FROZEN at 1.0, pinned by a dedicated api-extractor
  report (`etc/goodvibes-sdk-embed.api.md`) wired into `api:check` so an
  accidental breaking change to the embed surface fails the gate. The daemon
  facade now exposes its runtime bus and session broker (`eventBus` / `sessions`)
  so an in-process embedder can subscribe and submit without going over the wire.
- **A capability-bundle plugin format with SHA-256-pinned distribution and a
  governed marketplace index.** A bundle manifest declares exactly which
  capabilities a plugin needs — the security capabilities it uses plus the tools
  it registers, hooks it subscribes to, config domains it reads, and channels it
  touches — and the runtime grants it ONLY what it declared. A deny-by-default
  guard (`createBundleCapabilityGuard` / `enforceBundleCapability`) refuses any
  tool, hook, config domain, channel, or security capability the manifest did not
  list; over-reach into high-risk capabilities beyond the bundle's trust tier is
  withheld and recorded (quarantined on install via `planBundleActivation`)
  rather than silently granted. Distribution is SHA-256 pinned:
  `fetchAndVerifyBundle` resolves a file/URL/git source and verifies the expected
  hash BEFORE returning — a missing or mismatched pin is a hard `BundlePinRefusal`
  with no install-anyway path. The `PinnedMarketplaceIndex` format is governed by
  construction: each entry's pin and capability summary are required by the type,
  so a self-hostable registry built from it cannot represent an unpinned or
  capability-opaque bundle. Shipped under
  `@pellux/goodvibes-sdk/platform/runtime/ecosystem` with a `plugin-bundle`
  init/validate CLI (`scripts/plugin-bundle.ts`).
- **A zero-knowledge, self-hostable relay so a daemon is reachable from outside
  the LAN without the relay operator being able to read the traffic.** A daemon
  connects OUTBOUND to the relay and registers under an unguessable rendezvous
  id; a surface dials the same id; the relay pairs the two multiplexed pipes and
  forwards OPAQUE bytes. Zero-knowledge is structural: an NK-style end-to-end
  handshake (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, all Web Crypto, no new
  dependency and nothing hand-rolled) runs INSIDE each pipe before any
  application byte, so the relay only ever sees ciphertext plus connection
  metadata. Daemon authentication is by static-key pinning from the pairing
  payload — a curious or malicious relay that lacks the daemon's static private
  key cannot derive the session keys and its forged handshake confirmation is
  rejected. Ships the runtime-neutral protocol + crypto as
  `@pellux/goodvibes-transport-core/relay` (handshake, `RelaySecureChannel`,
  daemon identity (de)serialization, and the QR-encodable pairing-payload codec)
  and the rendezvous server as `@pellux/goodvibes-daemon-sdk` `RelayHub` /
  `createBunRelayServer`, deployable standalone on a VPS via the
  `goodvibes-relay` bin. No accounts; per-instance caps (max daemons, pipes,
  per-daemon pipes, message size) and per-address handshake rate limiting keep a
  public instance from becoming a liability; a client dialing an unregistered id
  gets an honest `daemon-offline` error.
- **Daemon + client integration for the relay path — the existing typed client
  works unchanged over the relay.** Because the operator protocol is
  contract-driven REST-over-JSON, the relay tunnels whole HTTP request/response
  pairs inside the E2E channel: the client half is a relay-backed `fetch`
  (`createRelayClient` in `@pellux/goodvibes-transport-realtime`) you hand to the
  SDK as `fetchImpl`, so `sdk.approvals.list()` and every other typed call just
  works — the operator's auth token rides inside the tunnel, invisible to the
  relay. The daemon half (`createRelayDaemonRegistration` in
  `@pellux/goodvibes-daemon-sdk`) dials the relay OUTBOUND with reconnect/backoff,
  terminates the E2E channel INSIDE the daemon, and replays tunneled requests
  through the daemon's own route dispatcher (tagged with an `x-goodvibes-via-relay`
  header). New `relay.*` daemon config (`relay.enabled` default OFF, `relay.url`,
  `relay.rendezvousId`, `relay.label`) and a graduating `relay-connect` feature
  flag (default OFF) triple-gate it; the daemon facade starts an outbound
  registration at boot only when config + flag + url all agree. The daemon mints
  a QR-encodable pairing payload (rendezvous id + pinned public key + relay url)
  a surface scans to connect. No new operator methods were added — reachability
  reuses the existing REST surface — so the contract ratchet holds at 97 with REST
  parity and Stage-B fixtures unchanged.
- **Security posture around the relay path.** (a) A WebAuthn step-up policy hook:
  when `relay.requireStepUpForMutations` is on, mutating operator calls arriving
  via relay must carry a recent WebAuthn assertion (which methods are mutating
  comes from the existing catalog read/write split). The SDK ships the policy and
  verb metadata; actual assertion verification is a consumer-side ceremony wired
  as an injected `StepUpAssertionVerifier`, and the policy FAILS CLOSED until one
  is — it never fakes a pass. (b) `mintLanCertificate` mints a local CA + SAN leaf
  certificate (via openssl, not hand-rolled ASN.1) for the daemon's LAN endpoints
  so browsers stop warning on LAN access; it generates + stores + returns paths
  that plug into `controlPlane.tls`, while trusting the CA on the OS is documented
  as the user's step. (c) Relay connections are visibly distinct: every tunneled
  request carries `x-goodvibes-via-relay` (`isRelayTunneledRequest`) and the
  daemon exposes the relay registration status, so surfaces can show "via relay".
  A new docs page (`docs/relay-zero-knowledge.md`) states the threat model
  plainly — what the relay can and cannot see, and what a malicious relay could
  do (connection metadata, traffic analysis, DoS).
- **A shared registered-workspace registry the whole platform reads.** A
  daemon-side store of the project roots an operator has explicitly opted into,
  the platform-wide successor to the agent fork's local
  `registered-workspaces.json` (the persisted record shape is kept identical so
  that file migrates in). Settled coverage semantics: coverage flows DOWN a
  registered root's subtree and never up; a nearer registered root wins when
  registrations nest; a "no" to a prompt is remembered subtree-scoped at the
  root that was asked; and worktree inheritance follows the git
  worktree→main-repo LINK (resolved from `git rev-parse --git-common-dir`), not
  path ancestry — so an orchestration-spawned sibling worktree living outside the
  registered root still inherits its main repo's registration. Registering an
  absurdly broad root (`$HOME`, `/`, or the daemon state dir) is refused through
  the same root-guard the checkpoint manager uses. Ships as
  `@pellux/goodvibes-sdk/platform/workspace` exports (`WorkspaceRegistrationStore`
  with user-scoped, injectable I/O; the pure `resolveWorkspaceRegistration`; the
  `probeWorktreeLink` link probe) plus four operator verbs with typed IO and REST
  parity: `workspaces.registrations.list` / `.add` / `.remove` and
  `workspaces.resolve`. The checkpoint manager's registered-workspace consumers
  adopt it in their own rounds.
- **The eval harness is now a standing CI gate.** `bun run eval:gate` runs the
  all-floors-passing `standing-gate` suite through the production eval paths
  (EvalRunner → scoreScenario → the gate), compares each suite against the
  checked-in baseline (`eval/baseline.json`), prints every scenario's PASS/FAIL
  and score, and exits non-zero on ANY absolute-floor failure OR regression — no
  silent green. It is wired into CI as a required `eval-gate` job (never
  `continue-on-error`), which drift-checks the baseline first
  (`bun run eval:baseline:check`) so a stale baseline fails loudly. Baselines
  regenerate ONLY through the explicit `bun run eval:baseline`. A separate
  `standing-gate` suite backs the gate because the branch-exercising
  `BUILTIN_SUITES` deliberately include floor-failing fixtures and can never be
  honestly green. Also adds a Terminal-Bench-style external task-suite adapter
  (`runTaskSuite` and friends, exported from the eval module): it discovers a
  directory of tasks (each a `task.json` + verification script), runs each
  through an injected real-session executor, runs its verifier, and reports
  pass/fail per task — the adapter contract plus a small bundled example suite,
  not a benchmark import.
- **The sandbox policy surface is now reachable from public subpaths.**
  `decideSandboxedExec`, `detectSandboxAvailability`, and `probeSandboxHost`
  existed but were not exported from any public subpath, so a consumer could not
  wire its approval flow to the sandbox policy. They ship now through
  `@pellux/goodvibes-sdk/platform/runtime/permissions/sandbox-policy`
  (`decideSandboxedExec` + its decision/input types) and
  `@pellux/goodvibes-sdk/platform/tools/exec/sandbox` (the runner:
  `detectSandboxAvailability`, `probeSandboxHost`, `buildBwrapArgv`, the
  plan-resolution helpers, and their types) — the exact paths the exec-sandbox
  entry below names, now real, each with its own bundle budget.
- **A per-command exec sandbox (bubblewrap) to shrink the approval tail.** When
  bubblewrap (`bwrap`) is available on a Linux host, exec tool calls can run
  inside a per-command OS boundary — the workspace bound read-write, the rest of
  the filesystem read-only, `/tmp` isolated, `$HOME` optionally masked, and
  network disabled by default — composed with (not replacing) the existing
  credential-env scrub. Availability is detected honestly: no bwrap, or any
  non-Linux host, reports unavailable with a stated reason and the exec path is
  byte-for-byte unchanged; macOS is unavailable this release (no faked parity).
  New `@pellux/goodvibes-sdk/platform/tools/exec/sandbox` provides the pure,
  injectable runner (host probe → availability, bwrap-argv construction,
  per-command plan) and `runtime/permissions/sandbox-policy` the sandbox-aware
  permission input: a command that runs entirely inside the boundary with no
  host-access need can auto-allow where prompt mode would ask, while commands
  that need real host access surface as explicit escalation asks NAMING what
  they want — "wants network", "wants host privilege escalation", "wants network
  (package install)". Network is off by default with a per-command/per-workspace
  egress allowlist that re-enables it as a named escalation; when bwrap cannot
  guarantee network isolation on the host, the decision metadata says so
  (`network: 'unknown'`) rather than claiming containment. Every sandboxed run's
  result records `sandboxed`, `sandbox_boundary`, `sandbox_network`, and
  `sandbox_escalations`. Config lands under `sandbox.*`: `sandbox.enabled`
  (default OFF, gated by the new graduation-tracked `exec-sandbox` feature flag,
  currently `dark`), `sandbox.egressAllowlist`, and `sandbox.workspaceWritable`.
  The frozen catastrophic command block (rm -rf /, dd to a device, mkfs, fork
  bomb …) stays an unconditional exec-time denial, in force identically inside
  the boundary — the sandbox policy only ever relaxes an ask to an allow, never
  a deny to an allow, and never inspects or expands that block.

- **A unified message-anchored rewind service that joins the platform's three
  history systems.** New `@pellux/goodvibes-sdk/platform/rewind` is one
  coordinator — never a fourth history store — over the workspace checkpoint
  manager (git-backed, sessionId-stamped), the conversation store, and file
  undo. Given a session turn anchor it can restore files (the nearest workspace
  checkpoint), the conversation (truncate session state to the anchor), or both,
  through injectable ports over those existing stores; a part with no store
  wired on the runtime is honestly reported unavailable rather than faked. Two
  ws-only operator verbs land with typed IO and register together with their
  descriptors: `rewind.plan` is a read-only dry-run preview of exactly what
  would change plus a single-use confirm token, and `rewind.apply` is
  confirm-gated (the checkpoints.restore idiom — an unconfirmed call returns a
  non-error refusal naming `rewind.plan`, a bad token is a 400, `confirm:true`
  bypasses). Every apply records an undo point so the rewind is itself
  reversible: the workspace restore reuses the pre-restore safety checkpoint it
  already takes, and the conversation store its captured pre-rewind snapshot,
  both surfaced in the receipt's `undo` block. Applies emit a `REWIND_APPLIED`
  receipt event (and plans a `REWIND_PLANNED`) on the workspace domain so
  surfaces can render them. The service and verbs land this round; consumer
  `/rewind`, `/undo`, and `/redo` commands build on them later.

- **Feature-flag graduation as a release policy.** The platform ships most
  feature flags default-off and flips them on only once validated, but nothing
  forced a per-release decision about the flags that had earned their way on.
  New `@pellux/goodvibes-sdk/platform/runtime/feature-flags` graduation
  bookkeeping gives every flag an owner-facing graduation state — `dark`
  (default-off, no evidence), `soaking` (accumulating evidence),
  `graduate-candidate` (judged ready, awaiting a decision), `graduated`
  (default flipped on), or `blocked` (held off with a dated reason) — plus a
  validation-evidence bundle wired from the machinery that already exists (the
  permissions divergence simulator); a flag with no instrumentation honestly
  reports "no evidence collected" and is never given a fabricated readiness. A
  new read-only operator verb `flags.graduation.report` (ws-only, typed IO,
  registered with its handler) returns the report, and a release-time script
  `bun run flags:graduation` — wired into `release:verify` — FAILS the release
  when any flag sits in `graduate-candidate`, forcing each validated flag to
  flip on or record a dated blocker every release. It is bookkeeping that
  forces a decision, not a new simulation system.

- **The Home Assistant conversation turn can ground itself in the pre-registered
  home graph.** The `/api/homeassistant/conversation` route now accepts an
  optional grounding reference — a `knowledgeSpaceId` / `installationId` (nested
  under `grounding`, or top-level, snake_case accepted). When present, the turn
  consults the pre-registered home-graph knowledge space (`HomeGraphService.ask`)
  for the user's actual question and folds the retrieved grounding — the graph's
  own answer text plus its confidence — into the turn's system prompt, closing
  the index-then-query loop the HA integration already opens by registering and
  refreshing the graph. Best-effort and honest: an absent reference or reader
  leaves the turn ungrounded, an empty answer adds nothing, and a graph failure
  degrades to an ungrounded turn rather than breaking the conversation. The
  grounding block tells the model to still verify live device/entity state
  through Home Assistant tools before acting on prior home knowledge.
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

- **`GET /api/runtime/metrics` is consolidated onto the `runtime.metrics.get`
  gateway verb; the daemon-sdk raw REST handler is removed.** The URL previously
  had two servers: the `@pellux/goodvibes-daemon-sdk` raw handler
  (`getRuntimeMetrics` in the operator dispatcher, admin-wrapped) and the
  `runtime.metrics.get` gateway method. They are now one. `runtime.metrics.get`
  gains a `GATEWAY_REST_ROUTES` parity entry (`GET /api/runtime/metrics`), which
  `dispatchDaemonApiRoutes` serves ahead of the operator dispatcher, so the URL
  keeps answering — now through the same in-process handler and the same
  `read:telemetry` scope gate as the methodId-invoke endpoint. **Breaking for
  daemon-sdk embedders:** the `getRuntimeMetrics` member is removed from
  `DaemonRuntimeRouteHandlers`/`DaemonOperatorRuntimeRouteHandlers`, the
  `DaemonRuntimeMetricsRouteHandlers` interface is deleted, and
  `DaemonRuntimeRouteContext.snapshotMetrics` is dropped. A daemon composed from
  the SDK's own router is unaffected (the gateway verb was already registered);
  an embedder that implemented the raw handler directly should register the
  gateway verb and rely on the REST-parity route instead.

- **Typed-IO coverage ratchet.** A new `contracts:check` gate
  (`scripts/check-foundation-io-coverage.ts`) freezes the number of operator
  methods that lack typed `OperatorMethodInputMap`/`OperatorMethodOutputMap`
  entries (currently 97 of 334) at a checked-in baseline and fails if it grows,
  printing the missing method ids. New methods must ship with typed IO. This is
  a growth freeze, not a burndown of the existing 97.

### Fixed

- **A memory update patch can now change only the temporal validity window.**
  `MemoryUpdatePatch` (memory spine), `MemoryRecordUpdateInput` (daemon route
  body), and the `memory.records.update` operator method now carry
  `validFrom`/`validUntil`, threaded to the store's existing three-state window
  semantics — a number sets the bound, an explicit `null` clears it, and an
  omitted field leaves it unchanged. A memory-projection proposal that changes
  only the window previously could not be applied (it reported failed-with-a-
  reason because the patch shape carried no window); it now round-trips end to
  end, wire included.

- **The composition root can configure the exec credential-env scrub.**
  `registerAllTools` gained a `credentialEnvScrub` dep that is threaded straight
  into `createExecTool`, so a consumer can wire its `permissions.exec.*` config
  (master switch + keep-allowlist) at the composition root instead of the scrub
  always resolving to its built-in default. Omitted, behavior is unchanged
  (scrub enabled with the default allowlist).

- **The memory temporal helpers resist `.filter()` misuse.**
  `isMemoryTemporallyActive` and `isPromptActiveMemory` took an optional `now`
  as their second parameter, so passing one directly to `Array.prototype.filter`
  bound the array INDEX to `now` — silently comparing every record's window
  against a near-zero epoch and defeating expiry entirely. Both now carry a
  `...never[]` tail (rejecting the stray argument at the type level) and a
  runtime guard that throws a loud, explanatory `TypeError` when the array
  argument is passed, instead of absorbing it. Wrap for iteration:
  `records.filter((r) => isMemoryTemporallyActive(r))`.

- **The `learning.consolidation.*` config keys are registered in the schema.**
  The nine idle-time memory-consolidation keys were read off the raw user
  `learning` block but had no schema/`DEFAULT_CONFIG` entry, so typed
  `get`/`set` on `learning.*` threw "section 'learning' does not exist". A new
  `learning` config domain (same idiom as the worktree domain) registers them
  with defaults identical to the behavioral contract's
  `DEFAULT_MEMORY_CONSOLIDATION_CONFIG` (a test guards against drift), leaving
  the resolver's behavior unchanged.

- **The per-model tool-format telemetry (`toolFormat` in `snapshotMetrics()`)
  is now actually reachable by consumers.** It was recorded but stranded: no
  package export subpath carried `snapshotMetrics`/its types, and no operator
  method exposed it — only a bare, uncataloged `GET /api/runtime/metrics` route
  existed, invisible to the typed operator client, REST-parity checks, and
  Stage-B mock fixtures. Fixed both ends: (a) `snapshotMetrics` plus its new
  `RuntimeMetricsSnapshot`/`RuntimeMetricsBucket` types and
  `ToolFormatFailureClass` are exported from
  `@pellux/goodvibes-sdk/platform/runtime/observability`; (b) a new
  `runtime.metrics.get` operator method (typed IO, so the coverage ratchet
  holds at 97 untyped) is cataloged with its handler attached at composition
  time (`registerRuntimeMetricsGatewayMethods`, wired from
  `registerGatewayVerbGroups` — the same descriptor+handler-together idiom
  `flags.graduation.report` uses, so it can never regress to the 501 "cataloged
  but not invokable" defect class; a pin test invokes it through a composed
  catalog). The existing REST binding is unchanged.

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
