/**
 * routes/rewind-conversation-hosts.ts — the surface-facing half of
 * conversation-scope rewind.
 *
 * `rewind.plan` and `rewind.apply` (routes/rewind.ts) are the CALLER's side:
 * anyone with the scopes can ask for a rewind of any session. These five verbs
 * are the other side, and only one kind of caller uses them — the surface that
 * is actually running a session's conversation. It offers that conversation,
 * takes the questions the daemon puts to it, and answers them.
 *
 * Why a surface has to be involved at all: the workspace checkpoint store is
 * the daemon's, so files rewind works from anywhere, but the messages live in
 * whichever process runs the loop. Once the surfaces became pure clients that
 * process is not the daemon, and the daemon's in-process conversation registry
 * — which nothing outside the daemon could populate — answered "0 messages to
 * drop" for every one of them. The mechanics of the offer, the lease and the
 * bounded wait are in platform/rewind/conversation-host-broker.ts; this module
 * is the wire shape and the honest refusals.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  CONVERSATION_ANSWER_TIMEOUT_MS,
  CONVERSATION_HOST_MAX_WAIT_MS,
  ConversationRewindHostBroker,
  ConversationRewindHostError,
  type ConversationRewindAnswer,
  type ConversationRewindHostBrokerOptions,
  type ConversationRewindRequestKind,
} from '../../rewind/conversation-host-broker.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** Build the broker the verbs and the rewind service share. */
export function createConversationRewindHostBroker(
  options: ConversationRewindHostBrokerOptions = {},
): ConversationRewindHostBroker {
  return new ConversationRewindHostBroker(options);
}

function requireString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400, field);
  }
  return text;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GatewayVerbError(`Invalid ${field}: expected a number`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new GatewayVerbError(`Invalid ${field}: expected a whole number of messages, zero or more`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

/**
 * Every broker refusal is about the caller's input — a host id that is not the
 * host, a request that is no longer waiting — so each carries the field it is
 * about and a 409: the call was well-formed, the world had moved on.
 */
function asVerbError(error: unknown): never {
  if (error instanceof ConversationRewindHostError) {
    throw new GatewayVerbError(error.message, 'CONFLICT', 409, error.field);
  }
  throw error;
}

/**
 * Read the answer a host is reporting, in the shape the REQUEST calls for.
 *
 * The kind comes from the request the broker raised, never from the caller. An
 * answer that restated it could only ever disagree with it, and the disagreement
 * would be silent — a preview answer accepted for a rewind request would report
 * a truncation that never happened.
 */
function readAnswer(
  params: Record<string, unknown>,
  kind: ConversationRewindRequestKind,
): ConversationRewindAnswer {
  // Checked first, and for either kind: a surface that cannot serve the request
  // says so, and saying so is more useful than any number it could invent.
  const unavailableReason = typeof params.unavailableReason === 'string' ? params.unavailableReason.trim() : '';
  if (unavailableReason) return { kind: 'unavailable', reason: unavailableReason };

  if (kind === 'preview') {
    return {
      kind: 'preview',
      messagesToDrop: requireCount(params.messagesToDrop, 'messagesToDrop'),
      messagesRemaining: requireCount(params.messagesRemaining, 'messagesRemaining'),
    };
  }
  return {
    kind: 'rewind',
    droppedMessages: requireCount(params.droppedMessages, 'droppedMessages'),
    undoSnapshotId: requireString(params.undoSnapshotId, 'undoSnapshotId'),
  };
}

export function createConversationHostRegisterHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireString(params.sessionId, 'sessionId');
    const hostId = typeof params.hostId === 'string' ? params.hostId.trim() : '';
    const label = typeof params.label === 'string' ? params.label.trim() : '';
    const leaseMs = optionalNumber(params.leaseMs, 'leaseMs');
    try {
      const host = broker.registerHost({
        sessionId,
        ...(hostId ? { hostId } : {}),
        ...(label ? { label } : {}),
        ...(leaseMs === undefined ? {} : { leaseMs }),
      });
      return {
        host,
        renewed: hostId.length > 0,
        maxWaitMs: CONVERSATION_HOST_MAX_WAIT_MS,
        answerTimeoutMs: CONVERSATION_ANSWER_TIMEOUT_MS,
      };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationHostReleaseHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireString(params.sessionId, 'sessionId');
    const hostId = requireString(params.hostId, 'hostId');
    try {
      return { released: true, host: broker.releaseHost({ sessionId, hostId }) };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationHostsListHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return () => ({ hosts: broker.listHosts() });
}

export function createConversationRequestsTakeHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const hostId = requireString(params.hostId, 'hostId');
    const waitMs = optionalNumber(params.waitMs, 'waitMs');
    const limit = optionalNumber(params.limit, 'limit');
    try {
      const taken = await broker.takeRequests({
        hostId,
        ...(waitMs === undefined ? {} : { waitMs }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { requests: taken.requests, host: taken.host };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationRequestsAnswerHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const hostId = requireString(params.hostId, 'hostId');
    const requestId = requireString(params.requestId, 'requestId');
    // Which request this is — and whether this surface may answer it at all —
    // is settled before the payload is read, so a caller answering something
    // that is no longer waiting is told that, rather than being marched through
    // a field check for a question nobody is listening to.
    let kind: ConversationRewindRequestKind;
    try {
      kind = broker.describeRequest({ hostId, requestId }).kind;
    } catch (error) {
      asVerbError(error);
    }
    const answer = readAnswer(params, kind);
    try {
      return { accepted: true, request: broker.answerRequest({ hostId, requestId, answer }) };
    } catch (error) {
      asVerbError(error);
    }
  };
}

/** Attach the conversation-host handlers to their descriptors (missing = no-op). */
export function registerRewindConversationHostGatewayMethods(
  catalog: GatewayMethodCatalog,
  broker: ConversationRewindHostBroker,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('rewind.conversation.host.register', createConversationHostRegisterHandler(broker));
  attach('rewind.conversation.host.release', createConversationHostReleaseHandler(broker));
  attach('rewind.conversation.hosts.list', createConversationHostsListHandler(broker));
  attach('rewind.conversation.requests.take', createConversationRequestsTakeHandler(broker));
  attach('rewind.conversation.requests.answer', createConversationRequestsAnswerHandler(broker));
}
