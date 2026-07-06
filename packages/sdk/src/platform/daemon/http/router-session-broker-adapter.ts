/**
 * router-session-broker-adapter.ts
 *
 * Adapts the real `SharedSessionBroker` to the narrow structural shape
 * `createDaemonRuntimeRouteHandlers` (runtime-routes.ts) expects on its
 * `sessionBroker` context field. Split out of router.ts (W5-S1) to stay under
 * the repo's grandfathered line-cap ceiling (see scripts/check-line-cap.ts) —
 * this is a pure file-organization move, not a behavior change.
 */
import type { SharedSessionBroker } from '../../control-plane/index.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export function buildRouterSessionBrokerAdapter(
  sessionBroker: SharedSessionBroker,
): DaemonRuntimeRouteContext['sessionBroker'] {
  return {
    start: () => sessionBroker.start(),
    submitMessage: (input) => sessionBroker.submitMessage(
      input as Parameters<SharedSessionBroker['submitMessage']>[0],
    ) as never,
    steerMessage: (input) => sessionBroker.steerMessage(
      input as Parameters<SharedSessionBroker['steerMessage']>[0],
    ) as never,
    followUpMessage: (input) => sessionBroker.followUpMessage(
      input as Parameters<SharedSessionBroker['followUpMessage']>[0],
    ) as never,
    bindAgent: async (sessionId, agentId) => {
      await sessionBroker.bindAgent(sessionId, agentId);
    },
    createSession: (input) => sessionBroker.createSession(
      input as Parameters<SharedSessionBroker['createSession']>[0],
    ),
    register: (input) => sessionBroker.register(input as Parameters<SharedSessionBroker['register']>[0]),
    getSession: (sessionId) => sessionBroker.getSession(sessionId) as never,
    getMessages: (sessionId, limit) => sessionBroker.getMessages(sessionId, limit),
    getInputs: (sessionId, limit) => sessionBroker.getInputs(sessionId, limit),
    getInputsSince: (sessionId, options) => sessionBroker.getInputsSince(
      sessionId,
      options as Parameters<SharedSessionBroker['getInputsSince']>[1],
    ),
    markInputDelivered: (sessionId, inputId, options) => sessionBroker.markInputDelivered(sessionId, inputId, options),
    closeSession: (sessionId) => sessionBroker.closeSession(sessionId),
    reopenSession: (sessionId) => sessionBroker.reopenSession(sessionId),
    detachParticipant: (sessionId, surfaceId) => sessionBroker.detachParticipant(sessionId, surfaceId) as never,
    deleteSession: (sessionId) => sessionBroker.deleteSession(sessionId),
    cancelInput: (sessionId, inputId) => sessionBroker.cancelInput(sessionId, inputId),
    completeAgent: async (sessionId, agentId, message, meta) => {
      await sessionBroker.completeAgent(sessionId, agentId, message, meta);
    },
    appendCompanionMessage: (sessionId, input) =>
      sessionBroker.appendCompanionMessage(sessionId, input),
  };
}
