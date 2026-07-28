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
 * ## `authority`, when the caller does not declare one
 *
 * An absent `authority` is read as `owner-direct`, for the same reason an
 * absent `explicitUserRequest` proceeds: no live transport populates it, and
 * requiring it would make the write verbs answer 403 forever. It is not a hole,
 * because the two gates that do NOT trust the caller's self-description still
 * run — the derivation check against the ledger, and the requirement that a
 * verbatim owner utterance exists. What IS refused, hard, is a caller that
 * declares an untrusted surface, and a caller that supplies a surface name
 * nobody recognises: an unknown string is a 400, never a silent promotion to
 * owner-direct.
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
 * The authority the caller claims. Absent ⇒ `owner-direct` (see the file
 * header); an unrecognised string is refused rather than defaulted, so a typo
 * or a probe can never resolve to the one tier that carries write authority.
 */
function readAuthority(value: unknown): AuthoritySurface {
  if (value === undefined || value === null) return 'owner-direct';
  if (typeof value !== 'string' || !(AUTHORITY_SURFACES as readonly string[]).includes(value)) {
    throw new GatewayVerbError(
      `authority must be one of ${AUTHORITY_SURFACES.join(', ')}`,
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

function createGetHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const fieldId = requireFieldId(readInvocationParams(invocation).fieldId);
    const field = service.get(fieldId);
    const def = profileFieldById(fieldId);
    return {
      fieldId,
      present: field !== undefined,
      ...(field === undefined ? {} : { field }),
      // A closed-tier read is disclosed; an open-tier one is not, because the
      // open tier is already in context and a receipt for it would be noise.
      disclosure: field !== undefined && def?.tier === 'closed' ? describeProfileRead([fieldId]) : '',
    };
  };
}

function createPersonHandler(service: OwnerProfileGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const name = requireString(readInvocationParams(invocation).name, 'name');
    const lines = service.person(name);
    return {
      name,
      lines,
      // Disclosed only when something was actually found: "Used Sarah's details"
      // for a Sarah who is not in the profile would be a false receipt.
      disclosure: lines.length > 0 ? describeProfilePersonRead(name) : '',
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

export function registerOwnerProfileGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: OwnerProfileGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('profile.read', createReadHandler(service));
  attach('profile.get', createGetHandler(service));
  attach('profile.person', createPersonHandler(service));
  attach('profile.provenance', createProvenanceHandler(service));
  attach('profile.set', createSetHandler(service));
  attach('profile.append', createAppendHandler(service));
  attach('profile.forget', createForgetHandler(service));
  attach('profile.undo', createUndoHandler(service));
  attach('profile.status', createStatusHandler(service));
}
