/**
 * Reading an IMAP server's answers: header blocks, delivery evidence, and the
 * three FETCH/SEARCH response shapes the client asks for.
 *
 * Split out of `imap-client.ts` so both halves stay under the repository's
 * per-file line cap. Nothing here touches a socket, a clock or the filesystem —
 * every function takes text and returns data, which is what lets the
 * top-most-only rules below be tested without a server.
 */

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
 */
export function parseSearchNumbers(searchResponse: readonly string[]): number[] {
  const nums: number[] = [];
  for (const line of searchResponse) {
    if (!line.startsWith('* SEARCH')) continue;
    const parts = line.slice(9).trim().split(/\s+/);
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n > 0) nums.push(n);
    }
  }
  return nums;
}

/**
 * The `UID` data item of each FETCH response, keyed by the response's own
 * sequence number.
 *
 * `* 3 FETCH (UID 307 BODY[...] ...)` maps 3 → 307. The `3` is a sequence
 * number even when the command was `UID FETCH`, which is exactly why the two
 * have to be read separately and joined rather than assumed equal.
 *
 * Only the data-item list ahead of the first `BODY`/`BODYSTRUCTURE` token is
 * searched, so a `UID 12` written inside a message body cannot be read back as
 * the message's UID.
 */
export function parseFetchUids(fetchLines: readonly string[]): Record<number, number> {
  const result: Record<number, number> = {};
  for (const line of fetchLines) {
    const start = /^\* (\d+) FETCH/.exec(line);
    if (start === null) continue;
    const bodyAt = line.indexOf('BODY');
    const items = bodyAt === -1 ? line : line.slice(0, bodyAt);
    const uidMatch = /\bUID (\d+)/.exec(items);
    if (uidMatch === null) continue;
    const seqNum = parseInt(start[1] ?? '0', 10);
    const uid = parseInt(uidMatch[1] ?? '0', 10);
    if (seqNum > 0 && uid > 0) result[seqNum] = uid;
  }
  return result;
}

export function parseFetchHeaders(fetchLines: readonly string[]): Record<number, string> {
  const result: Record<number, string> = {};
  let seqNum = 0;
  let headerAccum = '';
  let inBody = false;

  for (const line of fetchLines) {
    const fetchStart = /^\* (\d+) FETCH/.exec(line);
    if (fetchStart) {
      seqNum = parseInt(fetchStart[1] ?? '0', 10);
      headerAccum = '';
      inBody = true;
      // The literal content may be appended after the header-fields marker on the same line
      const afterFetch = line.slice(fetchStart[0].length);
      const literalAfter = afterFetch.indexOf(' ') !== -1 ? afterFetch.slice(afterFetch.indexOf(' ') + 1) : '';
      if (literalAfter && !literalAfter.startsWith('(')) {
        headerAccum += literalAfter + '\n';
      }
      continue;
    }
    if (inBody) {
      if (line === ')') {
        if (seqNum > 0) result[seqNum] = headerAccum;
        inBody = false;
        seqNum = 0;
        headerAccum = '';
      } else {
        headerAccum += line + '\n';
      }
    }
  }
  return result;
}

export function parseFetchBody(fetchLines: readonly string[]): Record<number, string> {
  const result: Record<number, string> = {};
  let seqNum = 0;
  let bodyAccum = '';
  let inBody = false;

  for (const line of fetchLines) {
    const fetchStart = /^\* (\d+) FETCH/.exec(line);
    if (fetchStart) {
      seqNum = parseInt(fetchStart[1] ?? '0', 10);
      bodyAccum = '';
      inBody = true;
      // literal content appended after BODY.PEEK[TEXT] tag
      const afterLiteral = line.slice(line.indexOf(' ', fetchStart[0].length) + 1);
      if (afterLiteral && !afterLiteral.includes('BODY')) {
        bodyAccum += afterLiteral + '\n';
      }
      continue;
    }
    if (inBody) {
      if (line === ')') {
        if (seqNum > 0) result[seqNum] = bodyAccum;
        inBody = false;
        seqNum = 0;
        bodyAccum = '';
      } else {
        bodyAccum += line + '\n';
      }
    }
  }
  return result;
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
