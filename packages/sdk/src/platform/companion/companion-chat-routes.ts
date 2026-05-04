/**
 * companion-chat-routes.ts
 *
 * HTTP route handlers for the companion-app chat-mode API.
 *
 * Routes:
 *   POST   /api/companion/chat/sessions
 *   GET    /api/companion/chat/sessions/:sessionId
 *   PATCH  /api/companion/chat/sessions/:sessionId
 *   DELETE /api/companion/chat/sessions/:sessionId
 *   POST   /api/companion/chat/sessions/:sessionId/messages
 *   GET    /api/companion/chat/sessions/:sessionId/messages
 *   GET    /api/companion/chat/sessions/:sessionId/events  (SSE)
 *
 * All routes require the existing daemon bearer-token auth (enforced by the
 * caller — DaemonHttpRouter.handleRequest already validates auth before
 * dispatching to API routes).
 */

import type {
  CreateCompanionChatSessionInput,
  PostCompanionChatMessageInput,
  UpdateCompanionChatSessionInput,
} from './companion-chat-types.js';
import type { CompanionChatRouteContext } from './companion-chat-route-types.js';

// ---------------------------------------------------------------------------
// Route dispatch — called from DaemonHttpRouter.dispatchApiRoutes
// ---------------------------------------------------------------------------

/**
 * Try to handle a companion chat route. Returns null if the path/method
 * does not match, so the caller can fall through to other route groups.
 */
export async function dispatchCompanionChatRoutes(
  req: Request,
  context: CompanionChatRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // POST /api/companion/chat/sessions
  if (pathname === '/api/companion/chat/sessions' && req.method === 'POST') {
    return handleCreateSession(req, context);
  }

  const sessionMatch = pathname.match(
    /^\/api\/companion\/chat\/sessions\/([^/]+)(\/(.+))?$/,
  );
  if (!sessionMatch) return null;

  const sessionId = sessionMatch[1]!;
  const sub = sessionMatch[3]! ?? '';

  // GET /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'GET') {
    return handleGetSession(sessionId, context);
  }

  // PATCH /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'PATCH') {
    return handleUpdateSession(req, sessionId, context);
  }

  // DELETE /api/companion/chat/sessions/:sessionId
  if (!sub && req.method === 'DELETE') {
    return handleDeleteSession(sessionId, context);
  }

  // POST /api/companion/chat/sessions/:sessionId/messages
  if (sub === 'messages' && req.method === 'POST') {
    return handlePostMessage(req, sessionId, context);
  }

  // F21 restoration (SDK 0.21.36): GET /api/companion/chat/sessions/:sessionId/messages
  // returns the message list directly (previously only reachable via the session-detail
  // endpoint's embedded `messages` field). Restored for consumer parity — clients that
  // enumerate messages independently of the session record can hit this path.
  if (sub === 'messages' && req.method === 'GET') {
    return handleGetMessages(sessionId, context);
  }

  // GET /api/companion/chat/sessions/:sessionId/events
  if (sub === 'events' && req.method === 'GET') {
    return handleGetEvents(req, sessionId, context);
  }

  return null;
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions
// ---------------------------------------------------------------------------

async function handleCreateSession(
  req: Request,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseOptionalJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = (bodyOrResponse ?? {}) as Record<string, unknown>;
  // Resolve provider/model from registry if caller did not specify them.
  const shouldResolveDefaults = typeof body['model'] !== 'string' || typeof body['provider'] !== 'string';
  const hasDefaultResolver = typeof context.resolveDefaultProviderModel === 'function';
  const resolvedDefaults = hasDefaultResolver && shouldResolveDefaults
    ? (context.resolveDefaultProviderModel?.() ?? null)
    : null;

  const input: CreateCompanionChatSessionInput = {
    title: typeof body['title'] === 'string' ? body['title'] : undefined,
    model: typeof body['model'] === 'string' ? body['model'] : (resolvedDefaults?.model ?? undefined),
    provider: typeof body['provider'] === 'string' ? body['provider'] : (resolvedDefaults?.provider ?? undefined),
    systemPrompt: typeof body['systemPrompt'] === 'string' ? body['systemPrompt'] : undefined,
  };

  if (shouldResolveDefaults
    && (!input.provider || !input.model)
    && (hasDefaultResolver || Object.keys(body).length === 0)) {
    return Response.json(
      { error: 'No provider or model configured. Set a current model before creating a companion chat session.', code: 'NO_MODEL_CONFIGURED' },
      { status: 400 },
    );
  }

  const session = context.chatManager.createSession(input);
  return Response.json(
    { sessionId: session.id, createdAt: session.createdAt },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId
// ---------------------------------------------------------------------------

async function handleGetSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  const messages = context.chatManager.getMessages(sessionId);
  return Response.json({ session, messages });
}

// ---------------------------------------------------------------------------
// PATCH /api/companion/chat/sessions/:sessionId
// ---------------------------------------------------------------------------

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function readOptionalNonEmptyString(
  body: Record<string, unknown>,
  key: string,
): string | Response | undefined {
  if (!hasOwn(body, key)) return undefined;
  const value = body[key]!;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return Response.json(
      { error: `${key} must be a non-empty string`, code: 'INVALID_INPUT' },
      { status: 400 },
    );
  }
  return value.trim();
}

function readOptionalSystemPrompt(
  body: Record<string, unknown>,
): string | null | Response | undefined {
  if (!hasOwn(body, 'systemPrompt')) return undefined;
  const value = body['systemPrompt'];
  if (value === null) return null;
  if (typeof value !== 'string') {
    return Response.json(
      { error: 'systemPrompt must be a string or null', code: 'INVALID_INPUT' },
      { status: 400 },
    );
  }
  return value;
}

async function handleUpdateSession(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = bodyOrResponse as Record<string, unknown>;
  const input: UpdateCompanionChatSessionInput = {};

  const title = readOptionalNonEmptyString(body, 'title');
  if (title instanceof Response) return title;
  if (title !== undefined) (input as { title?: string }).title = title;

  const model = readOptionalNonEmptyString(body, 'model');
  if (model instanceof Response) return model;
  if (model !== undefined) {
    (input as { model?: string }).model = model;
    if (!hasOwn(body, 'provider') && model.includes(':')) {
      const providerId = model.split(':')[0];
      if (providerId) (input as { provider?: string }).provider = providerId;
    }
  }

  const provider = readOptionalNonEmptyString(body, 'provider');
  if (provider instanceof Response) return provider;
  if (provider !== undefined) (input as { provider?: string }).provider = provider;

  const systemPrompt = readOptionalSystemPrompt(body);
  if (systemPrompt instanceof Response) return systemPrompt;
  if (systemPrompt !== undefined) (input as { systemPrompt?: string | null }).systemPrompt = systemPrompt;

  if (Object.keys(input).length === 0) {
    return Response.json(
      { error: 'At least one of title, provider, model, or systemPrompt is required', code: 'INVALID_INPUT' },
      { status: 400 },
    );
  }

  try {
    const session = context.chatManager.updateSession(sessionId, input);
    return Response.json({ session });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    const status = e.status ?? 500;
    return Response.json(
      { error: e.message ?? 'Internal error', code: e.code ?? 'INTERNAL_ERROR' },
      { status },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/companion/chat/sessions/:sessionId
// ---------------------------------------------------------------------------

async function handleDeleteSession(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.closeSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  return Response.json({ sessionId: session.id, status: session.status });
}

// ---------------------------------------------------------------------------
// F13 field normalization helper
// ---------------------------------------------------------------------------

/**
 * Read the message content from an incoming POST body.
 *
 * F13 normalization: accepts both 'body' and 'content' field names;
 * prefers 'body' when both are present (shared-session canonical field);
 * falls back to 'content' for companion-chat clients that send content.
 * Returns empty string when neither field is present — the caller must
 * check for empty and return 400 INVALID_INPUT.
 *
 * @param body - Parsed JSON body from the request.
 * @returns Raw (un-trimmed) string value, or '' if neither field is present.
 */
export function readCompanionChatMessageBody(body: Record<string, unknown>): string {
  return typeof body['body'] === 'string'
    ? body['body']
    : typeof body['content'] === 'string'
      ? body['content']
      : '';
}

// ---------------------------------------------------------------------------
// POST /api/companion/chat/sessions/:sessionId/messages
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/companion/chat/sessions/:sessionId/messages.
 *
 * Accepts either `{body}` or `{content}` in the request payload.
 * If both are present, `{body}` takes precedence (shared-session canonical field).
 * Returns 400 INVALID_INPUT when neither field is present or both are empty.
 */
async function handlePostMessage(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const bodyOrResponse = await context.parseJsonBody(req);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;

  const body = bodyOrResponse as Record<string, unknown>;
  // F13: accept both 'body' and 'content' field names; prefer 'body' if both are present
  // (shared-session canonical uses 'body'; companion-chat clients may send 'content').
  const rawContent =
    typeof body['body'] === 'string'
      ? body['body']
      : typeof body['content'] === 'string'
        ? body['content']
        : '';
  const input: PostCompanionChatMessageInput = {
    content: rawContent,
    metadata: typeof body['metadata'] === 'object' && body['metadata'] !== null
      ? (body['metadata'] as Record<string, unknown>)
      : undefined,
  };

  if (!input.content.trim()) {
    return Response.json(
      { error: 'content or body is required and must be a non-empty string', code: 'INVALID_INPUT' },
      { status: 400 },
    );
  }

  try {
    const messageId = await context.chatManager.postMessage(sessionId, input.content);
    return Response.json({ messageId }, { status: 202 });
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; message?: string };
    const status = e.status ?? 500;
    return Response.json(
      { error: e.message ?? 'Internal error', code: e.code ?? 'INTERNAL_ERROR' },
      { status },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId/messages
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/companion/chat/sessions/:sessionId/messages.
 *
 * F21 restoration: returns the message list for a companion-chat session.
 * Response shape matches the `messages` field of the session-detail endpoint
 * so clients can substitute one for the other.
 */
async function handleGetMessages(
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  const messages = context.chatManager.getMessages(sessionId);
  return Response.json({ sessionId, messages });
}

// ---------------------------------------------------------------------------
// GET /api/companion/chat/sessions/:sessionId/events  (SSE)
// ---------------------------------------------------------------------------

async function handleGetEvents(
  req: Request,
  sessionId: string,
  context: CompanionChatRouteContext,
): Promise<Response> {
  const session = context.chatManager.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  if (session.status === 'closed') {
    return Response.json(
      { error: 'Session is closed', code: 'SESSION_CLOSED' },
      { status: 410 },
    );
  }

  // Delegate to the caller-provided SSE stream opener which wires up the
  // gateway live-client registration and returns an SSE Response.
  return context.openSessionEventStream(req, sessionId);
}
