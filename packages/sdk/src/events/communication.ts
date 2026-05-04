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
  | 'completion';

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
    };

export type CommunicationEventType = CommunicationEvent['type'];
