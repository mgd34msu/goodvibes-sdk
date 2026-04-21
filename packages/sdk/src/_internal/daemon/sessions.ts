// Synced from packages/daemon-sdk/src/sessions.ts
import type { DaemonApiRouteHandlers } from './context.js';

export async function dispatchSessionRoutes(
  req: Request,
  handlers: Pick<
    DaemonApiRouteHandlers,
    | 'getIntegrationSessions'
    | 'createSharedSession'
    | 'getSharedSession'
    | 'closeSharedSession'
    | 'reopenSharedSession'
    | 'getSharedSessionMessages'
    | 'postSharedSessionMessage'
    | 'getSharedSessionInputs'
    | 'postSharedSessionInput'
    | 'postSharedSessionSteer'
    | 'postSharedSessionFollowUp'
    | 'cancelSharedSessionInput'
    | 'getSharedSessionEvents'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/sessions' && method === 'GET') return handlers.getIntegrationSessions();
  if (pathname === '/api/sessions' && method === 'POST') return handlers.createSharedSession(req);

  const sharedSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sharedSessionMatch && method === 'GET') return handlers.getSharedSession(sharedSessionMatch[1]);

  const sharedSessionCloseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen)$/);
  if (sharedSessionCloseMatch && method === 'POST') {
    return sharedSessionCloseMatch[2] === 'close'
      ? handlers.closeSharedSession(sharedSessionCloseMatch[1])
      : handlers.reopenSharedSession(sharedSessionCloseMatch[1]);
  }

  const sharedSessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sharedSessionMessagesMatch && method === 'GET') return handlers.getSharedSessionMessages(sharedSessionMessagesMatch[1], url);
  if (sharedSessionMessagesMatch && method === 'POST') return handlers.postSharedSessionMessage(sharedSessionMessagesMatch[1], req);

  const sharedSessionInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
  if (sharedSessionInputsMatch && method === 'GET') return handlers.getSharedSessionInputs(sharedSessionInputsMatch[1], url);
  // F20 restoration (SDK 0.21.36): `POST /api/sessions/:id/inputs` is an intent-dispatching
  // alias that accepts an optional `intent` field in the body ('submit' | 'steer' | 'follow-up'),
  // defaulting to 'submit'. Restored for API surface parity after 0.21.35 removed the direct
  // input-create endpoint in favor of `POST /messages` / `POST /steer` / `POST /follow-up`.
  if (sharedSessionInputsMatch && method === 'POST') return handlers.postSharedSessionInput(sharedSessionInputsMatch[1], req);

  const sharedSessionSteerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (sharedSessionSteerMatch && method === 'POST') return handlers.postSharedSessionSteer(sharedSessionSteerMatch[1], req);

  const sharedSessionFollowUpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
  if (sharedSessionFollowUpMatch && method === 'POST') return handlers.postSharedSessionFollowUp(sharedSessionFollowUpMatch[1], req);

  const sharedSessionCancelInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/cancel$/);
  if (sharedSessionCancelInputMatch && method === 'POST') {
    return handlers.cancelSharedSessionInput(sharedSessionCancelInputMatch[1], sharedSessionCancelInputMatch[2]);
  }

  const sharedSessionEventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (sharedSessionEventsMatch && method === 'GET') return handlers.getSharedSessionEvents(sharedSessionEventsMatch[1], req);

  return null;
}
