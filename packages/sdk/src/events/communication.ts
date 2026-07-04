/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * CommunicationEvent — typed runtime events for structured agent communication.
 */

export type CommunicationKind =
  | 'directive'
  | 'status'
  | 'question'
  | 'finding'
  | 'review'
  | 'handoff'
  | 'escalation'
  | 'completion'
  /**
   * Wave-3 steering: an operator (human)-originated message queued for a
   * live in-process agent via `ProcessRegistry.steer()`. Framed verbatim as
   * a user turn at the drain site (orchestrator-runner.ts), not wrapped in
   * the `[Kind from sender]` inter-agent directive framing.
   */
  | 'steer';

export type CommunicationScope = 'direct' | 'broadcast';

export type CommunicationEvent =
  | {
      type: 'COMMUNICATION_SENT';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      content: string;
      fromRole?: string | undefined;
      toRole?: string | undefined;
      cohort?: string | undefined;
      wrfcId?: string | undefined;
      parentAgentId?: string | undefined;
    }
  | {
      type: 'COMMUNICATION_DELIVERED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
    }
  | {
      type: 'COMMUNICATION_BLOCKED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      reason: string;
      fromRole?: string | undefined;
      toRole?: string | undefined;
      cohort?: string | undefined;
      wrfcId?: string | undefined;
      parentAgentId?: string | undefined;
    }
  | {
      /**
       * Honest "the agent actually consumed this at its turn boundary" signal —
       * distinct from COMMUNICATION_DELIVERED, which fires eagerly at send()
       * time and therefore cannot mean "seen by the agent" (see
       * AgentMessageBus.send / orchestrator-runner's per-turn inbox drain).
       * Emitted once, at the drain site, the turn a queued message is
       * actually injected into the target agent's conversation.
       */
      type: 'COMMUNICATION_CONSUMED';
      messageId: string;
      agentId: string;
      turn: number;
    };

export type CommunicationEventType = CommunicationEvent['type'];
