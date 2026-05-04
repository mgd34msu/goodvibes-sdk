/**
 * submit-turn-quickstart.mjs — Conversation turn walkthrough
 *
 * Demonstrates: create session → subscribe SSE → submit message → stream tokens → exit.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3210).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/submit-turn-quickstart.mjs
 */

import { createGoodVibesSdk, forSession } from '@pellux/goodvibes-sdk';

// 1. Construct the SDK.
const sdk = createGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? null,
});

// 2. Create a session. All fields optional; title is a human-readable label.
const session = await sdk.operator.sessions.create({ title: 'quickstart demo' });
// sessions.create() returns { session: { id, ... } }; session.session.id is the session ID.
const sessionId = session.session.id;
console.log(`[session] created: ${sessionId}`);

// 3. Subscribe to turn events BEFORE submitting so no deltas are missed.
//    viaSse() returns per-domain feeds. The 'turn' domain carries STREAM_DELTA,
//    TURN_COMPLETED, TURN_ERROR, and TURN_CANCEL events.
//
//    forSession() returns a pre-filtered view of the events object — every
//    callback only fires for events belonging to the given session. This
//    removes the need to manually guard each handler with
//    `if (e.sessionId !== sessionId) return`.
const events = sdk.realtime.viaSse();
const sessionEvents = forSession(events, sessionId);

const turnDone = new Promise((resolve) => {
  // Print each incremental token chunk. e.payload.content = incremental token chunk.
  const unsubDelta = sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
    process.stdout.write(e.payload.content);
  });

  // Resolve and clean up on any terminal event (completed / error / cancelled).
  /** @param {string} label @param {string} [detail] */
  const finish = (label, detail = '') => { unsubDelta(); process.stdout.write('\n'); console.log(`[turn] ${label}${detail}`); resolve(undefined); };
  sessionEvents.turn.onEnvelope('TURN_COMPLETED', (e) => { finish('completed', ` (${e.payload.stopReason})`); });
  sessionEvents.turn.onEnvelope('TURN_ERROR',     (e) => { finish('error', `: ${e.payload.error}`); });
  sessionEvents.turn.onEnvelope('TURN_CANCEL',    () => { finish('cancelled'); });
});

// 4. Submit the user message. The SDK streams assistant deltas via the SSE
//    subscription above. For alternative message routing (e.g., companion
//    surfaces), see docs/companion-message-routing.md.
const msg = await sdk.operator.sessions.messages.create(sessionId, {
  body: 'Say hello in exactly one sentence.',
});
console.log(`[message] submitted to session: ${sessionId}`);

// 5. Wait for the turn to finish (or time out after 60 s), then exit cleanly.
const timeout = new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Turn timeout after 60s')), 60_000);
  timer.unref?.();
});
await Promise.race([turnDone, timeout]);
