/**
 * typed-client-wrong-body.ts
 *
 * The build-time half of the required-field conformance gate.
 *
 * `test/gateway-verb-required-conformance.test.ts` proves the catalog's
 * `inputSchema.required` matches what the route handler actually refuses. That
 * is only worth something if the requirement then REACHES a consumer as a
 * constraint rather than as documentation, and the path from schema to consumer
 * runs through a hand-authored file
 * (`packages/contracts/src/generated/foundation-client-types.ts`) whose
 * generator no longer exists. Regenerating the contract artifacts does not
 * touch it. A schema fix can therefore land complete and correct while every
 * consumer still sees the field as optional — which has happened.
 *
 * So each case below asserts the CONTRACT TYPE, written with `@ts-expect-error`
 * to invert the reporting: if the compiler does not raise the error, the
 * directive itself becomes one ("unused '@ts-expect-error' directive") and this
 * file fails to compile. A green `bun run types:check` is a positive statement
 * that each of these bodies is genuinely rejected — not that nothing exploded.
 *
 * ── A hole this file deliberately does NOT paper over ──────────────────────
 *
 * These assertions are on `OperatorMethodInput<'…'>`. They are NOT written as
 * `operator.invoke('…', badBody)` calls, and that is a finding, not a
 * shortcut. `OperatorRemoteClient.invoke` is overloaded, and the fallback is
 *
 *   invoke<T = unknown>(methodId: string, input?: Record<string, unknown>, …)
 *
 * `Record<string, unknown>` accepts any object, so a KNOWN method id with a
 * WRONG body fails the typed overload and then silently matches the loose one.
 * Measured against this build by writing these same cases as `operator.invoke`
 * calls: every one of them compiled without complaint, including
 * `invoke('power.keepAwake.set', { enabled: 'yes' })` where the schema declares
 * a boolean. The type system reports success on precisely the case it exists to
 * catch, which is why the assertions below go to the contract type directly.
 *
 * Constraining that overload is a platform decision recorded for the owner, not
 * one to make from inside a sweep, so this file does not change it and does not
 * assert the current permissiveness either — asserting it would lock the hole
 * in. It checks the layer it can honestly check. The day the overload is
 * constrained, rewriting these as real `operator.invoke` calls is a mechanical
 * edit and the coverage becomes end-to-end.
 */
import type { OperatorMethodInput } from '@pellux/goodvibes-sdk/contracts';
import { createBrowserKnowledgeSdk } from '@pellux/goodvibes-sdk/browser/knowledge';

// ── Plain required fields ───────────────────────────────────────────────────

// @ts-expect-error enabled is required
const missingEnabled: OperatorMethodInput<'power.keepAwake.set'> = {};

// @ts-expect-error enabled is a boolean, not a string
const wrongEnabledType: OperatorMethodInput<'power.keepAwake.set'> = { enabled: 'yes' };

// @ts-expect-error surfaceId is required alongside sessionId
const missingSurfaceId: OperatorMethodInput<'sessions.detach'> = { sessionId: 'session-1' };

// NOT asserted here, and the reason is the sharpest limit on this whole gate:
// `email.inbox.read` DOES declare `required: ['uid']` in its catalog schema,
// and `OperatorMethodInput<'email.inbox.read'>` is still permissive. Only the
// 154 method ids with a hand-authored entry in foundation-client-types.ts get a
// real input type; the other 289 fall back to `Record<string, unknown>`. So a
// correct `required` array is necessary for a consumer-visible constraint and
// nowhere near sufficient — the verb also has to be in that file. Coverage is
// tracked by scripts/check-foundation-io-coverage.ts against a ratchet.

// ── Conditional requirements: "one of these", stated as a union of branches ──
// Each of these handlers refuses a body satisfying no branch. A flat `required`
// array cannot say that without also refusing calls that work, so the contract
// is a base intersected with a requirement union — see
// method-catalog-shared.ts `branchedSchema`.

// @ts-expect-error one of dataBase64 / text / path / uri is required
const artifactWithNoContent: OperatorMethodInput<'artifacts.create'> = { filename: 'notes.txt' };

// @ts-expect-error one of artifact / artifactId is required
const analyzeWithNoArtifact: OperatorMethodInput<'media.analyze'> = { prompt: 'describe it' };

// @ts-expect-error one of target / input / query is required
const resolveWithNoTarget: OperatorMethodInput<'channels.targets.resolve'> = { live: true };

// @ts-expect-error one of body / content / attachments is required
const messageWithNothingInIt: OperatorMethodInput<'companion.chat.messages.create'> = { sessionId: 's1' };

// @ts-expect-error messageId is required, and so is one of body / content / attachments
const editWithNoTarget: OperatorMethodInput<'companion.chat.messages.edit'> = { sessionId: 's1' };

// @ts-expect-error one of body / content / attachments is required
const steerWithNothingInIt: OperatorMethodInput<'companion.chat.messages.steer'> = { sessionId: 's1' };

// @ts-expect-error at least one of title / model / provider / systemPrompt is required
const updateWithNothingToUpdate: OperatorMethodInput<'companion.chat.sessions.update'> = { sessionId: 's1' };

// `id` is required for the projection kinds that render ONE item, and
// meaningless for the kinds that render a whole view — so the contract is
// discriminated on `kind` and both facts hold at once.
// @ts-expect-error kind 'source' renders one item and needs its id
const projectionWithoutId: OperatorMethodInput<'knowledge.projection.render'> = { kind: 'source' };

// @ts-expect-error 'everything' is not a projection kind the route serves
const projectionWithUnknownKind: OperatorMethodInput<'knowledge.projection.materialize'> = { kind: 'everything' };

// ── Bodies built as VARIABLES, not fresh literals ───────────────────────────
//
// A sibling round found that a correctly typed wrapper parameter still let a
// wrong body through, because TypeScript's excess-property check only fires on
// a FRESH object literal — a payload assembled into a variable first slips past
// it. That limit is real, and it is worth being exact about what it does and
// does not cover, because assuming the wrong half is how a guard ends up
// checking nothing.
//
// Freshness governs EXCESS properties only. A MISSING required property, a
// wrong property TYPE, and a value satisfying no branch of a union are ordinary
// assignability failures, and assignability does not care where the value came
// from. The cases below are the same defects as above, laundered through a
// variable first — every one is still caught.

const staleKeepAwake = { enabled: 'yes' };
// @ts-expect-error enabled is a boolean, and coming from a variable does not change that
const viaVariableWrongType: OperatorMethodInput<'power.keepAwake.set'> = staleKeepAwake;

const staleArtifact = { filename: 'notes.txt' };
// @ts-expect-error still satisfies no content branch when it arrives as a variable
const viaVariableNoBranch: OperatorMethodInput<'artifacts.create'> = staleArtifact;

const staleProjection = { kind: 'source' as const };
// @ts-expect-error a per-item projection kind still needs its id
const viaVariableMissingId: OperatorMethodInput<'knowledge.projection.render'> = staleProjection;

// What freshness DOES cost: an undeclared key on an open envelope is tolerated
// either way here, so nothing is lost — but on a CLOSED schema the literal form
// is stricter than the variable form, and that gap is not something this file
// can close. It is recorded rather than papered over.
const staleWithUnknownKey = { enabled: true, unknownExtra: 1 };
const closedSchemaVariableSlipsThrough: OperatorMethodInput<'power.keepAwake.set'> = staleWithUnknownKey;

// ── Bodies built with a SPREAD inside a fresh literal ───────────────────────
//
// A third hole in excess-property checking, beyond the variable case above: a
// FRESH object literal that contains a spread is not treated as fresh for the
// spread's contribution, so a correctly typed parameter stops rejecting extra
// keys. That is real, and it matters because payloads at real call sites are
// routinely assembled as `{ id, ...input }`.
//
// It is worth being exact about what it costs, because the answer is narrower
// than "typing does not help". Measured against these contract types:
//
//   missing required field via spread   → CAUGHT
//   wrong-typed field via spread        → CAUGHT
//   satisfies no requirement branch     → CAUGHT
//   EXCESS key via spread               → NOT caught
//
// Excess properties are the only casualty, and excess properties are not this
// gate's subject — these are open body envelopes where an undeclared key is
// legitimate anyway. The defect class this file exists for survives the spread.

const nothingToSay = {};
// @ts-expect-error spread contributes no body/content/attachments, so no branch is satisfied
const spreadMissingRequirement: OperatorMethodInput<'companion.chat.messages.create'> = { sessionId: 's1', ...nothingToSay };

const wrongTypedPiece = { enabled: 'yes' };
// @ts-expect-error a spread does not launder a wrong property type
const spreadWrongType: OperatorMethodInput<'power.keepAwake.set'> = { ...wrongTypedPiece };

const enoughToSay = { body: 'hello' };
// Satisfies a branch through the spread — must keep compiling.
const spreadSatisfiesBranch: OperatorMethodInput<'companion.chat.messages.create'> = { sessionId: 's1', ...enoughToSay };

// The one that gets through: an excess key on a CLOSED schema, which the same
// literal without the spread would reject. Asserted as compiling so the hole is
// recorded at its true size rather than described in a comment and forgotten —
// if TypeScript ever closes it, this line fails and the note gets revisited.
const strayKey = { unknownExtra: 1 };
const spreadHidesExcessKey: OperatorMethodInput<'power.keepAwake.set'> = { enabled: true, ...strayKey };

// ── The named facade helpers, not just the raw contract types ───────────────
//
// These wrap a verb and fold the path-bound session id in for the caller, and
// they took `Omit<Input, 'sessionId'>`. That parameter had been accepting
// ANYTHING — an open body envelope renders as an intersection with
// `{ readonly [key: string]: unknown }`, `keyof` of which is `string | number`,
// so omitting a named key removed nothing and kept nothing and the parameter
// degenerated to a bare record. It predated the requirement branches; the
// branches only made the consequence visible.
//
// `OmitDeclared` (browser-knowledge.ts) drops the index signature before
// omitting and distributes over the union, so the helpers now carry the same
// constraint the contract type does. Asserted here because the degeneration was
// invisible for as long as nothing downstream had anything left to check.

async function verifyFacadeHelpersEnforce(): Promise<void> {
  const knowledge = createBrowserKnowledgeSdk({ baseUrl: 'http://127.0.0.1:3210' });

  // @ts-expect-error a message needs body, content or attachments
  await knowledge.chat.messages.create('session-1', {});

  // @ts-expect-error an update needs at least one field to update
  await knowledge.chat.sessions.update('session-1', {});

  // Both shapes below are real calls and must keep compiling.
  await knowledge.chat.messages.create('session-1', { body: 'hello' });
  await knowledge.chat.sessions.update('session-1', { title: 'renamed' });
}

void verifyFacadeHelpersEnforce;

// ── Calls that must keep compiling ──────────────────────────────────────────
// The gate is only meaningful if it refuses the wrong bodies WITHOUT refusing
// the right ones. Each of these is a shape the handler genuinely accepts.

const wholeViewProjection: OperatorMethodInput<'knowledge.projection.render'> = { kind: 'overview' };
const perItemProjection: OperatorMethodInput<'knowledge.projection.render'> = { kind: 'source', id: 'src-1' };
const attachmentOnlyMessage: OperatorMethodInput<'companion.chat.messages.create'> = {
  sessionId: 's1',
  attachments: [{ artifactId: 'artifact-1' }],
};
const artifactFromText: OperatorMethodInput<'artifacts.create'> = { text: 'hello' };
const analyzeById: OperatorMethodInput<'media.analyze'> = { artifactId: 'artifact-1' };
// Body-envelope inputs still tolerate undeclared keys; tightening that is a
// separate decision, so the boundary is stated rather than left to inference.
// (A plain `objectSchema` verb such as power.keepAwake.set does NOT — it is
// closed, and an unknown key there is already a compile error.)
const extraKeysTolerated: OperatorMethodInput<'artifacts.create'> = { text: 'hello', unknownExtra: 1 };

/**
 * Two requirements are enforced at the invoke gate but are deliberately absent
 * from the types above, each for a reason that is measured rather than assumed:
 *
 *  - `automation.jobs.create` / `automation.schedules.create` need a schedule
 *    (`cron`, `schedule.expression`, `every` or `at`, per `kind`). Their input
 *    is a ~35-property object with several deeply nested unions, and
 *    intersecting it with ANY requirement union puts the operator client past
 *    the compiler's union-complexity ceiling — TS2590, measured at two, three
 *    and four branches and with branches reduced to one property each. The
 *    schema carries the requirement; the type cannot.
 *  - `companion.chat.sessions.create` refuses `provider` without `model` and
 *    vice versa. That is `dependentRequired`, a co-occurrence rule with no
 *    TypeScript equivalent short of a union, and it is not worth one here.
 *
 * Both are enforced by `invoke-input-validation.ts` before dispatch, so the
 * refusal is honest and early. Neither is a compile error, and pretending
 * otherwise by omitting this note is how a gate ends up looking complete.
 */

void [
  missingEnabled, wrongEnabledType, missingSurfaceId,
  viaVariableWrongType, viaVariableNoBranch, viaVariableMissingId,
  spreadMissingRequirement, spreadWrongType, spreadSatisfiesBranch, spreadHidesExcessKey,
  closedSchemaVariableSlipsThrough,
  artifactWithNoContent, analyzeWithNoArtifact, resolveWithNoTarget,
  messageWithNothingInIt, editWithNoTarget, steerWithNothingInIt,
  updateWithNothingToUpdate, projectionWithoutId, projectionWithUnknownKind,
  wholeViewProjection, perItemProjection, attachmentOnlyMessage,
  artifactFromText, analyzeById, extraKeysTolerated,
];
