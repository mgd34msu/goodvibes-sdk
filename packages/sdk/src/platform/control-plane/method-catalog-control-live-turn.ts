/**
 * method-catalog-control-live-turn.ts — the live-turn session verbs: cancel ONE
 * in-flight tool call, and list/edit/delete the pending mid-turn message queue.
 *
 * These act on the daemon's live local runtime through the bound
 * SessionLiveTurnControls (routes/session-runtime.ts). A per-call cancel is
 * deliberately distinct from a whole-turn interrupt: the cancelled call settles
 * as a structured "cancelled by user" tool result and the turn continues.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
  runtimeEventId,
} from './method-catalog-shared.js';

export const builtinGatewayControlLiveTurnMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'sessions.toolCalls.cancel',
    title: 'Cancel One In-Flight Tool Call',
    description: 'Cancel a single running tool call by its callId, leaving the turn and any other running calls untouched. The cancelled call settles as a structured "cancelled by user" tool result the model adapts to in the same turn — distinct from a whole-turn interrupt. Only the daemon\'s live local runtime session is controllable; any other session id is a 404 SESSION_NOT_LOCAL, and an unknown or already-settled callId is a 404 TOOL_CALL_NOT_RUNNING.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions/{sessionId}/tool-calls/{callId}/cancel' },
    events: [runtimeEventId('tools')],
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      callId: STRING_SCHEMA,
    }, ['sessionId', 'callId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      callId: STRING_SCHEMA,
      cancelled: BOOLEAN_SCHEMA,
    }, ['sessionId', 'callId', 'cancelled']),
  }),
  methodDescriptor({
    id: 'sessions.queuedMessages.list',
    title: 'List Queued Mid-Turn Messages',
    description: 'List the messages queued behind the current turn (submitted while the model was thinking), in delivery order. Queued messages remain editable and deletable until they are delivered; a delivered message no longer appears here. Only the daemon\'s live local runtime session is resolvable; any other session id is a 404 SESSION_NOT_LOCAL.',
    category: 'sessions',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/sessions/{sessionId}/queued-messages' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messages: {
        type: 'array',
        items: objectSchema({
          id: STRING_SCHEMA,
          queuedAt: NUMBER_SCHEMA,
          text: STRING_SCHEMA,
        }, ['id', 'queuedAt', 'text']),
      },
    }, ['sessionId', 'messages']),
  }),
  methodDescriptor({
    id: 'sessions.queuedMessages.edit',
    title: 'Edit a Queued Mid-Turn Message',
    description: 'Replace the text of a message still waiting in the mid-turn queue. A message already delivered to the model is immutable — editing it is a 404 MESSAGE_NOT_QUEUED. Editing replaces any multimodal content with the new plain text. Only the daemon\'s live local runtime session is controllable; any other session id is a 404 SESSION_NOT_LOCAL.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions/{sessionId}/queued-messages/{messageId}' },
    events: [runtimeEventId('session')],
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
      text: STRING_SCHEMA,
    }, ['sessionId', 'messageId', 'text']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      id: STRING_SCHEMA,
      text: STRING_SCHEMA,
    }, ['sessionId', 'id', 'text']),
  }),
  methodDescriptor({
    id: 'sessions.queuedMessages.delete',
    title: 'Delete a Queued Mid-Turn Message',
    description: 'Remove a message still waiting in the mid-turn queue so it is never delivered. A message already delivered to the model cannot be removed — deleting it is a 404 MESSAGE_NOT_QUEUED. Only the daemon\'s live local runtime session is controllable; any other session id is a 404 SESSION_NOT_LOCAL.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'DELETE', path: '/api/sessions/{sessionId}/queued-messages/{messageId}' },
    events: [runtimeEventId('session')],
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      messageId: STRING_SCHEMA,
    }, ['sessionId', 'messageId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      id: STRING_SCHEMA,
      deleted: BOOLEAN_SCHEMA,
    }, ['sessionId', 'id', 'deleted']),
  }),
];
