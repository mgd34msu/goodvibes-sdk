/**
 * method-catalog-owner-profile.ts
 *
 * Contract descriptors for the owner profile (`profile.*`) — what the platform
 * knows about the person who owns it, kept as one Markdown file at daemon scope.
 * See docs/owner-profile.md §11.1 for the verb table these descriptors implement.
 *
 * Descriptors live here (static) so buildOperatorContract / api.md / the
 * generated contract artifacts see them whether or not a handler has been
 * attached yet; routes/owner-profile.ts attaches the handlers when the runtime
 * composition root builds the store. Same descriptor/handler split as
 * method-catalog-principals.ts.
 *
 * Two properties of this surface are deliberate and are asserted by tests:
 *
 *  - **`profile.status` never returns a value.** It is the diagnostic verb, so
 *    it answers with load state, path, section names, counts and the invalid
 *    field list WITH REASONS — and nothing that could carry a shipping address
 *    into a diagnostics bundle. Its output schema has no `value` anywhere.
 *  - **There is no enumerate-all-people verb.** `profile.person` takes a name.
 *    `profile.read` returns everything and is the "what do you know about me"
 *    answer to the owner, which is exactly the call a composition path must not
 *    make (§10). The absence of a `profile.people.list` is load-bearing, not an
 *    oversight.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/** A field that has no value, and a change that names a section rather than a field. */
const NULLABLE_STRING_SCHEMA: Record<string, unknown> = {
  anyOf: [STRING_SCHEMA, { type: 'null' }],
};

/** Where a line came from: which surface, when, and the owner's exact words. */
export const PROFILE_PROVENANCE_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  date: STRING_SCHEMA,
  said: STRING_SCHEMA,
}, ['surface', 'date', 'said']);

/** One prose line, preserved as written. */
export const PROFILE_LINE_SCHEMA = objectSchema({
  lineIndex: NUMBER_SCHEMA,
  section: STRING_SCHEMA,
  text: STRING_SCHEMA,
  provenance: PROFILE_PROVENANCE_SCHEMA,
}, ['lineIndex', 'section', 'text']);

/** One mechanical field. `valid: false` still carries the value — see §4.3. */
export const PROFILE_FIELD_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  value: STRING_SCHEMA,
  valid: BOOLEAN_SCHEMA,
  invalidReason: STRING_SCHEMA,
  provenance: PROFILE_PROVENANCE_SCHEMA,
}, ['fieldId', 'label', 'value', 'valid']);

/** One `## ` section, with its tier so a caller knows what it is holding. */
export const PROFILE_SECTION_SCHEMA = objectSchema({
  heading: STRING_SCHEMA,
  tier: STRING_SCHEMA,
  fields: arraySchema(PROFILE_FIELD_SCHEMA),
  prose: arraySchema(PROFILE_LINE_SCHEMA),
}, ['heading', 'tier', 'fields', 'prose']);

/** A mechanical value that did not validate, and why. Never fails the file. */
export const PROFILE_INVALID_FIELD_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['fieldId', 'reason']);

/**
 * Load state. `kind` is `loaded` | `unavailable` | `disabled`; the counts belong
 * to `loaded` and `reason` to `unavailable`.
 *
 * No `value` property, and none nested anywhere below: this is the shape
 * `profile.status` answers with, and it is the reason that verb is safe to put
 * in a diagnostics bundle.
 */
export const PROFILE_STATE_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  path: STRING_SCHEMA,
  exists: BOOLEAN_SCHEMA,
  lineCount: NUMBER_SCHEMA,
  fieldCount: NUMBER_SCHEMA,
  proseLineCount: NUMBER_SCHEMA,
  sections: arraySchema(STRING_SCHEMA),
  invalidFields: arraySchema(PROFILE_INVALID_FIELD_SCHEMA),
  reason: STRING_SCHEMA,
}, ['kind', 'path']);

/** A `<!-- was: … -->` predecessor, retained so `profile.undo` has something to promote. */
export const PROFILE_SUPERSEDED_SCHEMA = objectSchema({
  lineIndex: NUMBER_SCHEMA,
  fieldId: STRING_SCHEMA,
  section: STRING_SCHEMA,
  text: STRING_SCHEMA,
  value: STRING_SCHEMA,
  supersededOn: STRING_SCHEMA,
  previousLine: STRING_SCHEMA,
  provenance: PROFILE_PROVENANCE_SCHEMA,
}, ['lineIndex', 'fieldId', 'section', 'text', 'value', 'supersededOn', 'previousLine']);

/** One thing a write did. Names the field; never repeats the value. */
export const PROFILE_CHANGE_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  fieldId: NULLABLE_STRING_SCHEMA,
  section: STRING_SCHEMA,
  label: STRING_SCHEMA,
  superseded: BOOLEAN_SCHEMA,
}, ['kind', 'section', 'label', 'superseded']);

/** What every write verb answers. `ok: false` always carries a reason. */
export const PROFILE_WRITE_RESULT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING_SCHEMA,
  changes: arraySchema(PROFILE_CHANGE_SCHEMA),
  disclosure: STRING_SCHEMA,
}, ['ok', 'changes', 'disclosure']);

export const PROFILE_READ_INPUT_SCHEMA = objectSchema({}, []);
export const PROFILE_READ_OUTPUT_SCHEMA = objectSchema({
  state: PROFILE_STATE_SCHEMA,
  sections: arraySchema(PROFILE_SECTION_SCHEMA),
}, ['state', 'sections']);

export const PROFILE_GET_INPUT_SCHEMA = objectSchema({ fieldId: STRING_SCHEMA }, ['fieldId']);
export const PROFILE_GET_OUTPUT_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  present: BOOLEAN_SCHEMA,
  field: PROFILE_FIELD_SCHEMA,
  disclosure: STRING_SCHEMA,
}, ['fieldId', 'present', 'disclosure']);

export const PROFILE_PERSON_INPUT_SCHEMA = objectSchema({ name: STRING_SCHEMA }, ['name']);
export const PROFILE_PERSON_OUTPUT_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  lines: arraySchema(PROFILE_LINE_SCHEMA),
  disclosure: STRING_SCHEMA,
}, ['name', 'lines', 'disclosure']);

export const PROFILE_PROVENANCE_INPUT_SCHEMA = objectSchema({ fieldId: STRING_SCHEMA }, ['fieldId']);
export const PROFILE_PROVENANCE_OUTPUT_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  present: BOOLEAN_SCHEMA,
  handEdited: BOOLEAN_SCHEMA,
  provenance: PROFILE_PROVENANCE_SCHEMA,
  superseded: arraySchema(PROFILE_SUPERSEDED_SCHEMA),
}, ['fieldId', 'present', 'handEdited', 'superseded']);

export const PROFILE_SET_INPUT_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  value: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  said: STRING_SCHEMA,
  authority: STRING_SCHEMA,
}, ['fieldId', 'value', 'surface', 'said']);

export const PROFILE_APPEND_INPUT_SCHEMA = objectSchema({
  section: STRING_SCHEMA,
  text: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  said: STRING_SCHEMA,
  authority: STRING_SCHEMA,
}, ['section', 'text', 'surface', 'said']);

export const PROFILE_FORGET_INPUT_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  lineIndex: NUMBER_SCHEMA,
  authority: STRING_SCHEMA,
}, []);

export const PROFILE_UNDO_INPUT_SCHEMA = objectSchema({
  fieldId: STRING_SCHEMA,
  authority: STRING_SCHEMA,
}, ['fieldId']);

export const PROFILE_STATUS_INPUT_SCHEMA = objectSchema({}, []);

export const builtinGatewayOwnerProfileMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'profile.read',
    title: 'Read Owner Profile',
    description: 'Return the whole owner profile, by section, with each section\'s tier and every mechanical field\'s validity. This is the answer to "what do you know about me?" and is the ONE read that returns closed-tier content in bulk — which is why it is never callable from a message-composition path.',
    category: 'profile',
    scopes: ['read:profile'],
    http: { method: 'GET', path: '/api/profile' },
    inputSchema: PROFILE_READ_INPUT_SCHEMA,
    outputSchema: PROFILE_READ_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.get',
    title: 'Get Profile Field',
    description: 'Return one mechanical field by id (e.g. commerce.shippingAddress). Answers present:false for a field the owner has not recorded rather than inventing a value, and returns an invalid value verbatim with its reason instead of hiding it. A closed-tier field carries the one-line disclosure the reply should show.',
    category: 'profile',
    scopes: ['read:profile'],
    http: { method: 'GET', path: '/api/profile/fields/{fieldId}' },
    inputSchema: PROFILE_GET_INPUT_SCHEMA,
    outputSchema: PROFILE_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.person',
    title: 'Get Person From Profile',
    description: 'Return the People lines matching one name. Takes a NAME by design and has no enumerate-all counterpart: a People line may reach outbound content only when the owner named that person in this turn\'s instruction, and the only lookup that exists taking a name is what makes that structural rather than a matter of model judgement.',
    category: 'profile',
    scopes: ['read:profile'],
    http: { method: 'POST', path: '/api/profile/person' },
    inputSchema: PROFILE_PERSON_INPUT_SCHEMA,
    outputSchema: PROFILE_PERSON_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.provenance',
    title: 'Get Profile Provenance',
    description: 'Answer "where did you get that?" for one field: the surface, the date and the owner\'s verbatim words, plus every superseded predecessor still retained as a history comment. A field the owner typed by hand reports handEdited:true and no provenance, rather than being dressed up as a recorded source.',
    category: 'profile',
    scopes: ['read:profile'],
    http: { method: 'GET', path: '/api/profile/fields/{fieldId}/provenance' },
    inputSchema: PROFILE_PROVENANCE_INPUT_SCHEMA,
    outputSchema: PROFILE_PROVENANCE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.set',
    title: 'Set Profile Field',
    description: 'Record or correct one mechanical field, moving any previous value into a retained history comment. Refused unless the caller carries owner-direct authority AND the proposed value does not overlap untrusted content read this turn AND a verbatim quote of what the owner said is supplied. A caller declaring the call was not an explicit user request is refused before any of that.',
    category: 'profile',
    scopes: ['write:profile'],
    http: { method: 'POST', path: '/api/profile/set' },
    inputSchema: PROFILE_SET_INPUT_SCHEMA,
    outputSchema: PROFILE_WRITE_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.append',
    title: 'Append Profile Note',
    description: 'Add one prose bullet to a section, carrying its provenance suffix. Same three-layer gate as profile.set. A section that does not exist is created at the end of the document; a section the owner renamed is matched case-insensitively rather than duplicated.',
    category: 'profile',
    scopes: ['write:profile'],
    http: { method: 'POST', path: '/api/profile/append' },
    inputSchema: PROFILE_APPEND_INPUT_SCHEMA,
    outputSchema: PROFILE_WRITE_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.forget',
    title: 'Forget Profile Line',
    description: 'Delete a field line (or one line by index) and every retained history comment for that field. No tombstone, no deleted flag, no retention window — delete means delete. Forgetting something that was not there reports that honestly instead of returning success. Authority-gated exactly like a write: an injection that cannot add a fact must not be able to remove one.',
    category: 'profile',
    scopes: ['write:profile'],
    http: { method: 'POST', path: '/api/profile/forget' },
    inputSchema: PROFILE_FORGET_INPUT_SCHEMA,
    outputSchema: PROFILE_WRITE_RESULT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'profile.undo',
    title: 'Undo Profile Correction',
    description: 'Promote a field\'s most recent superseded value back to the active line, so a wrong correction is recoverable. Authority-gated like every other mutation.',
    category: 'profile',
    scopes: ['write:profile'],
    http: { method: 'POST', path: '/api/profile/undo' },
    inputSchema: PROFILE_UNDO_INPUT_SCHEMA,
    outputSchema: PROFILE_WRITE_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'profile.status',
    title: 'Owner Profile Status',
    description: 'Diagnostics for the profile: whether it loaded, the file path, the section names, line/field/prose counts, and every mechanical value that did not validate WITH ITS REASON. It never returns a value — that is what makes it safe in a support bundle, and it is asserted by test. An unreadable file reports unavailable with the reason rather than an empty profile.',
    category: 'profile',
    scopes: ['read:profile'],
    http: { method: 'GET', path: '/api/profile/status' },
    inputSchema: PROFILE_STATUS_INPUT_SCHEMA,
    outputSchema: PROFILE_STATE_SCHEMA,
  }),
];
