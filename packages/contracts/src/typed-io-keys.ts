// typed-io-keys.ts
//
// Key-manipulation helpers for the generated typed-IO shapes in
// generated/foundation-client-types.ts.
//
// THE TRAP THESE EXIST FOR — read before reaching for `Omit` or `keyof` on an
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
// plumbing. Strip the index signature FIRST — that is what `NamedProps` does —
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
 * The keys of `T` that are genuinely required — correct for open envelopes,
 * where a bare `RequiredKeys`-style mapped type collapses to `never`.
 */
type RequiredKeysIn<N> = {
  [K in keyof N]-?: Record<string, never> extends Pick<N, K> ? never : K;
}[keyof N];

/**
 * `NamedProps<T>` is evaluated once and handed in, rather than three times
 * inside the mapped type (the key list, the `Pick`, and the indexed access).
 *
 * `[K in keyof N]` over a naked `N` is HOMOMORPHIC, so for a branched input
 * rendered as `(Base & A) | (Base & B)` it maps per member and yields the union
 * of each branch's required keys. That is the wanted answer, and the
 * non-homomorphic alternative is the bug: taking `keyof` across the whole union
 * gives only the keys the branches SHARE, and branches exist precisely because
 * each requires a different field — so the shared set has nothing required in
 * it, `RequiredKeys` collapses to `never`, and `MethodArgs` makes the input
 * argument optional on every such verb. That is the same defect this module was
 * written to fix, reintroduced from the other side.
 *
 * test/types/open-envelope-key-helpers.ts pins the property that matters:
 * `RequiredNamedKeys` of an open envelope must not be `never`.
 */
export type RequiredNamedKeys<T> = RequiredKeysIn<NamedProps<T>>;

/**
 * `T` without `TKey`, preserving the named shape (and its requiredness) as well
 * as the additional-properties escape hatch when `T` had one.
 *
 * This is the safe replacement for `Omit<T, TKey>` on any rendered method input.
 *
 * `T extends unknown ? … : never` so the omit DISTRIBUTES. Several inputs are
 * `Base & (A | B | C)` — the "one of body/content/attachments" idiom — and
 * `Omit` is not distributive: it is `Pick<T, Exclude<keyof T, K>>`, and `keyof`
 * a union is the INTERSECTION of its members' keys, so the branches collapse
 * into one flat object with every branch member optional. That silently turns
 * "one of these is required" into "none of these is required", which is the
 * same class of loss as the index-signature trap above and reached production
 * the same way. Distributing applies the omit per branch and keeps them.
 */
export type OmitNamed<T, TKey extends PropertyKey> = T extends unknown
  ? Omit<NamedProps<T>, TKey> & IndexPart<T>
  : never;
