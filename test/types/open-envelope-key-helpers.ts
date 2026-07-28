// Regression guard for the open-envelope key trap.
//
// 139 of the 443 operator method inputs render as `Base & { readonly [key:
// string]: unknown }` because their catalog schema sets
// `additionalProperties: true`. `keyof` such an intersection is `string |
// number`, so `Omit` and any `keyof`-driven mapped type silently degrade
// against them: the omit collapses to the bare index signature, and a
// required-keys mapped type yields `never`. Both shipped in production — in the
// SDK's browser facade and in transport-http's client plumbing — where they
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

export {
  missingPrompt,
  wrongPromptType,
  extrasStillAllowed,
  requiredKeysAreNotNever,
  closedRequiredKeys,
};
