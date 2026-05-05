/**
 * SecurityEvent — discriminated union covering token scope and rotation audit events.
 *
 * These events are emitted by the ApiTokenAuditor during audit runs.
 * Consumers (diagnostics panel, ops handlers) subscribe to these to surface
 * security posture in host surfaces and operator alerts.
 */

export type SecurityEvent =
  /** A token was found to hold scopes beyond its policy's allowedScopes. */
  | {
      type: 'TOKEN_SCOPE_VIOLATION';
      tokenId: string;
      label: string;
      policyId: string;
      excessScopes: string[];
    }
  /** A token is approaching its rotation deadline (within warning threshold). */
  | {
      type: 'TOKEN_ROTATION_WARNING';
      tokenId: string;
      label: string;
      msUntilDue: number;
      dueAt: number;
      ageMs: number;
    }
  /** A token is past its rotation deadline and has not been rotated. */
  | {
      type: 'TOKEN_ROTATION_EXPIRED';
      tokenId: string;
      label: string;
      ageMs: number;
      cadenceMs: number;
      dueAt: number;
    }
  /** A token has been blocked by the auditor in managed mode. */
  | {
      type: 'TOKEN_BLOCKED';
      tokenId: string;
      label: string;
      reason: 'scope_violation' | 'rotation_overdue' | 'scope_violation_and_rotation_overdue';
    }
  // ── Auth audit events ────────────────────────────────────────────
  /** Emitted when a user authenticates successfully. Never includes credentials. */
  | {
      type: 'AUTH_SUCCEEDED';
      /** Authenticated username (display-safe). */
      username: string;
      /** Session token ID (not the token value). */
      sessionId: string;
      /** Client IP address. */
      clientIp: string;
      /** Authentication method used. */
      method: 'password' | 'cookie' | 'token';
    }
  /** Emitted when an authentication attempt fails. Never includes credential values. */
  | {
      type: 'AUTH_FAILED';
      /** The username that was attempted (may be blank or spoofed). */
      usernameAttempted: string;
      /** Client IP address. */
      clientIp: string;
      /** Machine-readable failure reason. */
      reason: 'invalid_credentials' | 'rate_limited' | 'session_expired' | 'origin_denied' | 'unknown';
    }
  // ── Companion pairing events ────────────────────────────────────
  /** Emitted when a companion pairing request is initiated. */
  | {
      type: 'COMPANION_PAIR_REQUESTED';
      clientIp: string;
    }
  /** Emitted when a companion pairing is successfully verified. */
  | {
      type: 'COMPANION_PAIR_VERIFIED';
      /** Opaque token ID (not the token value). */
      tokenId: string;
      clientIp: string;
    }
  /** Emitted when a companion token is rotated. */
  | {
      type: 'COMPANION_TOKEN_ROTATED';
      /** New opaque token ID (not the token value). */
      newTokenId: string;
      clientIp: string;
    }
  /** Emitted when a companion token is revoked. */
  | {
      type: 'COMPANION_TOKEN_REVOKED';
      clientIp: string;
      reason?: string | undefined;
    };

/** All security event type literals as a union. */
export type SecurityEventType = SecurityEvent['type'];
