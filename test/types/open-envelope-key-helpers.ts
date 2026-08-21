// Regression guard for the open-envelope key trap.
//
// 139 of the 443 operator method inputs render as `Base & { readonly [key:
// string]: unknown }` because their catalog schema sets
// `additionalProperties: true`. `keyof` such an intersection is `string |
// number`, so `Omit` and any `keyof`-driven mapped type silently degrade
// against them: the omit collapses to the bare index signature, and a
// required-keys mapped type yields `never`. Both shipped in production, in the
// SDK's browser facade and in transport-http's client plumbing, where they
// looked like types in every report and hover while constraining nothing.
//
// These assertions fail if either helper regresses to a plain `Omit`/`keyof`.

import type {
  OmitNamed,
  OperatorMethodInput,
  RequiredNamedKeys,
} from '@pellux/goodvibes-sdk/contracts';

// `automation.jobs.create` is an open envelope whose schema REQUIRES `prompt`.
type JobsCreate = OperatorMethodInput<'automation.jobs.create'>;

// 1. The named shape survives the omit: `prompt` is still required.
type JobsCreateMinusModel = OmitNamed<JobsCreate, 'model'>;
// @ts-expect-error - `prompt` is required and must not be droppable
const missingPrompt: JobsCreateMinusModel = { name: 'nightly' };

// 2. Field types survive the omit rather than degrading to `unknown`.
// @ts-expect-error - `prompt` is a string, so a number must be rejected
const wrongPromptType: JobsCreateMinusModel = { prompt: 42 };

// 3. The additional-properties escape hatch survives the omit.
const extrasStillAllowed: JobsCreateMinusModel = { prompt: 'go', somethingElse: true };

// 4. Required keys are visible through the index signature.
const requiredKeysAreNotNever: [RequiredNamedKeys<JobsCreate>] extends [never] ? false : true = true;

// 5. A closed (`additionalProperties: false`) input keeps behaving normally.
type SessionsDelete = OperatorMethodInput<'sessions.delete'>;
const closedRequiredKeys: [RequiredNamedKeys<SessionsDelete>] extends [never] ? false : true = true;

// 6. A BRANCHED input keeps every branch's requirement through the omit.
//
// This is the THIRD way this codebase has lost branch requirements, and it is
// the mirror image of the index-signature trap above rather than a repeat of it.
// `companion.chat.messages.create` renders as
// `Base & ({ body: string } | { content: string } | { attachments: ... })`
//, each branch makes a DIFFERENT field mandatory. `Omit<T, K>` is
// `Pick<T, Exclude<keyof T, K>>`, and `keyof` a union is the INTERSECTION of its
// members' keys, which for these branches is nothing. So a NON-distributive
// `OmitNamed` flattens the union into one object with every branch field
// optional: "one of these is required" silently becomes "none of these is
// required", and `create(id, {})` compiles again.
//
// `OmitNamed` therefore has to distribute, while `RequiredNamedKeys` has to stay
// homomorphic. The two are not the same treatment, see typed-io-keys.ts.
type ChatMessageCreateMinusSession = OmitNamed<
  OperatorMethodInput<'companion.chat.messages.create'>,
  'sessionId'
>;
// @ts-expect-error - one of body / content / attachments is required
const noBranchSatisfied: ChatMessageCreateMinusSession = {};
const oneBranchSatisfied: ChatMessageCreateMinusSession = { body: 'hello' };

export {
  missingPrompt,
  wrongPromptType,
  extrasStillAllowed,
  requiredKeysAreNotNever,
  closedRequiredKeys,
  noBranchSatisfied,
  oneBranchSatisfied,
};
