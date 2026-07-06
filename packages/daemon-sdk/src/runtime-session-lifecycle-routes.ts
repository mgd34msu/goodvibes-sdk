/**
 * runtime-session-lifecycle-routes.ts
 *
 * Shared-session lifecycle route handlers (get / close / reopen / detach /
 * delete). Split out of runtime-session-routes.ts (see CHANGELOG 1.0.0) to stay under the
 * repo's grandfathered line-cap ceiling (see scripts/check-line-cap.ts) — a
 * pure file-organization move: these four handlers already formed a
 * cohesive, self-contained unit (single-session lifecycle actions), disjoint
 * from the message/steer/follow-up/task handlers that remain in the
 * original file.
 */
import { jsonErrorResponse } from './error-response.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { toSharedSessionRecordResponse } from './runtime-session-routes.js';

export async function handleGetSharedSession(context: DaemonRuntimeRouteContext, sessionId: string): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return jsonErrorResponse({ error: 'Unknown shared session' }, { status: 404 });
  }
  const messages = context.sessionBroker.getMessages(sessionId, 100);
  return Response.json({
    session: toSharedSessionRecordResponse(sessionId, session, { messageCount: messages.length }),
    messages,
  });
}

export async function handleSharedSessionLifecycle(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  action: 'close' | 'reopen',
): Promise<Response> {
  await context.sessionBroker.start();
  const session = action === 'close'
    ? await context.sessionBroker.closeSession(sessionId)
    : await context.sessionBroker.reopenSession(sessionId);
  return session
    ? Response.json({ session: toSharedSessionRecordResponse(sessionId, session, { status: action === 'close' ? 'closed' : 'active' }) })
    : jsonErrorResponse({ error: 'Unknown shared session' }, { status: 404 });
}

/**
 * DELETE /api/sessions/:sessionId (see CHANGELOG 1.0.0). Hard-removes the session record +
 * its messages/inputs — distinct from `close`, which preserves history.
 * Requires the session already closed: an active session yields an honest
 * 409 ('close it, then delete') rather than yanking state out from under a
 * live participant/agent. Idempotent-honest: an unknown OR already-deleted
 * id is a 404, never a 200-noop.
 */
export async function handleDeleteSharedSession(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
): Promise<Response> {
  await context.sessionBroker.start();
  const result = await context.sessionBroker.deleteSession(sessionId);
  if (result === 'not-found') {
    return jsonErrorResponse({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  if (result === 'active') {
    return jsonErrorResponse(
      { error: 'Session is active — close it, then delete.', code: 'SESSION_ACTIVE' },
      { status: 409 },
    );
  }
  return Response.json({ sessionId, deleted: true });
}

export async function handleSharedSessionDetach(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  req: Request,
): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  const payload = body ?? {};
  const surfaceId = typeof payload.surfaceId === 'string' ? payload.surfaceId.trim() : '';
  if (surfaceId.length === 0) {
    return jsonErrorResponse({ error: 'surfaceId is required.' }, { status: 400 });
  }
  await context.sessionBroker.start();
  const session = await context.sessionBroker.detachParticipant(sessionId, surfaceId);
  return session
    ? Response.json({ session: toSharedSessionRecordResponse(sessionId, session) })
    : jsonErrorResponse({ error: 'Unknown shared session' }, { status: 404 });
}
