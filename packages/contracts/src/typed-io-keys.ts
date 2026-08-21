// typed-io-keys.ts
//
// Key-manipulation helpers for the generated typed-IO shapes in
// generated/foundation-client-types.ts.
//
// THE TRAP THESE EXIST FOR, read before reaching for `Omit` or `keyof` on an
// operator method input:
//
// A catalog schema with `additionalProperties: true` renders as
// `Base & { readonly [key: string]: unknown }`. 139 of the 443 operator method
// inputs are that shape. `keyof` such an intersection is `string | number`, NOT
// the named property union, and every key-driven built-in silently degrades:
//
//   Omit<T, 'sessionId'>        -> Exclude<string|number,'sessionId'> removes
//                                  nothing, Pick retains no named property, and
//                                  the result collapses to the bare index
//                                  signature. Every field, and every field's
//                                  REQUIREDNESS, is gone. The type still appears
//                                  in reports and hovers; it constrains nothing.
//   RequiredKeys<T>             -> `never`, because the mapped type iterates
//                                  `string | number` rather than the named keys.
//                                  Anything gating on it (an optional-vs-required
//                                  argument tuple, for instance) concludes the
//                                  input has no required fields.
//
// Both were found in production: `Omit<OperatorMethodInput<M>, K>` in the SDK's
// browser facade, and `WithoutKeys`/`RequiredKeys` in transport-http's client
// plumbing. Strip the index signature FIRST, that is what `NamedProps` does,
// then apply the key operation, then re-add the index signature if the open
// envelope should stay open.

/**
 * The named (non-index-signature) properties of `T`.
 *
 * Key remapping with `as` drops the broad `string`/`number` index keys, leaving
 * the declared properties with their original optionality intact.
 */
export type NamedProps<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** `T`'s broad string index signature if it has one, otherwise nothing. */
export type IndexPart<T> = string extends keyof T ? { readonly [key: string]: unknown } : unknown;

/**
 * The keys of `T` that are genuinely required, correct for open envelopes,
 * where a bare `RequiredKeys`-style mapped type collapses to `never`.
 */
export type RequiredNamedKeys<T> = {
  [K in keyof NamedProps<T>]-?: Record<string, never> extends Pick<NamedProps<T>, K> ? never : K;
}[keyof NamedProps<T>];

/**
 * `T` without `TKey`, preserving the named shape (and its requiredness) as well
 * as the additional-properties escape hatch when `T` had one.
 *
 * This is the safe replacement for `Omit<T, TKey>` on any rendered method input.
 *
 * `T extends unknown ?` makes this DISTRIBUTE, and that is load-bearing for the
 * same reason `RequiredNamedKeys` is homomorphic. A branched input renders as
 * `(Base & A) | (Base & B)` (method-catalog-shared.ts `branchedSchema`, for the
 * verbs whose required set is conditional). Applied to the whole union at once,
 * `keyof` sees only the keys the branches SHARE, which for requirement
 * branches is nothing, so every branch's requiredness is dropped and the
 * helper's parameter accepts `{}` again. Distributing maps each branch
 * separately and rejoins them, so `create(id, {})` stays an error.
 *
 * Verified by test/types/open-envelope-key-helpers.ts and
 * test/types/typed-client-wrong-body.ts: collapsing this to the non-distributive
 * form turns two `@ts-expect-error` directives into "unused directive" failures.
 */
export type OmitNamed<T, TKey extends PropertyKey> =
  T extends unknown ? Omit<NamedProps<T>, TKey> & IndexPart<T> : never;
