import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { jsonErrorResponse } from './error-response.js';
import { isJsonRecord } from './route-helpers.js';
import { toSharedSessionRecordResponse, SHARED_SESSION_KINDS, type SharedSessionRecordResponse } from './runtime-session-routes.js';

type RegisterKind = SharedSessionRecordResponse['kind'];

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

  // Honest input validation: an unknown session kind is a 400, NOT a silent
  // coercion to 'tui'. Absent kind is allowed (the broker defaults it).
  const kindRaw = readString(body.kind);
  if (kindRaw !== undefined && !SHARED_SESSION_KINDS.has(kindRaw as RegisterKind)) {
    return jsonErrorResponse(
      { error: `sessions.register: unknown session kind '${kindRaw}'. Expected one of: ${[...SHARED_SESSION_KINDS].join(', ')}.` },
      { status: 400 },
    );
  }

  await context.sessionBroker.start();

  const reopen = body.reopen === true;
  const result = await context.sessionBroker.register({
    sessionId,
    ...(kindRaw ? { kind: kindRaw as RegisterKind } : {}),
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
    ...(reopen ? { reopen: true } : {}),
  });

  return context.recordApiResponse(req, '/api/sessions/register', Response.json({
    session: toSharedSessionRecordResponse(result.record.id, result.record),
    reopened: result.reopened,
    ...(result.conflict ? { conflict: result.conflict } : {}),
  }, { status: 200 }));
}
