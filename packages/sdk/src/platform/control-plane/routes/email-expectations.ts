/**
 * The three verbs that let an authorized workstream say what it is about to
 * expect.
 *
 * This is the half of §2 that turns a rule into a mechanism. Mail has no
 * command authority and never will; the only thing an arriving message may do
 * is SATISFY an expectation that an already-authorized workstream registered
 * in advance. Until these verbs existed there was no way to register one, so
 * the rule was enforced by there being nothing to enforce.
 *
 * Registration is explicit, never inferred
 * ────────────────────────────────────────
 * A caller states the service domain, the recipient address and the purpose
 * before it submits the form. Nothing watches a page and decides an
 * expectation ought to exist. That distinction is the whole authority model:
 * an expectation created by inference is an expectation created by CONTENT,
 * and content is exactly what must never be able to create one.
 *
 * What these handlers do NOT do
 * ─────────────────────────────
 * Validate. The window ceiling, the open-expectation cap, the address and
 * domain normalisation, the refusal when email holds command authority — all
 * of it belongs to `VerificationExpectationBook` and is reached through
 * `InboundExpectationRegistry`. These read arguments, refuse the ones that are
 * missing or the wrong shape with an honest status, and hand the rest over. A
 * second copy of a clamp is a second clamp that can drift from the first.
 *
 * No `http` binding
 * ─────────────────
 * Deliberate, and it is why these live in their own file rather than beside
 * the mail verbs. The callers are inside the daemon. Advertising an
 * `/api/email/expectations` path that no route serves is precisely what the
 * route-reconcile gate reddens, and inventing a REST surface nothing consumes
 * would be inventing a promise to keep.
 */

import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { GatewayMethodCatalog, GatewayMethodHandler } from '../method-catalog.js';
import type {
  DisclosedExpectation,
  InboundExpectationRegistry,
} from '../../email/inbound/expectation-registry.js';

/**
 * What a backend must be able to do to serve these verbs.
 *
 * Structurally satisfied by `InboundExpectationRegistry`, so the daemon wiring
 * passes the registry itself rather than an adapter — one implementation of
 * these three operations, not two.
 */
export type EmailExpectationService = Pick<
  InboundExpectationRegistry,
  'open' | 'list' | 'cancel'
>;

function readRequired(value: unknown, field: string, hint: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} (${hint}) is required`, 'INVALID_ARGUMENT', 400);
  }
  return value.trim();
}

/**
 * An optional positive window, in milliseconds.
 *
 * Refused rather than coerced when it is present and not a positive finite
 * number: a caller that sent `"soon"` has a bug, and silently substituting the
 * default would hide it behind an expectation that expires at a time nobody
 * chose. Absent is fine — the registry's default applies, and the book clamps
 * whatever arrives to the hard maximum regardless.
 */
function readOptionalWindowMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new GatewayVerbError(
      'windowMs (a positive number of milliseconds) must be a positive number when supplied',
      'INVALID_ARGUMENT',
      400,
    );
  }
  return parsed;
}

/** `signup` or `login`; anything else is refused rather than defaulted. */
function readOptionalKind(value: unknown): 'signup' | 'login' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'signup' || value === 'login') return value;
  throw new GatewayVerbError(
    "kind must be 'signup' or 'login' when supplied",
    'INVALID_ARGUMENT',
    400,
  );
}

export function createEmailExpectationOpenHandler(
  service: EmailExpectationService,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const windowMs = readOptionalWindowMs(params.windowMs);
    const kind = readOptionalKind(params.kind);
    try {
      return await service.open({
        serviceDomain: readRequired(params.serviceDomain, 'serviceDomain', 'the domain the workstream is signing up at'),
        recipientAddress: readRequired(params.recipientAddress, 'recipientAddress', 'the exact address handed to the form'),
        purpose: readRequired(params.purpose, 'purpose', 'a stated purpose'),
        ...(windowMs === undefined ? {} : { windowMs }),
        ...(kind === undefined ? {} : { kind }),
      });
    } catch (error) {
      // The book refuses for reasons that are the CALLER's to fix — too many
      // open expectations, an unusable domain or address — so they are 400s
      // carrying its wording, not 500s. The one exception is the command
      // authority refusal, which is a statement about the platform's
      // configuration rather than about this request.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('command authority')) {
        throw new GatewayVerbError(message, 'FAILED_PRECONDITION', 409);
      }
      throw new GatewayVerbError(message, 'INVALID_ARGUMENT', 400);
    }
  };
}

export function createEmailExpectationListHandler(
  service: EmailExpectationService,
): GatewayMethodHandler {
  return async () => {
    const expectations: readonly DisclosedExpectation[] = service.list();
    return { expectations, total: expectations.length };
  };
}

export function createEmailExpectationCancelHandler(
  service: EmailExpectationService,
): GatewayMethodHandler {
  return async (invocation) => {
    const id = readRequired(
      readInvocationParams(invocation).id,
      'id',
      'the id returned when the expectation was opened',
    );
    const cancelled = await service.cancel(id);
    // An id that is not open is an ordinary answer to an ordinary question —
    // the workstream asked for it to be gone and it is gone. Reporting a 404
    // would make a caller retrying after a crash treat success as failure.
    return cancelled === null
      ? { cancelled: false }
      : { cancelled: true, expectation: cancelled };
  };
}

/** Attach the expectation handlers to their descriptors (missing = no-op). */
export function registerEmailExpectationGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: EmailExpectationService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('email.expectation.open', createEmailExpectationOpenHandler(service));
  attach('email.expectation.list', createEmailExpectationListHandler(service));
  attach('email.expectation.cancel', createEmailExpectationCancelHandler(service));
}
