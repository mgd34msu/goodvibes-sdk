/**
 * submit-turn-quickstart.mjs — Conversation turn walkthrough
 *
 * Demonstrates: create session → subscribe SSE → submit message → stream tokens → exit.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3210).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: node examples/submit-turn-quickstart.mjs
 */

import { createNodeGoodVibesSdk } from '@pellux/goodvibes-sdk/node';

// 1. Construct the SDK (Node defaults: HTTP retry + SSE reconnect baked in).
const sdk = createNodeGoodVibesSdk({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3210',
  authToken: process.env.GOODVIBES_TOKEN ?? undefined,
});

// 2. Create a session. All fields optional; title is a human-readable label.
const session = await sdk.operator.sessions.create({ title: 'quickstart demo' });
const sessionId = session.session.id; // response is { session: { id, ... } }
console.log(`[session] created: ${sessionId}`);

// 3. Subscribe to turn events BEFORE submitting so no deltas are missed.
//    viaSse() returns per-domain feeds. The 'turn' domain carries STREAM_DELTA,
//    TURN_COMPLETED, TURN_ERROR, and TURN_CANCEL events.
//    onEnvelope() provides the full SSE envelope (including sessionId) so you can
//    filter to just this session when multiple sessions share one SSE connection.
const events = sdk.realtime.viaSse();

const turnDone = new Promise((resolve) => {
  // Print each incremental token chunk. e.payload.accumulated = full text so far.
  const unsubDelta = events.turn.onEnvelope('STREAM_DELTA', (e) => {
    if (e.sessionId !== sessionId) return;
    process.stdout.write(e.payload.content);
  });

  // Resolve and clean up on any terminal event (completed / error / cancelled).
  const finish = (label, detail = '') => { unsubDelta(); process.stdout.write('\n'); console.log(`[turn] ${label}${detail}`); resolve(); };
  events.turn.onEnvelope('TURN_COMPLETED', (e) => { if (e.sessionId === sessionId) finish('completed', ` (${e.payload.stopReason})`); });
  events.turn.onEnvelope('TURN_ERROR',     (e) => { if (e.sessionId === sessionId) finish('error', `: ${e.payload.error}`); });
  events.turn.onEnvelope('TURN_CANCEL',    (e) => { if (e.sessionId === sessionId) finish('cancelled'); });
});

// 4. Submit the user message. The SDK streams assistant deltas via the SSE
//    subscription above. For alternative message routing (e.g., companion
//    surfaces), see docs/companion-message-routing.md.
const msg = await sdk.operator.sessions.messages.create(sessionId, {
  body: 'Say hello in exactly one sentence.',
});
console.log(`[message] submitted to session: ${sessionId}`);

// 5. Wait for the turn to finish (or time out after 60 s), then exit cleanly.
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Turn timeout after 60s')), 60_000));
await Promise.race([turnDone, timeout]);
