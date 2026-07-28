/**
 * Reading an IMAP server's answers: header blocks, delivery evidence, and the
 * three FETCH/SEARCH response shapes the client asks for.
 *
 * Split out of `imap-client.ts` so both halves stay under the repository's
 * per-file line cap. Nothing here touches a socket, a clock or the filesystem —
 * every function takes text and returns data, which is what lets the
 * top-most-only rules below be tested without a server.
 */

import { fetchSection, parseFetchResponses } from './imap-fetch-response.js';
// The 32-bit protocol ceiling, imported rather than restated. `source-cursor.ts`
// states the reasoning at length and is a leaf module (its only import is
// `inbound/types.js`, which imports nothing), so there is one bound and no way
// for the reader of the wire and the writer of the cursor to disagree about it.
import { MAX_IMAP_UID } from './inbound/source-cursor.js';
import type {
  ImapEnvelope,
  ImapEnvelopeBatch,
  ImapFetchProblem,
} from './imap-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which header field a delivery-evidence value was read from.
 * Both names are stamped by the final delivery agent, not by the sender —
 * that is what makes them evidence. `to-header` is deliberately absent from
 * this union: the To: header is sender-authored and is never evidence.
 */
export type DeliveryEvidenceSource = 'delivered-to' | 'x-original-to';

/** One delivery-evidence value with its provenance attached. */
export interface DeliveryEvidence {
  /** Normalized bare address, lowercased (angle-addr unwrapped when present). */
  readonly address: string;
  /** The header value exactly as received, before normalization. */
  readonly rawValue: string;
  /** The header field this came from. */
  readonly source: DeliveryEvidenceSource;
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

/** One header field after RFC 5322 unfolding. `name` is lowercased. */
interface HeaderField {
  readonly name: string;
  readonly value: string;
}

/** Defensive bound on a single unfolded header value. */
const MAX_HEADER_VALUE_CHARS = 2_000;

/**
 * Split a raw header block into ordered, unfolded fields.
 *
 * Order is load-bearing: delivery agents PREPEND their trace headers, so the
 * first occurrence of a delivery header is the one our own infrastructure
 * wrote and every later occurrence arrived with the message.
 *
 * Parsing stops at the first blank line once at least one field has been seen,
 * because everything after it is message body — a sender who pastes
 * `Delivered-To: victim@example.com` into the body must not be able to have it
 * read back as a header. Never throws; malformed input yields fewer fields.
 */
function parseHeaderFields(rawHeaders: string): HeaderField[] {
  const fields: HeaderField[] = [];
  if (typeof rawHeaders !== 'string' || rawHeaders.length === 0) return fields;

  const unfolded: string[] = [];
  for (const line of rawHeaders.split(/\r\n|\n|\r/)) {
    if (line.length === 0) {
      // Leading blank lines are tolerated; a blank line after real headers
      // ends the header block.
      if (unfolded.length > 0) break;
      continue;
    }
    if (/^[\t ]/.test(line)) {
      // Continuation of the previous field (RFC 5322 §2.2.3 unfolding).
      const owner = unfolded.length - 1;
      if (owner < 0) continue; // continuation with no owner — malformed, drop
      const merged = `${unfolded[owner] ?? ''} ${line.trim()}`;
      unfolded[owner] = merged.slice(0, MAX_HEADER_VALUE_CHARS);
      continue;
    }
    unfolded.push(line.slice(0, MAX_HEADER_VALUE_CHARS));
  }

  for (const entry of unfolded) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue; // no field name — malformed, drop
    const name = entry.slice(0, colon).trim().toLowerCase();
    // RFC 5322 field names are printable US-ASCII excluding ':'.
    if (name.length === 0 || /[^\x21-\x39\x3b-\x7e]/.test(name)) continue;
    fields.push({ name, value: entry.slice(colon + 1).trim() });
  }
  return fields;
}

/** First occurrence of a header, unfolded and trimmed. '' when absent. */
export function extractHeader(rawHeaders: string, name: string): string {
  const wanted = name.toLowerCase();
  for (const field of parseHeaderFields(rawHeaders)) {
    if (field.name === wanted) return field.value;
  }
  return '';
}

const DELIVERY_HEADER_NAMES: readonly DeliveryEvidenceSource[] = [
  'delivered-to',
  'x-original-to',
];

/**
 * Reduce a header value to a bare, lowercased address.
 * `Alias <a@b.test>` and `<a@b.test>` and `a@b.test` all yield `a@b.test`.
 * Returns '' when nothing address-shaped is present.
 */
function normalizeDeliveryAddress(rawValue: string): string {
  const angle = /<([^<>]*)>/.exec(rawValue);
  const candidate = (angle?.[1] ?? rawValue).trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > 320) return '';
  if (!/^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+$/.test(candidate)) return '';
  return candidate;
}

/**
 * Extract delivery evidence from a raw header block.
 *
 * Only the TOP-MOST delivery header in the block is returned. A sender can put
 * their own `Delivered-To:`/`X-Original-To:` lines in the message they submit,
 * and those always land BELOW the line the receiving delivery agent prepends —
 * so every occurrence after the first is attacker-reachable and is discarded.
 *
 * Deliberately conservative: we do not additionally trust the second delivery
 * header even when it carries the other field name. If our delivery agent does
 * not stamp `X-Original-To`, then the top-most `X-Original-To` in a message
 * would be the sender's own, so "top-most per field name" would be forgeable.
 * The mailbox (`ImapEnvelope.mailbox`) remains the primary anchor.
 */
export function extractDeliveryEvidence(rawHeaders: string): DeliveryEvidence[] {
  for (const field of parseHeaderFields(rawHeaders)) {
    const source = DELIVERY_HEADER_NAMES.find((name) => name === field.name);
    if (source === undefined) continue;
    const address = normalizeDeliveryAddress(field.value);
    // The top-most delivery header is the only candidate; if it does not
    // normalize to an address we report no evidence rather than looking lower.
    return address.length === 0
      ? []
      : [{ address, rawValue: field.value, source }];
  }
  return [];
}

/**
 * The top-most `Authentication-Results` header, or none.
 *
 * Same reasoning as `extractDeliveryEvidence`: a sender can embed their own
 * copy, and it lands below the receiving server's. Only the first is returned,
 * and a message with none yields an empty list rather than a default verdict.
 */
export function extractAuthenticationResults(rawHeaders: string): string[] {
  for (const field of parseHeaderFields(rawHeaders)) {
    if (field.name === 'authentication-results') {
      return field.value.trim().length > 0 ? [field.value] : [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * The numbers in a `* SEARCH ...` response, in the order the server gave them.
 *
 * A server answers `SEARCH` with sequence numbers and `UID SEARCH` with UIDs,
 * in the same untagged `* SEARCH` line either way — the wire shape carries no
 * mark of which it is. The caller knows which command it sent, so the name
 * here says "numbers" rather than claiming one or the other. This client only
 * ever sends `UID SEARCH`.
 *
 * BOUNDED AT BOTH ENDS, and the upper bound is not decoration. Sequence
 * numbers and UIDs are both 32-bit (RFC 3501 §2.3.1.1); `parseInt` is not.
 * `parseInt('99999999999999999999', 10)` is `1e20`, `Number.isInteger(1e20)`
 * is true, and that value used to travel from this line straight into
 * `MailboxCursorStore.advance()`, where `Math.max` would pin the cursor above
 * every UID a server can ever issue with no way for a later pass to bring it
 * down. A token outside the protocol's range names no message this client can
 * fetch, so it is dropped here rather than carried on as a number that still
 * looks usable.
 */
export function parseSearchNumbers(searchResponse: readonly string[]): number[] {
  const nums: number[] = [];
  for (const line of searchResponse) {
    if (!line.startsWith('* SEARCH')) continue;
    const parts = line.slice(9).trim().split(/\s+/);
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n > 0 && n <= MAX_IMAP_UID) nums.push(n);
    }
  }
  return nums;
}

/**
 * Turn the lines of one envelope `UID FETCH` into envelopes, and say plainly
 * which responses could not be read.
 *
 * The second half is the point. A caller that advances a cursor has to tell
 * two things apart that used to look identical from here:
 *
 *   - the server sent NO response for a UID — it was expunged between the
 *     search and the fetch, and the cursor may move past it;
 *   - the server sent a response for it and this client could not read the
 *     answer — nothing is known about that message, and moving the cursor
 *     would skip mail that is still sitting in the mailbox.
 *
 * So every response that arrives is accounted for: it becomes an envelope, or
 * it becomes an entry in `unreadable` with a plain-language reason. Nothing is
 * dropped on the floor, which is what `parseFetchHeaders` and `parseFetchUids`
 * did between them — a response whose UID could not be located was skipped in
 * silence, and read downstream as an expunge.
 */
export function readEnvelopeBatch(
  fetchLines: readonly string[],
  mailbox: string,
  wanted: readonly number[],
): ImapEnvelopeBatch {
  const byUid = new Map<number, string>();
  const unreadable: ImapFetchProblem[] = [];

  for (const response of parseFetchResponses(fetchLines)) {
    const seq = response.seq > 0 ? response.seq : null;
    if (response.parseError !== null) {
      unreadable.push({ seq, uid: response.uid, detail: response.parseError });
      continue;
    }
    if (response.uid === null) {
      unreadable.push({
        seq,
        uid: null,
        detail: `the FETCH response for sequence number ${response.seq} carried no UID data `
          + `item, so it cannot be attributed to a message`,
      });
      continue;
    }
    const raw = fetchSection(response, (spec) => spec.startsWith('HEADER'));
    if (raw === null) {
      unreadable.push({
        seq,
        uid: response.uid,
        detail: `the FETCH response for UID ${response.uid} carried no header section`,
      });
      continue;
    }
    byUid.set(response.uid, raw);
  }

  const envelopes: ImapEnvelope[] = [];
  for (const uid of wanted) {
    const raw = byUid.get(uid);
    if (raw === undefined) continue;
    const deliveryEvidence = extractDeliveryEvidence(raw);
    envelopes.push({
      uid,
      from: extractHeader(raw, 'From'),
      subject: extractHeader(raw, 'Subject'),
      date: extractHeader(raw, 'Date'),
      messageId: extractHeader(raw, 'Message-ID'),
      mailbox,
      deliveredTo: deliveryEvidence.map((entry) => entry.address),
      deliveryEvidence,
      // Display only — see the field docs on ImapEnvelope.
      unverifiedToHeaderClaim: extractHeader(raw, 'To'),
      authenticationResults: extractAuthenticationResults(raw),
    });
  }
  return { envelopes, unreadable };
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The capability atoms a server named, from anywhere it named them.
 *
 * Servers advertise in three places and no server uses all three: inside the
 * greeting as `* OK [CAPABILITY ...]`, as an untagged `* CAPABILITY ...` line,
 * and inside a tagged completion as `... OK [CAPABILITY ...]`. All three are
 * read here so a caller does not have to ask again for something the server
 * already volunteered.
 *
 * Atoms are upper-cased and de-duplicated, order preserved. An empty result
 * means the server said nothing — which is NOT the same as "supports nothing",
 * and callers must not read it that way.
 */
export function parseCapabilities(lines: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    for (const atom of raw.trim().split(/\s+/)) {
      const upper = atom.toUpperCase();
      if (upper.length === 0 || seen.has(upper)) continue;
      seen.add(upper);
      found.push(upper);
    }
  };

  for (const line of lines) {
    const bracketed = /\[CAPABILITY ([^\]]*)\]/i.exec(line);
    if (bracketed !== null) add(bracketed[1] ?? '');
    const untagged = /^\* CAPABILITY (.*)$/i.exec(line);
    if (untagged !== null) add(untagged[1] ?? '');
  }
  return found;
}

// ---------------------------------------------------------------------------
// Mailbox status, as EXAMINE reports it
// ---------------------------------------------------------------------------

/**
 * What the server said about the mailbox when it was EXAMINEd.
 *
 * `uidValidity` is the field that matters most and is the one most easily
 * ignored: when it changes, every UID recorded under the old value names
 * nothing, because the mailbox was recreated. Anything keeping a UID across
 * connections has to store this alongside it.
 *
 * Every field is null when the server did not report it. Nothing here is
 * defaulted to zero — a missing UIDVALIDITY is not the same fact as
 * `UIDVALIDITY 0`, and a caller that has to tell the difference cannot if we
 * invent one.
 */
export interface ImapMailboxStatus {
  /** `* n EXISTS` — how many messages the mailbox holds. */
  readonly exists: number | null;
  /** `* OK [UIDVALIDITY n]` — the generation the UIDs below belong to. */
  readonly uidValidity: number | null;
  /** `* OK [UIDNEXT n]` — the UID the next arriving message will be given. */
  readonly uidNext: number | null;
  /** True when the completion carried `[READ-ONLY]`, as EXAMINE's does. */
  readonly readOnly: boolean;
}

/** Read an EXAMINE (or SELECT) response into its mailbox facts. */
export function parseMailboxStatus(lines: readonly string[]): ImapMailboxStatus {
  let exists: number | null = null;
  let uidValidity: number | null = null;
  let uidNext: number | null = null;
  let readOnly = false;

  for (const line of lines) {
    const existsMatch = /^\* (\d+) EXISTS\b/.exec(line);
    if (existsMatch !== null) {
      exists = parseInt(existsMatch[1] ?? '0', 10);
      continue;
    }
    const validity = /\[UIDVALIDITY (\d+)\]/.exec(line);
    if (validity !== null) uidValidity = parseInt(validity[1] ?? '0', 10);
    const next = /\[UIDNEXT (\d+)\]/.exec(line);
    if (next !== null) uidNext = parseInt(next[1] ?? '0', 10);
    if (line.includes('[READ-ONLY]')) readOnly = true;
  }

  return { exists, uidValidity, uidNext, readOnly };
}

// ---------------------------------------------------------------------------
// Formatted date for SINCE queries
// ---------------------------------------------------------------------------

const IMAP_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatImapDate(date: Date): string {
  const d = date.getDate();
  const m = IMAP_MONTHS[date.getMonth()] ?? 'Jan';
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}
