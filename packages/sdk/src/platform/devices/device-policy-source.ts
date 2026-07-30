/**
 * device-policy-source.ts — how the device stores and the capability service
 * take their policy.
 *
 * Every one of them used to freeze its policy at construction. That is correct
 * for a fixture and wrong for a daemon: the owner changes `device.*` in the
 * settings workspace and expects the next request to honour it, exactly the way
 * `device.nodes.maxPaired` is re-read at every pairing. So each of them now
 * accepts EITHER a fixed partial (unchanged behaviour, still what tests pass) or
 * a resolver called at each use, and the surface hands over a resolver that
 * reads the live configuration.
 *
 * Merging against the defaults happens on every resolve, so a resolver may
 * return as few fields as it knows about and a field it omits keeps the stock
 * value rather than becoming undefined.
 */

/** A fixed partial policy, or a function that produces one on demand. */
export type DevicePolicySource<T extends object> = Partial<T> | (() => Partial<T>);

/**
 * Turn either form into "call this to get the full policy". A fixed partial is
 * merged once and returned as the same frozen object; a resolver is called (and
 * re-merged) on every access.
 */
export function resolveDevicePolicySource<T extends object>(
  source: DevicePolicySource<T> | undefined,
  defaults: T,
): () => T {
  if (typeof source === 'function') {
    return () => ({ ...defaults, ...source() });
  }
  const fixed: T = { ...defaults, ...(source ?? {}) };
  return () => fixed;
}
