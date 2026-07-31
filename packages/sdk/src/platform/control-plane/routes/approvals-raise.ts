/**
 * approvals.raise — a surface RAISING an ask into the daemon's broker.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `approvals.list/claim/approve/deny/cancel` have existed for a long time, so
 * every surface could SEE and DECIDE an ask. None of them could create one: the
 * only way into the broker was `ApprovalBroker.requestApproval`, an in-process
 * method call. A surface that is not in the daemon's process — a client whose
 * runtime lives on another machine, or simply another process on this one —
 * therefore had no way to route a permission ask through the daemon at all. It
 * kept its own broker, prompted at its own terminal, and the asks it raised
 * were invisible to every other surface and to the daemon's own attention
 * machinery (the web-push fan-out, the fleet blocked-on-user signal).
 *
 * ── Why it does not block ──────────────────────────────────────────────────
 *
 * The verb returns the PENDING record and returns it immediately. It does not
 * hold the call open until someone answers, for two reasons: an HTTP request
 * parked across a person's attention span is a request that dies to any idle
 * timeout between here and there (and over the relay there are several), and
 * the decision has a better channel already — `control.approval_update` on the
 * SSE stream carries every transition of this record the moment the broker
 * records it. So the shape is: raise, then watch the id you were handed.
 *
 * `waitMs` is offered for the caller that genuinely wants one round trip (a
 * script, a short-lived CLI). It is CLAMPED, and a wait that runs out is not an
 * error: the response comes back with the record still pending and
 * `decided: false`, which is the truth. Nothing here ever reports a decision
 * that was not made.
 *
 * ── Who owns the answer ────────────────────────────────────────────────────
 *
 * The daemon does. A raised ask becomes a record in the daemon's store, several
 * surfaces may claim and answer it, and what a surface renders afterwards is
 * what the record says — not what it locally believes it asked for. That is the
 * same parity contract the web UI already documents for the decide verbs, and
 * raising through this verb is what extends it to the ask itself.
 */

import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { PermissionPromptRequest } from '../../permissions/prompt.js';
import type { RequestSharedApprovalInput, SharedApprovalRecord } from '../approval-broker.js';
import type { RaisedApproval } from '../approval-broker-raise.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The broker surface this verb needs — nothing but raising and reading back. */
export interface ApprovalRaiseService {
  raiseApproval(input: RequestSharedApprovalInput): Promise<RaisedApproval>;
  getApproval(approvalId: string): SharedApprovalRecord | null;
}

/**
 * Longest inline wait a caller may ask for, in ms.
 *
 * 60s is chosen against what is on the other side of the call rather than
 * against what a person takes to decide: an idle proxy, a tunnel, or a browser
 * fetch will drop a parked request well before a slow answer arrives, and a
 * dropped request looks like a failure rather than like "still waiting". A
 * caller that needs longer is the caller that should be on the event stream.
 */
export const APPROVAL_RAISE_MAX_WAIT_MS = 60_000;

/** Longest expiry a raised ask may carry, in ms. Twelve hours. */
export const APPROVAL_RAISE_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1_000;

const PERMISSION_CATEGORIES = new Set(['read', 'write', 'execute', 'delegate']);
const PERMISSION_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

function invalid(message: string, field: string): GatewayVerbError {
  return new GatewayVerbError(message, 'INVALID_ARGUMENT', 400, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`Invalid ${field}: expected a non-empty string`, field);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`Invalid ${field}: expected a string`, field);
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

/** A bounded, non-negative millisecond count, or undefined when unset. */
function clampedMs(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(`Invalid ${field}: expected a non-negative number of milliseconds`, field);
  }
  return Math.min(Math.floor(value), max);
}

/**
 * Validate the ask itself.
 *
 * A raised ask is rendered by every surface and stored durably, so a malformed
 * one is refused at the door rather than persisted and drawn as a blank prompt.
 * The required set is exactly what the broker's own store validator demands of
 * a restored record — an ask that could not be reloaded must not be creatable.
 */
export function readApprovalRaiseRequest(raw: unknown): PermissionPromptRequest {
  if (!isRecord(raw)) throw invalid('Invalid request: expected the permission ask object', 'request');
  const callId = requireString(raw['callId'], 'request.callId');
  const tool = requireString(raw['tool'], 'request.tool');
  const args = raw['args'];
  if (!isRecord(args)) throw invalid('Invalid request.args: expected an object of tool arguments', 'request.args');
  const category = raw['category'];
  if (typeof category !== 'string' || !PERMISSION_CATEGORIES.has(category)) {
    throw invalid(`Invalid request.category: expected one of ${[...PERMISSION_CATEGORIES].join(', ')}`, 'request.category');
  }
  const analysis = raw['analysis'];
  if (!isRecord(analysis)) {
    throw invalid('Invalid request.analysis: expected the analysis object a surface renders the prompt from', 'request.analysis');
  }
  const riskLevel = analysis['riskLevel'];
  if (typeof riskLevel !== 'string' || !PERMISSION_RISK_LEVELS.has(riskLevel)) {
    throw invalid(`Invalid request.analysis.riskLevel: expected one of ${[...PERMISSION_RISK_LEVELS].join(', ')}`, 'request.analysis.riskLevel');
  }
  const reasons = analysis['reasons'];
  if (!Array.isArray(reasons) || !reasons.every((entry) => typeof entry === 'string')) {
    throw invalid('Invalid request.analysis.reasons: expected an array of strings', 'request.analysis.reasons');
  }
  requireString(analysis['classification'], 'request.analysis.classification');
  requireString(analysis['summary'], 'request.analysis.summary');
  const workingDirectory = optionalString(raw['workingDirectory'], 'request.workingDirectory');
  return {
    ...(raw as unknown as PermissionPromptRequest),
    callId,
    tool,
    args,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

/**
 * Who raised this, recorded on the record's metadata.
 *
 * A raised ask that says nothing about where it came from is an ask an operator
 * cannot audit: several surfaces can now create records in one store, and "the
 * TUI asked" versus "a token asked" is exactly the distinction that matters
 * when reviewing what was approved. The invocation context already carries the
 * authenticated principal, so the attribution is the daemon's own observation
 * rather than a claim the caller makes about itself.
 */
export function buildRaiseMetadata(
  invocation: GatewayMethodInvocation,
  supplied: unknown,
): Record<string, unknown> {
  const base = isRecord(supplied) ? { ...supplied } : {};
  return {
    ...base,
    raisedVia: 'approvals.raise',
    ...(invocation.context.principalId ? { raisedByPrincipal: invocation.context.principalId } : {}),
    ...(invocation.context.principalKind ? { raisedByPrincipalKind: invocation.context.principalKind } : {}),
    ...(invocation.context.clientKind ? { raisedBySurface: invocation.context.clientKind } : {}),
  };
}

/** Wait for a decision for at most `waitMs`; resolves false when it runs out. */
async function awaitDecision(raised: RaisedApproval, waitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([raised.decision.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApprovalRaiseHandler(broker: ApprovalRaiseService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const request = readApprovalRaiseRequest(params['request']);
    const timeoutMs = clampedMs(params['timeoutMs'], 'timeoutMs', APPROVAL_RAISE_MAX_TIMEOUT_MS);
    const waitMs = clampedMs(params['waitMs'], 'waitMs', APPROVAL_RAISE_MAX_WAIT_MS);
    const sessionId = optionalString(params['sessionId'], 'sessionId');
    const routeId = optionalString(params['routeId'], 'routeId');

    const raised = await broker.raiseApproval({
      request,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(routeId === undefined ? {} : { routeId }),
      ...(timeoutMs === undefined || timeoutMs === 0 ? {} : { timeoutMs }),
      metadata: buildRaiseMetadata(invocation, params['metadata']),
    });

    // An unawaited decision promise is normal here — the decision arrives on
    // the event stream — but an unhandled rejection would take the process
    // down, and the broker rejects nothing today only by construction.
    raised.decision.catch(() => undefined);

    const decided = waitMs !== undefined && waitMs > 0 ? await awaitDecision(raised, waitMs) : false;
    // Read the record BACK rather than returning the one raise produced: if a
    // decision landed during the wait, the caller should see the resolved
    // record, and the store is the authority on what it says.
    const approval = broker.getApproval(raised.approval.id) ?? raised.approval;
    return {
      approval,
      coalesced: raised.coalesced,
      decided,
    };
  };
}

/** Attach the approvals.raise handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerApprovalRaiseGatewayMethods(
  catalog: GatewayMethodCatalog,
  broker: ApprovalRaiseService,
): void {
  const descriptor = catalog.get('approvals.raise');
  if (descriptor) catalog.register(descriptor, createApprovalRaiseHandler(broker), { replace: true });
}
