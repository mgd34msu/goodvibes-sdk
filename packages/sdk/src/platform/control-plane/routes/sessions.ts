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
    | 'postSharedSessionSteer'
    | 'postSharedSessionFollowUp'
    | 'cancelSharedSessionInput'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/sessions' && method === 'GET') return handlers.getIntegrationSessions();
  if (pathname === '/api/sessions' && method === 'POST') return handlers.createSharedSession(req);

  const sharedSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sharedSessionMatch && method === 'GET' && sharedSessionMatch[1]) return handlers.getSharedSession(sharedSessionMatch[1]);

  const sharedSessionCloseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen)$/);
  if (sharedSessionCloseMatch && method === 'POST') {
    const [, sessionId, action] = sharedSessionCloseMatch;
    if (!sessionId) return null;
    return action === 'close'
      ? handlers.closeSharedSession(sessionId, req)
      : handlers.reopenSharedSession(sessionId, req);
  }

  const sharedSessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sharedSessionMessagesMatch && method === 'GET' && sharedSessionMessagesMatch[1]) return handlers.getSharedSessionMessages(sharedSessionMessagesMatch[1], url);
  if (sharedSessionMessagesMatch && method === 'POST' && sharedSessionMessagesMatch[1]) return handlers.postSharedSessionMessage(sharedSessionMessagesMatch[1], req);

  const sharedSessionInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
  if (sharedSessionInputsMatch && method === 'GET' && sharedSessionInputsMatch[1]) return handlers.getSharedSessionInputs(sharedSessionInputsMatch[1], url);

  const sharedSessionSteerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (sharedSessionSteerMatch && method === 'POST' && sharedSessionSteerMatch[1]) return handlers.postSharedSessionSteer(sharedSessionSteerMatch[1], req);

  const sharedSessionFollowUpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
  if (sharedSessionFollowUpMatch && method === 'POST' && sharedSessionFollowUpMatch[1]) return handlers.postSharedSessionFollowUp(sharedSessionFollowUpMatch[1], req);

  const sharedSessionCancelInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/cancel$/);
  if (sharedSessionCancelInputMatch && method === 'POST') {
    const [, sessionId, inputId] = sharedSessionCancelInputMatch;
    if (!sessionId || !inputId) return null;
    return handlers.cancelSharedSessionInput(sessionId, inputId, req);
  }

  return null;
}
