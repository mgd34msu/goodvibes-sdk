/**
 * routes/owner-profile.ts
 *
 * Handlers for the `profile.*` gateway verbs over `OwnerProfileStore`
 * (../../owner-profile). Thin verb registration in the same shape as
 * routes/principals.ts: read the invocation params, call the store, answer.
 *
 * ## A write that did not happen is `ok: false`, not a thrown status
 *
 * Every write verb answers 200 with the store's own `{ ok, reason, changes,
 * disclosure }`, and `ok` is required by the output schema. That follows
 * `principals.delete` in this same directory — "an honest boolean, never a 200
 * that pretends". The alternative considered and rejected was mapping a trust
 * refusal to 403 by matching its wording, which would have made the wire status
 * depend on a sentence the trust module is free to reword. What DOES throw is
 * `refuseNonUserRequest`, because that is a statement about the CALLER rather
 * than about the document.
 *
 * ## Why every verb goes through the store
 *
 * `owner-profile/writer.ts` knows how to edit lines and nothing about trust.
 * The store runs the §7 gate — authority, then derivation against the process
 * untrusted-content ledger, then the verbatim-quote requirement — before a line
 * lands. The module barrel deliberately does not export the raw writer, and
 * nothing here reaches around the store to reach it. A gate that can be walked
 * around is not a gate.
 *
 * ## The order of the two gates on a write
 *
 * `profile.set`, `profile.append` and `profile.forget` call
 * `refuseNonUserRequest()` BEFORE anything else, including before the authority
 * check. Those are two different questions and the caller-declaration one is
 * cheaper and more specific: "you told me this was not a user request" deserves
 * its own answer rather than being folded into a trust refusal that names a
 * surface the caller never claimed. See routes/explicit-user-request.ts for why
 * an ABSENT claim proceeds and only an explicit `false` refuses.
 *
 * ## `authority` is required on every write
 *
 * It is a body parameter, not a transport-populated context field, so requiring
 * it refuses nobody who was going to succeed and closes the case where omitting
 * it granted the one tier that carries write authority. See {@link readAuthority}.
 *
 * ## Policy vs mechanism
 *
 * The owner's three switches — `profile.autonomousWrites`,
 * `profile.discloseWrites`, `profile.discloseClosedTierReads` — are applied by
 * `owner-profile-policy.ts`, which wraps the store for writes, and by the read
 * handlers below for the read receipt. The trust gate is not policy and is not
 * here: it lives in the store, and nothing in this file can turn it off.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import type { AuthoritySurface } from '../../security/untrusted-content.js';
import {
  describeProfilePersonRead,
  describeProfileRead,
  isProfileSurface,
  profileFieldById,
  type OwnerProfileStore,
  type ProfileSurface,
} from '../../owner-profile/index.js';
import {
  applyOwnerProfilePolicy,
  PERMISSIVE_OWNER_PROFILE_POLICY,
  type OwnerProfilePolicy,
} from './owner-profile-policy.js';

/** The read/write surface of the store these verbs need. */
export type OwnerProfileGatewayService = Pick<
  OwnerProfileStore,
  'read' | 'get' | 'person' | 'provenance' | 'status' | 'set' | 'append' | 'forget' | 'undo'
>;

const AUTHORITY_SURFACES: readonly AuthoritySurface[] = [
  'owner-direct',
  'web-page',
  'email',
  'channel-message',
  'document',
];

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

/** A known field id, or an honest 400 naming what was asked for. */
function requireFieldId(value: unknown): string {
  const fieldId = requireString(value, 'fieldId');
  if (profileFieldById(fieldId) === undefined) {
    throw new GatewayVerbError(
      `"${fieldId}" is not a profile field. Profile fields are the mechanical fields listed in docs/owner-profile.md §4.3; everything else in the document is prose.`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return fieldId;
}

/**
 * The authority the caller claims. REQUIRED, and never defaulted.
 *
 * An earlier version read an absent `authority` as `owner-direct`, on the same
 * reasoning `explicit-user-request.ts` uses for its own field. That reasoning
 * does not transfer, and the difference matters: `explicitUserRequest` lives in
 * an invocation CONTEXT no transport populates, so requiring it would refuse
 * every real caller. `authority` is a body parameter of these verbs — any
 * caller already constructing `{fieldId, value, surface, said}` can state it —
 * so requiring it costs one word and removes a hole rather than a capability.
 *
 * The hole was not theoretical for removals. §7 gives `forget` and `undo`
 * layer 1 and nothing else, on purpose, so an omitted `authority` there was not
 * a weakened gate, it was no gate: a caller that sent no authority at all
 * deleted the owner's shipping address.
 *
 * An unrecognised string is refused rather than defaulted, so a typo or a probe
 * can never resolve to the one tier that carries write authority.
 */
function readAuthority(value: unknown): AuthoritySurface {
  if (typeof value !== 'string' || !(AUTHORITY_SURFACES as readonly string[]).includes(value)) {
    throw new GatewayVerbError(
      `authority is required and must be one of ${AUTHORITY_SURFACES.join(', ')}`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value as AuthoritySurface;
}

/** Which surface is recording the line. Named in the provenance suffix. */
function readSurface(value: unknown): ProfileSurface {
  const surface = requireString(value, 'surface');
  if (!isProfileSurface(surface)) {
    throw new GatewayVerbError(
      `surface must be one of tui, agent, webui, voice, hand-edit`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return surface;
}

function createReadHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return () => service.read();
}

function createStatusHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  // Load state, path, section names, counts, invalid fields + reasons. Never a
  // value — that property is what makes this verb safe in a support bundle, and
  // owner-profile-containment.test.ts asserts it against a populated profile.
  return () => service.status();
}

function createGetHandler(
  service: OwnerProfileGatewayService,
  policy: OwnerProfilePolicy,
): GatewayMethodHandler {
  return (invocation) => {
    const fieldId = requireFieldId(readInvocationParams(invocation).fieldId);
    const field = service.get(fieldId);
    const def = profileFieldById(fieldId);
    // A closed-tier read is disclosed unless he turned the receipts off; an
    // open-tier one never is, because the open tier is already in context and a
    // receipt for it would be noise. The VALUE is returned either way — the
    // setting governs whether he is told, not whether the consumer is served.
    const disclose = field !== undefined
      && def?.tier === 'closed'
      && policy.discloseClosedTierReads();
    return {
      fieldId,
      present: field !== undefined,
      ...(field === undefined ? {} : { field }),
      disclosure: disclose ? describeProfileRead([fieldId]) : '',
    };
  };
}

function createPersonHandler(
  service: OwnerProfileGatewayService,
  policy: OwnerProfilePolicy,
): GatewayMethodHandler {
  return (invocation) => {
    const name = requireString(readInvocationParams(invocation).name, 'name');
    const lines = service.person(name);
    // Disclosed only when something was actually found: "Used Sarah's details"
    // for a Sarah who is not in the profile would be a false receipt. `People`
    // is closed tier, so the same switch governs it.
    const disclose = lines.length > 0 && policy.discloseClosedTierReads();
    return {
      name,
      lines,
      disclosure: disclose ? describeProfilePersonRead(name) : '',
    };
  };
}

function createProvenanceHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const fieldId = requireFieldId(readInvocationParams(invocation).fieldId);
    return service.provenance(fieldId);
  };
}

function createSetHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'profile.set');
    const params = readInvocationParams(invocation);
    return service.set({
      fieldId: requireFieldId(params.fieldId),
      value: requireString(params.value, 'value'),
      surface: readSurface(params.surface),
      said: requireString(params.said, 'said'),
      authority: readAuthority(params.authority),
    });
  };
}

function createAppendHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'profile.append');
    const params = readInvocationParams(invocation);
    return service.append({
      section: requireString(params.section, 'section'),
      text: requireString(params.text, 'text'),
      surface: readSurface(params.surface),
      said: requireString(params.said, 'said'),
      authority: readAuthority(params.authority),
    });
  };
}

function createForgetHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation: GatewayMethodInvocation) => {
    refuseNonUserRequest(invocation, 'profile.forget');
    const params = readInvocationParams(invocation);
    const fieldId = params.fieldId === undefined || params.fieldId === null
      ? undefined
      : requireFieldId(params.fieldId);
    const lineIndex = typeof params.lineIndex === 'number' ? params.lineIndex : undefined;
    if (fieldId === undefined && lineIndex === undefined) {
      throw new GatewayVerbError('forget needs a fieldId or a lineIndex', 'INVALID_ARGUMENT', 400);
    }
    return service.forget({
      authority: readAuthority(params.authority),
      ...(fieldId === undefined ? {} : { fieldId }),
      ...(lineIndex === undefined ? {} : { lineIndex }),
    });
  };
}

/**
 * `profile.undo` deliberately does NOT call `refuseNonUserRequest`.
 *
 * §11.1 names three verbs that do — set, append, forget — and undo is not one
 * of them. It is also the only mutation that cannot lose information: it
 * promotes a value the owner previously had back to the active line. The
 * authority gate still applies, so an untrusted surface cannot reach it.
 */
function createUndoHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation: GatewayMethodInvocation) => {
    const params = readInvocationParams(invocation);
    return service.undo({
      fieldId: requireFieldId(params.fieldId),
      authority: readAuthority(params.authority),
    });
  };
}

/**
 * Attach the nine handlers.
 *
 * `policy` defaults to permissive so a caller that has no config to read from —
 * a test, a narrow embed — behaves exactly as the schema defaults describe.
 * The daemon passes live predicates, so all three switches take effect on the
 * next call rather than on the next restart.
 */
export function registerOwnerProfileGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: OwnerProfileGatewayService,
  policy: OwnerProfilePolicy = PERMISSIVE_OWNER_PROFILE_POLICY,
): void {
  const governed = applyOwnerProfilePolicy(service, policy);
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('profile.read', createReadHandler(governed));
  attach('profile.get', createGetHandler(governed, policy));
  attach('profile.person', createPersonHandler(governed, policy));
  attach('profile.provenance', createProvenanceHandler(governed));
  attach('profile.set', createSetHandler(governed));
  attach('profile.append', createAppendHandler(governed));
  attach('profile.forget', createForgetHandler(governed));
  attach('profile.undo', createUndoHandler(governed));
  attach('profile.status', createStatusHandler(governed));
}
