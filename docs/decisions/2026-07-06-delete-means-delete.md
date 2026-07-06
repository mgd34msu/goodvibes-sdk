# Decision: delete-means-delete — a real hard-delete for companion chat and shared sessions (W5-S1)

Status: accepted — 2026-07-06
Scope: goodvibes-sdk (`packages/sdk`, `packages/daemon-sdk`) — companion-chat session
delete honesty, plus a new `sessions.delete` verb for shared/spine sessions.
Wave: One-Platform Wave 5, stage 0 (SDK enabler), decomposed from the W5 audit item
"delete-that-only-closes" (dishonest verb, MEDIUM severity).

## Problem

`companion.chat.sessions.delete` (`DELETE /api/companion/chat/sessions/{id}`) was a
soft close in a delete costume: the handler called `chatManager.closeSession`, which
set `status:'closed'` and persisted the file — never removed it
(`companion-chat-manager.ts` `closeSession`, `companion-chat-routes.ts`
`handleDeleteSession` pre-W5-S1). The contract even admitted it: title "Close
Companion Chat Session", description "the session record is preserved in closed
state". The UI only *looked* honest because the default session list filters out
closed records — the file lingered on disk indefinitely
(`closedSessionRetentionMs` defaults to retain-forever).

Separately, shared/spine sessions (tui/agent/webui/automation kinds, owned by
`SharedSessionBroker`) had close/reopen/detach but **no hard-delete verb at all** —
removal only ever happened as an internal, opt-in-retention GC sweep
(`session-broker-gc.ts`), never as an explicit operator action.

## Decision

**PART A — split companion close from companion delete.**
- `companion.chat.sessions.close` (NEW, `POST /api/companion/chat/sessions/{id}/close`)
  is the old soft-close behavior unchanged: `status:'closed'`, file retained, still
  listable with `includeClosed`.
- `companion.chat.sessions.delete` (`DELETE /api/companion/chat/sessions/{id}`) now
  performs a REAL hard removal: the on-disk record file is deleted and the in-memory
  entry is dropped, reusing the exact same removal primitive the GC's
  `delete-persistent` sweep action already used
  (`CompanionChatManager._hardRemove`, shared by both call sites — never forked).
  The response is `{ sessionId, deleted: true }`, never `{ status: 'closed' }`, so a
  caller cannot mistake removal for closure.
- Guard: deleting a still-ACTIVE companion session is rejected with
  `409 SESSION_ACTIVE` ("close it, then delete") rather than silently aborting the
  live turn and removing state out from under it. A caller must close first.
- Idempotency: deleting an unknown OR already-deleted id is `404 SESSION_NOT_FOUND`.
  Never a `200`-noop — a delete that appears to succeed on an absent record would
  hide a a prior failed delete.

**PART B — add `sessions.delete` for shared/spine sessions.**
The union-session delete gap is resolved by ADDING the verb (the "prefer honest
capability over honest absence" option from the brief), because "delete a session
from my phone" is a first-class one-platform expectation and the webui (W5-W2)
needs a real verb to wire an honest delete affordance for non-companion sessions.

- `sessions.delete` (`DELETE /api/sessions/{sessionId}`, scope `write:sessions`,
  emits `control.session_update`) hard-removes the session record and its queued
  messages/inputs from the broker's in-memory maps (`SharedSessionBroker.sessions`,
  `.messages`, `.inputs`) and persists the snapshot.
- Same guard/idempotency pair as Part A: `409 SESSION_ACTIVE` if not yet closed,
  `404 SESSION_NOT_FOUND` for unknown/already-deleted.
- `closeSession`/`reopenSession`/`detachParticipant` and the GC's own
  `deletionRetentionMs`-gated sweep (`session-broker-gc.ts`) are UNTOUCHED — delete is
  never triggered by close, and closed-stays-listable remains the default for every
  record this verb does not touch.
- Emits `session-deleted` on the existing `session-update` wire channel (the same
  channel close/reopen/detach already use), tagged in the `session` domain
  (`gateway-scope-enforcement.ts`) exactly like `session-detached`, so a live surface
  can drop the row without a re-fetch.
- Also wired into the TUI's in-process `DirectTransport` path
  (`runtime/operator-client.ts` `sessions.delete` → `sessionBroker.deleteSession`),
  mirroring close/reopen/detach, so the coverage-parity gate (`transport-parity.test.ts`)
  does not need an `'http-only'` punt — the TUI gets the same capability in-process.

## Rejected alternatives

- **A `200`-noop on an absent/already-deleted id** — rejected. A delete verb that
  reports success on an id that was never there (or is already gone) cannot be
  trusted to mean anything; an honest `404` is the only truthful response.
- **Auto-closing an active session inside `delete`** (force-delete) — rejected. A
  session may have live participants or an in-flight agent turn; silently killing it
  as a side effect of "delete" hides destructive scope creep behind a single call.
  The caller must close first, an explicit two-step action for a permanent operation.
- **Overloading `companion.chat.sessions.delete`'s return onto `{status:'closed'}`**
  — rejected; the return shape must say `deleted:true` so a caller cannot mistake a
  close for a removal (this was the exact dishonesty being fixed).
- **A spine-side confirm/type-to-confirm gate inside the SDK** — rejected; the confirm
  is the surface's job (mirrors the W3 `checkpoints.restore` ruling). The SDK's job is
  to make the wire honest; W5-W2 (webui) owns the human-facing confirm.
- **Forking a second file-removal code path for the explicit delete API** — rejected;
  `CompanionChatManager._hardRemove` is the ONE removal primitive, called (awaited)
  by the new `deleteSession()` API and (fire-and-forget) by the GC sweep's
  `delete-persistent` action, so there is no risk of the two diverging.

## Consumability proof

`test/w5-s1-delete-daemon-wire.test.ts` drives both delete paths over a REAL
`bootDaemon` (isolated home, ephemeral port, token auth — never the real 3421/4444
daemons): companion close-vs-delete (soft close preserves the file; hard delete
removes the on-disk file AND 404s on get AND is absent from `includeClosed=true`
list; the active-session 409 guard; the already-deleted 404); and the new
`sessions.delete` spine verb (409 on active, hard-remove + 404-on-get + absent-from-list
on closed, idempotent 404 on a second delete/unknown id, and the `session-deleted`
event observed live on the real `/api/control-plane/events` SSE channel).
`test/companion-chat-routes.test.ts`, `test/session-lifecycle-events.test.ts`, and
`test/transport-parity.test.ts` cover the unit-level route/contract/DirectTransport
assertions (including the `SESSION_UPDATE_INTENT_MAP.deleted` wire-contract entry and
the `sessions.delete` DirectTransport mapping).
