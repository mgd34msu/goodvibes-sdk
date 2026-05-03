/**
 * Widen an arbitrary value to a plain Record<string, unknown> for generic dispatch.
 *
 * Use this helper in place of the verbose double-cast idiom
 * `value as unknown as Record<string, unknown>`. It is intentionally
 * a thin cast — no runtime validation — because the call sites all operate on
 * values that are structurally objects at runtime; the cast is only needed to
 * satisfy TypeScript's type system at the generic-dispatch boundary.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
