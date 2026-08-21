/**
 * address-digest.ts, how a mail address is written down when something has to
 * be written down.
 *
 * An operational log needs to be able to say "the same recipient again" and
 * "a different recipient" without ever holding the address that would answer
 * either question directly. A truncated SHA-256 of the normalised address does
 * that: stable across runs and processes, comparable, and not reversible by
 * reading the log.
 *
 * The rule this exists to keep: no raw email address reaches a log field from
 * the mail or calendar gateway path. Not the sender, not the recipient, not
 * inside a message the log is describing. A log line is copied into a support
 * thread, a screenshot, or a bug report far more casually than a mailbox is,
 * and an address in one of those is an address in all of them.
 */

import { createHash } from 'node:crypto';

/**
 * A stable, non-reversible digest of an address, for logging.
 *
 * Normalised (trimmed, lower-cased) before hashing so `Alice@Example.com ` and
 * `alice@example.com` digest identically, otherwise correlating on the digest
 * would silently miss the same person written two ways.
 *
 * A recipient list (`a@x, b@y`) digests as ONE value, which is what the caller
 * wants: it identifies the delivery, not each addressee.
 */
export function addressDigest(address: string): string {
  return createHash('sha256').update(address.toLowerCase().trim(), 'utf-8').digest('hex').slice(0, 16);
}
