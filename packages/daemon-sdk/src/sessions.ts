import type { DaemonSessionRouteHandlers } from './context.js';

export async function dispatchSessionRoutes(
  req: Request,
  handlers: DaemonSessionRouteHandlers,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/sessions' && method === 'GET') return handlers.getIntegrationSessions();
  if (pathname === '/api/sessions/register' && method === 'POST') return handlers.registerSharedSession(req);
  if (pathname === '/api/sessions' && method === 'POST') return handlers.createSharedSession(req);

  const sharedSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sharedSessionMatch && method === 'GET') return handlers.getSharedSession(sharedSessionMatch[1]!);

  const sharedSessionLifecycleMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen|detach)$/);
  if (sharedSessionLifecycleMatch && method === 'POST') {
    const [, sessionId, action] = sharedSessionLifecycleMatch;
    if (action === 'close') return handlers.closeSharedSession(sessionId!, req);
    if (action === 'reopen') return handlers.reopenSharedSession(sessionId!, req);
    return handlers.detachSharedSession(sessionId!, req);
  }

  const sharedSessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sharedSessionMessagesMatch && method === 'GET') return handlers.getSharedSessionMessages(sharedSessionMessagesMatch[1]!, url);
  if (sharedSessionMessagesMatch && method === 'POST') return handlers.postSharedSessionMessage(sharedSessionMessagesMatch[1]!, req);

  const sharedSessionInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
  if (sharedSessionInputsMatch && method === 'GET') return handlers.getSharedSessionInputs(sharedSessionInputsMatch[1]!, url);

  const sharedSessionSteerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (sharedSessionSteerMatch && method === 'POST') return handlers.postSharedSessionSteer(sharedSessionSteerMatch[1]!, req);

  const sharedSessionFollowUpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
  if (sharedSessionFollowUpMatch && method === 'POST') return handlers.postSharedSessionFollowUp(sharedSessionFollowUpMatch[1]!, req);

  const sharedSessionCancelInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/cancel$/);
  if (sharedSessionCancelInputMatch && method === 'POST') {
    return handlers.cancelSharedSessionInput(sharedSessionCancelInputMatch[1]!, sharedSessionCancelInputMatch[2]!, req);
  }

  const sharedSessionDeliverInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/deliver$/);
  if (sharedSessionDeliverInputMatch && method === 'POST') {
    return handlers.deliverSharedSessionInput(sharedSessionDeliverInputMatch[1]!, sharedSessionDeliverInputMatch[2]!, req);
  }

  const sharedSessionEventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (sharedSessionEventsMatch && method === 'GET') return handlers.getSharedSessionEvents(sharedSessionEventsMatch[1]!, req);

  return null;
}
