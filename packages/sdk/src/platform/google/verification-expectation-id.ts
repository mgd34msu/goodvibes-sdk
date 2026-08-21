/**
 * The bound on a verification expectation's `id`, and the shape one may take.
 *
 * Its own module because it is the field the other bounds did not cover, and
 * therefore the field through which the whole point of them was reachable.
 * `serviceDomain`, `recipientAddress` and `purpose` were each bounded;
 * `id` was validated only as "a non-empty string after trimming". A
 * one-megabyte `id` passed. Thirty-two records carrying one survived a real
 * `sweep('recovery')` as `retained: 32, removed: 0`, and the store re-persisted
 * a 32 MB file that is entirely well-formed, and that will be read back and
 * re-persisted at every boot for as long as it exists. Bounding three fields
 * out of four bounds nothing.
 */

/**
 * 128 characters, against a `randomUUID`'s 36.
 *
 * Not 36: callers may supply their own `id` at `openExpectation`, and a
 * workstream-shaped identifier is longer than a UUID and still nothing like a
 * megabyte.
 */
export const MAX_EXPECTATION_ID_CHARS = 128;

/**
 * Letters, digits, dot, underscore, colon, hyphen.
 *
 * The character set is the second half of the bound and matters as much as the
 * length. An `id` is a Map key in the live book and is echoed verbatim into
 * `email.inbound.status`, so it reaches a terminal and a log line. This set
 * covers a UUID and every hand-written id in this repo while excluding
 * newlines, control characters, quotes and everything else that makes a status
 * line say something other than what happened. A `randomUUID` satisfies it
 * exactly, so anything refused here was never minted by this daemon.
 */
const EXPECTATION_ID_SHAPE = /^[A-Za-z0-9._:-]+$/;

/**
 * An `id` as it will be stored, or null when it is not one this daemon would
 * ever have minted.
 *
 * One function, used by BOTH the live verb and the load path, because the
 * §9.2 property is that a file on disk cannot mint an expectation the live API
 * would have refused, and the inverse is just as load-bearing: an `id` the
 * live API accepts and the load path refuses is an expectation that works
 * until the next restart and then silently disappears, because the store
 * re-validates every entry it writes.
 */
export function normalizeExpectationId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0 || id.length > MAX_EXPECTATION_ID_CHARS) return null;
  return EXPECTATION_ID_SHAPE.test(id) ? id : null;
}
