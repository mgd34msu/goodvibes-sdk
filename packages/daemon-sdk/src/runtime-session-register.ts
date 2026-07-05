import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { jsonErrorResponse } from './error-response.js';
import { isJsonRecord } from './route-helpers.js';
import { toSharedSessionRecordResponse } from './runtime-session-routes.js';

const SESSION_KINDS = new Set([
  'tui',
  'agent',
  'webui',
  'companion-task',
  'companion-chat',
  'automation',
]);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Handle POST /api/sessions/register — the idempotent registration + heartbeat
 * upsert keyed on a caller-supplied `sessionId`. Requires a participant triple
 * {surfaceKind, surfaceId, userId?}; carries the identity spine (kind + project)
 * onto the record. Re-calling with the same id advances participant.lastSeenAt.
 */
export async function handleRegisterSharedSession(
  context: DaemonRuntimeRouteContext,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;

  const sessionId = readString(body.sessionId);
  if (!sessionId) {
    return jsonErrorResponse({ error: 'sessions.register requires a non-empty sessionId.' }, { status: 400 });
  }

  const participantInput = isJsonRecord(body.participant) ? body.participant : undefined;
  const surfaceKind = participantInput ? readString(participantInput.surfaceKind) : undefined;
  const surfaceId = participantInput ? readString(participantInput.surfaceId) : undefined;
  if (!surfaceKind || !surfaceId) {
    return jsonErrorResponse(
      { error: 'sessions.register requires a participant with surfaceKind and surfaceId.' },
      { status: 400 },
    );
  }

  await context.sessionBroker.start();

  const kind = readString(body.kind);
  const session = await context.sessionBroker.register({
    sessionId,
    ...(kind && SESSION_KINDS.has(kind) ? { kind } : {}),
    ...(readString(body.project) ? { project: readString(body.project) } : {}),
    ...(readString(body.title) ? { title: readString(body.title) } : {}),
    participant: {
      surfaceKind,
      surfaceId,
      ...(readString(participantInput?.externalId) ? { externalId: readString(participantInput?.externalId) } : {}),
      ...(readString(participantInput?.userId) ? { userId: readString(participantInput?.userId) } : {}),
      ...(readString(participantInput?.displayName) ? { displayName: readString(participantInput?.displayName) } : {}),
      ...(readString(participantInput?.routeId) ? { routeId: readString(participantInput?.routeId) } : {}),
      lastSeenAt: Date.now(),
    },
  });

  return context.recordApiResponse(req, '/api/sessions/register', Response.json({
    session: toSharedSessionRecordResponse(session.id, session),
  }, { status: 200 }));
}
