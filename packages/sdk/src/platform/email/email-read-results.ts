/**
 * What a mail read actually found — including the answer that used to have
 * nowhere to go.
 *
 * These shapes exist because two different reads were each collapsing a third
 * outcome into one that reads as ordinary:
 *
 *   - `listInbox` returned `{ messages, total }`. A page of UIDs 101/102/103
 *     with 102 unreadable came back as two messages and `total: 3`, and nothing
 *     said which of two things had happened — 102 was expunged between the
 *     search and the fetch (ordinary), or 102 is in the mailbox and the
 *     server's answer about it could not be read (not ordinary, and the message
 *     is missing from a list the owner is reading as complete).
 *   - `readMessage` returned `ImapMessageDetail | null`, and `null` meant both
 *     "no longer there" and "could not be read". Its caller renders the first
 *     as a sentence about the owner's mailbox, which for the second is false.
 *
 * `total` cannot carry the first, because it counts the SEARCH match and the
 * loss happens at the FETCH. So the fact travels with the result instead.
 */

import type { ImapMessageDetail } from './imap-types.js';

/**
 * One FETCH response in a listing or a read that the client could not read.
 *
 * A reason and, where it was legible, the UID it named — never message content,
 * since the whole point is that the content could not be read.
 */
export interface EmailInboxUnreadableResponse {
  /** The UID the response named, or null when it named none legibly. */
  readonly uid: number | null;
  /** Plain language, safe to log and safe to show an owner. */
  readonly detail: string;
}

/**
 * What `EmailService.readMessage` found: the message, its absence, or this
 * client's inability to read the server's answer.
 *
 * `gone` and `unreadable` used to be one answer (`null`) and are opposite
 * claims about the owner's mailbox — see `ImapMessageRead`, which this mirrors
 * at the service boundary.
 */
export type EmailMessageRead =
  | { readonly outcome: 'read'; readonly detail: ImapMessageDetail }
  | { readonly outcome: 'gone' }
  | { readonly outcome: 'unreadable'; readonly problems: readonly EmailInboxUnreadableResponse[] };
