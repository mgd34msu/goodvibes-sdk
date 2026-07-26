/**
 * push/vapid-subject.ts
 *
 * The VAPID `sub` contact — its fallback, its validity rule, and its wording.
 *
 * Deliberately dependency-free (no `node:` imports, no Buffer) so the config
 * schema can gate `push.vapidSubject` with the SAME predicate `VapidManager`
 * enforces, without dragging the crypto-bearing vapid.ts into the browser-safe
 * config bundle. One rule, two enforcement points, no drift.
 */

/**
 * The fallback `sub` when no contact is configured. It is a real, well-formed
 * mailto that push services accept — but it reaches nobody, which is exactly
 * why the `push.vapidSubject` config key exists.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:goodvibes-push@localhost';

/** The message a rejected subject reports, shared by the config gate and the manager. */
export const VAPID_SUBJECT_HINT =
  'a mailto: address or an https: URL a push service can use to reach you';

/**
 * RFC 8292 §2.1: the `sub` claim is a contact URI for the application server —
 * in practice a `mailto:` address or an `https:` page a push service operator
 * can use to report a delivery problem. Anything else is rejected rather than
 * signed into every JWT the daemon ever sends.
 */
export function isValidVapidSubject(subject: string): boolean {
  if (subject.length === 0 || /\s/.test(subject)) return false;
  let parsed: URL;
  try {
    parsed = new URL(subject);
  } catch {
    return false;
  }
  if (parsed.protocol === 'mailto:') {
    // `new URL('mailto:x')` keeps the address in `pathname`; require something
    // shaped like an address rather than an empty or host-only mailto.
    return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(parsed.pathname);
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0;
}
