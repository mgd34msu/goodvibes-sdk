/**
 * Security emitters — typed wrappers for SecurityEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { SecurityEvent } from '../events/security.js';
import type { EmitterContext } from './index.js';

function securityEvent<T extends SecurityEvent['type']>(
  type: T,
  data: Omit<Extract<SecurityEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<SecurityEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<SecurityEvent, { type: T }>, ctx);
}

export function emitTokenScopeViolation(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; policyId: string; excessScopes: string[] },
): void {
  bus.emit('security', securityEvent('TOKEN_SCOPE_VIOLATION', data, ctx));
}

export function emitTokenRotationWarning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; msUntilDue: number; dueAt: number; ageMs: number },
): void {
  bus.emit('security', securityEvent('TOKEN_ROTATION_WARNING', data, ctx));
}

export function emitTokenRotationExpired(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; label: string; ageMs: number; cadenceMs: number; dueAt: number },
): void {
  bus.emit('security', securityEvent('TOKEN_ROTATION_EXPIRED', data, ctx));
}

export function emitTokenBlocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    tokenId: string;
    label: string;
    reason: 'scope_violation' | 'rotation_overdue' | 'scope_violation_and_rotation_overdue';
  },
): void {
  bus.emit('security', securityEvent('TOKEN_BLOCKED', data, ctx));
}

// ── Auth audit emitters (OBS-02) ────────────────────────────────────────────

/** Emit AUTH_SUCCEEDED when a user authenticates successfully. Never include credential values. */
export function emitAuthSucceeded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { username: string; sessionId: string; clientIp: string; method: 'password' | 'cookie' | 'token' },
): void {
  bus.emit('security', securityEvent('AUTH_SUCCEEDED', data, ctx));
}

/** Emit AUTH_FAILED when an authentication attempt fails. Never include credential values. */
export function emitAuthFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    usernameAttempted: string;
    clientIp: string;
    reason: 'invalid_credentials' | 'rate_limited' | 'session_expired' | 'origin_denied' | 'unknown';
  },
): void {
  bus.emit('security', securityEvent('AUTH_FAILED', data, ctx));
}

// ── Companion pairing emitters (OBS-21) ──────────────────────────────────

/** Emit COMPANION_PAIR_REQUESTED when a pairing request is initiated. */
export function emitCompanionPairRequested(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientIp: string },
): void {
  bus.emit('security', securityEvent('COMPANION_PAIR_REQUESTED', data, ctx));
}

/** Emit COMPANION_PAIR_VERIFIED when a companion pairing is verified. */
export function emitCompanionPairVerified(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { tokenId: string; clientIp: string },
): void {
  bus.emit('security', securityEvent('COMPANION_PAIR_VERIFIED', data, ctx));
}

/** Emit COMPANION_TOKEN_ROTATED when a companion token is rotated. */
export function emitCompanionTokenRotated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { newTokenId: string; clientIp: string },
): void {
  bus.emit('security', securityEvent('COMPANION_TOKEN_ROTATED', data, ctx));
}

/** Emit COMPANION_TOKEN_REVOKED when a companion token is revoked. */
export function emitCompanionTokenRevoked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { clientIp: string; reason?: string },
): void {
  bus.emit('security', securityEvent('COMPANION_TOKEN_REVOKED', data, ctx));
}
