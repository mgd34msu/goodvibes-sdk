/**
 * companion-chat-broker-bridge.ts
 *
 * The narrow, structural view of the SharedSessionBroker that CompanionChatManager
 * uses to register companion sessions INTO the one shared session store at write
 * time (S1 item D: companion registers into the broker). Defined structurally so
 * the companion package does not take a hard dependency on the control-plane
 * broker's full surface — the real SharedSessionBroker satisfies this shape.
 *
 * Live registration is the fast path (a created/closed companion session is
 * visible to /api/sessions immediately, same-process); the boot-time importer
 * fold remains the reconciliation path for files written by other instances.
 */

/** Participant identity for a companion session in the shared store. */
export interface CompanionBrokerParticipant {
  readonly surfaceKind: 'companion';
  readonly surfaceId: string;
  readonly lastSeenAt: number;
}

export interface CompanionBrokerRegisterInput {
  readonly sessionId: string;
  readonly kind: 'companion-chat';
  readonly project?: string | undefined;
  readonly title?: string | undefined;
  readonly participant: CompanionBrokerParticipant;
  /** Reopen a closed shared record; companion mirrors its own live state. */
  readonly reopen?: boolean | undefined;
}

/**
 * Structural subset of SharedSessionBroker. Return types are intentionally
 * `unknown` — the companion manager fires these for their effect on the store,
 * not for their result.
 */
export interface CompanionSessionBrokerBridge {
  register(input: CompanionBrokerRegisterInput): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  /** Hard-remove the mirrored shared-session record (W5-S1: companion delete is a real removal, not a close). */
  deleteSession(sessionId: string): Promise<unknown>;
}
