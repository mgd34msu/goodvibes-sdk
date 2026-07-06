/**
 * method-catalog-control-companion.ts
 *
 * Companion-chat method catalog registration, split out of
 * method-catalog-control-core.ts (see CHANGELOG 1.0.0) to stay under the repo's 800-line
 * hand-authored file cap (see scripts/check-line-cap.ts) — this block is
 * self-contained (companion.chat.* descriptors only) and control.ts folds it
 * in unchanged, so this is a pure file-organization move with no API surface
 * change beyond the delete-honesty split it carries (companion.chat.sessions.close
 * as a distinct soft-close verb alongside a genuinely hard-deleting
 * companion.chat.sessions.delete).
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import {
  COMPANION_CHAT_MESSAGES_LIST_SCHEMA,
  COMPANION_CHAT_SESSION_SCHEMA,
  COMPANION_CHAT_SESSIONS_LIST_SCHEMA,
  COMPANION_CHAT_SESSION_WITH_MESSAGES_SCHEMA,
} from './operator-contract-schemas.js';

export const builtinGatewayControlCompanionMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'companion.chat.sessions.create',
    title: 'Create Companion Chat Session',
    description: 'Create a new companion-chat session. Optional `provider` / `model` override the registry default; `title` and `systemPrompt` are stored on the session record.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      model: STRING_SCHEMA,
      provider: STRING_SCHEMA,
      systemPrompt: STRING_SCHEMA,
    }, []),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      createdAt: NUMBER_SCHEMA,
      session: COMPANION_CHAT_SESSION_SCHEMA,
    }, ['sessionId', 'createdAt', 'session']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.list',
    title: 'List Companion Chat Sessions',
    description: 'List active companion-chat sessions. Pass `includeClosed` to include recently closed sessions.',
    category: 'companion',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/companion/chat/sessions' },
    inputSchema: objectSchema({
      includeClosed: BOOLEAN_SCHEMA,
      limit: NUMBER_SCHEMA,
    }, []),
    outputSchema: COMPANION_CHAT_SESSIONS_LIST_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.get',
    title: 'Get Companion Chat Session',
    description: 'Return a companion-chat session record together with its full message history.',
    category: 'companion',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: COMPANION_CHAT_SESSION_WITH_MESSAGES_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.update',
    title: 'Update Companion Chat Session',
    description: 'Update companion-chat session metadata, including session-local `provider` and `model`, without changing the daemon/TUI current model.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'PATCH', path: '/api/companion/chat/sessions/{sessionId}' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      model: STRING_SCHEMA,
      provider: STRING_SCHEMA,
      systemPrompt: STRING_SCHEMA,
    }, []),
    outputSchema: objectSchema({
      session: COMPANION_CHAT_SESSION_SCHEMA,
    }, ['session']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.close',
    title: 'Close Companion Chat Session',
    description: 'Close a companion-chat session (soft close). The session record and its messages are preserved in closed state and remain listable with includeClosed. Distinct from companion.chat.sessions.delete, which permanently removes the record.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/close' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      status: STRING_SCHEMA,
    }, ['sessionId', 'status']),
  }),
  methodDescriptor({
    id: 'companion.chat.sessions.delete',
    title: 'Delete Companion Chat Session',
    description: 'Permanently remove a companion-chat session: the on-disk record file is deleted and the session is dropped from the shared session store — this does NOT merely close it (use companion.chat.sessions.close for a soft close). Requires the session to already be closed: deleting a still-active session is rejected with 409 SESSION_ACTIVE (close it, then delete). An unknown or already-deleted id is a 404 SESSION_NOT_FOUND, never a 200-noop.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'DELETE', path: '/api/companion/chat/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'deleted']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.create',
    title: 'Send Companion Chat Message',
    description: 'Post a user message to a companion-chat session. Accepts either `body` or `content` in the payload; `body` wins when both are provided. Attachments reference artifacts created through `artifacts.create`.',
    category: 'companion',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    inputSchema: bodyEnvelopeSchema({
      body: STRING_SCHEMA,
      content: STRING_SCHEMA,
      attachments: arraySchema(objectSchema({
        artifactId: STRING_SCHEMA,
        label: STRING_SCHEMA,
        metadata: objectSchema({}, []),
      }, ['artifactId'])),
      metadata: objectSchema({}, []),
    }, []),
    outputSchema: objectSchema({
      messageId: STRING_SCHEMA,
    }, ['messageId']),
  }),
  methodDescriptor({
    id: 'companion.chat.messages.list',
    title: 'List Companion Chat Messages',
    description: 'Return the message list for a companion-chat session.',
    category: 'companion',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/messages' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: COMPANION_CHAT_MESSAGES_LIST_SCHEMA,
  }),
  methodDescriptor({
    id: 'companion.chat.events.stream',
    title: 'Stream Companion Chat Events',
    description: 'Server-Sent Events stream of turn and agent events scoped to a single companion-chat session.',
    category: 'companion',
    scopes: ['read:sessions'],
    transport: ['http'],
    http: { method: 'GET', path: '/api/companion/chat/sessions/{sessionId}/events' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: EMPTY_OBJECT_SCHEMA,
    invokable: false,
    metadata: { responseKind: 'sse', stream: true, wireEventPrefix: 'companion-chat.' },
  }),
];
