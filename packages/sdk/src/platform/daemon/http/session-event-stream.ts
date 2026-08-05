/**
 * session-event-stream.ts — opening the SSE stream a client renders a turn from
 * when the loop is running in THIS daemon rather than in the client.
 *
 * Two routes need exactly this: `GET /api/sessions/:id/events` (a shared or
 * daemon-hosted session) and `GET /api/companion/chat/sessions/:id/events`.
 * They had one copy each, and both copies carried the same two defects:
 *
 *  - They subscribed on `DEFAULT_DOMAINS`, which contains `turn` — the text
 *    deltas, the turn lifecycle, the token usage — and does NOT contain
 *    `tools`, where `TOOL_RECEIVED` / `TOOL_EXECUTING` / `TOOL_SUCCEEDED` /
 *    `TOOL_FAILED` are emitted. A client on the defaults received everything
 *    the model SAID and nothing it DID: the turn rendered with its tool calls
 *    missing, which reads as an assistant that paused for no reason and then
 *    answered. `RENDER_GRADE_SESSION_DOMAINS` is the defaults PLUS `tools`, so
 *    a stream moved onto it keeps every domain it already delivered.
 *
 *  - They did not scope delivery. The path names ONE session; the stream handed
 *    every subscriber every OTHER session's frames as well, and each client was
 *    expected to know to throw them away. Frames carrying no session id still
 *    flow — they make no claim about a session.
 *
 * One function so the next session-scoped stream cannot be added with the
 * defaults again.
 */

import type { ControlPlaneGateway } from '../../control-plane/index.js';
import { RENDER_GRADE_SESSION_DOMAINS } from '../../control-plane/gateway-utils.js';

export interface SessionEventStreamOptions {
  /** Distinguishes this route's subscribers, e.g. `shared-session`. */
  readonly clientPrefix: string;
  readonly sessionId: string;
}

/** Open a render-grade, session-scoped SSE stream for one session. */
export function openScopedSessionEventStream(
  gateway: ControlPlaneGateway,
  request: Request,
  options: SessionEventStreamOptions,
): Response {
  const clientId = `${options.clientPrefix}:${options.sessionId}`;
  return gateway.createEventStream(request, {
    clientId,
    // The gateway's kind union has no 'companion'; these are browser-shaped
    // readers either way, and isolation is by clientId, not by kind.
    clientKind: 'web',
    sessionId: options.sessionId,
    sessionScopedDelivery: true,
    domains: RENDER_GRADE_SESSION_DOMAINS,
    label: `${options.clientPrefix}/${options.sessionId}`,
  });
}
