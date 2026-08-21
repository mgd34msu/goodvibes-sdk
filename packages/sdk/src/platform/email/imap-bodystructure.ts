/**
 * Reading one whole message: BODYSTRUCTURE, MIME part selection, and decoding.
 *
 * Why a structure parser at all
 * ─────────────────────────────
 * `ImapClient.fetchMessage` returns the text of a message and a LIST of its
 * attachments, never their bytes. That distinction is the reason this file
 * exists: the server describes every part of a message in its BODYSTRUCTURE
 * reply (type, subtype, encoding, size, filename), so a client can report what
 * is attached, and then fetch ONLY the sections it wants to read. Fetching
 * `BODY[]` would have been three lines of code and would have pulled every
 * attachment, a scanned PDF, an archive, whatever a stranger chose to send,
 * down the wire and into memory on every read.
 *
 * Everything here is text in, data out: no socket, no clock, no filesystem.
 *
 * Defensive by construction
 * ─────────────────────────
 * Every function in this file takes attacker-authored input, because a message
 * body and its structure are written by whoever sent the mail. Nothing throws:
 * a malformed structure yields no parts (and therefore no attachments), an
 * unterminated string yields what was readable, and nesting is bounded. The
 * caller's contract, empty rather than an exception, depends on that holding
 * for every input, not for the inputs we thought of.
 */

import type { ImapAttachmentInfo } from './imap-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One leaf MIME part, as the server described it in BODYSTRUCTURE. */
export interface ImapBodyPart {
  /** IMAP section specifier, e.g. `1`, `2`, `1.2`, what BODY.PEEK[..] takes. */
  readonly section: string;
  /** Lowercased MIME type, e.g. `text`. */
  readonly type: string;
  /** Lowercased MIME subtype, e.g. `plain`. */
  readonly subtype: string;
  /** Lowercased content-transfer-encoding, e.g. `base64`. '' when unstated. */
  readonly encoding: string;
  /** Lowercased charset parameter. '' when unstated. */
  readonly charset: string;
  /** Filename from the disposition, or the content-type `name`. '' when none. */
  readonly filename: string;
  /** Size in bytes as the server reported it. 0 when unstated. */
  readonly sizeBytes: number;
  /**
   * True when this part is something the reader should be TOLD about rather
   * than shown: an explicit `attachment` disposition, a filename, or any
   * non-text type. The two body parts are chosen from what is left.
   */
  readonly isAttachment: boolean;
}

// ---------------------------------------------------------------------------
// S-expression reading
// ---------------------------------------------------------------------------

/** A parsed IMAP S-expression node: string, NIL (null), or a nested list. */
type SNode = string | null | SNode[];

/** Bounds adversarial nesting; real messages are a handful of levels deep. */
const MAX_NESTING_DEPTH = 24;
/** Bounds a single parse so a huge structure cannot pin a CPU. */
const MAX_STRUCTURE_CHARS = 200_000;

function readQuoted(text: string, from: number): { value: string; next: number } {
  let out = '';
  let i = from + 1; // skip opening quote
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\\' && i + 1 < text.length) {
      out += text.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return { value: out, next: i }; // unterminated — take what we read
}

function readAtom(text: string, from: number): { value: string; next: number } {
  let i = from;
  while (i < text.length && !' \t\r\n()"'.includes(text.charAt(i))) i += 1;
  return { value: text.slice(from, i), next: i };
}

/** `{n}` followed by n characters. Byte/character drift is tolerated. */
function readLiteral(text: string, from: number): { value: string; next: number } | null {
  const close = text.indexOf('}', from);
  if (close === -1) return null;
  const count = parseInt(text.slice(from + 1, close), 10);
  if (!isFinite(count) || count < 0) return null;
  let start = close + 1;
  if (text.startsWith('\r\n', start)) start += 2;
  else if (text.startsWith('\n', start)) start += 1;
  return { value: text.slice(start, start + count), next: start + count };
}

/** Scan past a list without parsing it, honouring quoted strings. */
function skipList(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const ch = text.charAt(i);
    if (ch === '"') {
      i = readQuoted(text, i).next;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  return i;
}

function parseList(text: string, from: number, depth: number): { items: SNode[]; next: number } {
  const items: SNode[] = [];
  let i = from;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === ')') return { items, next: i + 1 };
    if (ch === '(') {
      if (depth >= MAX_NESTING_DEPTH) {
        i = skipList(text, i + 1);
        continue;
      }
      const inner = parseList(text, i + 1, depth + 1);
      items.push(inner.items);
      i = inner.next;
      continue;
    }
    if (ch === '"') {
      const quoted = readQuoted(text, i);
      items.push(quoted.value);
      i = quoted.next;
      continue;
    }
    if (ch === '{') {
      const literal = readLiteral(text, i);
      if (literal !== null) {
        items.push(literal.value);
        i = literal.next;
        continue;
      }
    }
    const atom = readAtom(text, i);
    if (atom.next === i) {
      i += 1; // no progress possible on this character — step over it
      continue;
    }
    items.push(/^nil$/i.test(atom.value) ? null : atom.value);
    i = atom.next;
  }
  return { items, next: i };
}

// ---------------------------------------------------------------------------
// BODYSTRUCTURE → parts
// ---------------------------------------------------------------------------

function asText(node: SNode | undefined): string {
  return typeof node === 'string' ? node : '';
}

function asList(node: SNode | undefined): SNode[] {
  return Array.isArray(node) ? node : [];
}

/** Read `("key" "value" "key" "value")` parameter lists case-insensitively. */
function paramValue(params: SNode[], wanted: string): string {
  for (let i = 0; i + 1 < params.length; i += 2) {
    if (asText(params[i]).toLowerCase() === wanted) return asText(params[i + 1]);
  }
  return '';
}

/**
 * Find the content-disposition list without depending on where it sits.
 *
 * Its index differs by type, a text part carries an extra line count, a
 * message/rfc822 part carries an envelope and a nested body, and getting that
 * arithmetic wrong silently mislabels attachments. Instead we look for the
 * shape a disposition has: a two-element list whose head is `attachment` or
 * `inline`.
 */
function findDisposition(node: SNode[]): { value: string; params: SNode[] } {
  for (const item of node) {
    if (!Array.isArray(item)) continue;
    const head = asText(item[0]).toLowerCase();
    if (head === 'attachment' || head === 'inline') {
      return { value: head, params: asList(item[1]) };
    }
  }
  return { value: '', params: [] };
}

function leafPart(node: SNode[], section: string): ImapBodyPart {
  const type = asText(node[0]).toLowerCase();
  const subtype = asText(node[1]).toLowerCase();
  const typeParams = asList(node[2]);
  const encoding = asText(node[5]).toLowerCase();
  const size = parseInt(asText(node[6]), 10);
  const disposition = findDisposition(node.slice(7));
  const filename =
    paramValue(disposition.params, 'filename') || paramValue(typeParams, 'name');
  return {
    section,
    type,
    subtype,
    encoding,
    charset: paramValue(typeParams, 'charset').toLowerCase(),
    filename,
    sizeBytes: isFinite(size) && size > 0 ? size : 0,
    isAttachment:
      disposition.value === 'attachment' || filename.length > 0 || type !== 'text',
  };
}

function collectParts(node: SNode[], prefix: string, out: ImapBodyPart[]): void {
  if (out.length >= 200) return; // bound a pathological structure
  if (Array.isArray(node[0])) {
    // Multipart: the leading elements are the child parts, numbered from 1.
    let index = 0;
    for (const child of node) {
      if (!Array.isArray(child)) break;
      index += 1;
      collectParts(child, prefix.length > 0 ? `${prefix}.${index}` : String(index), out);
    }
    return;
  }
  // A leaf. A message with no multipart wrapper is section 1 (RFC 3501 §6.4.5).
  out.push(leafPart(node, prefix.length > 0 ? prefix : '1'));
}

/**
 * Parse a BODYSTRUCTURE expression into its leaf parts.
 * Returns an empty list for anything it cannot read, a caller that gets no
 * parts reports no attachments, which is the honest answer when the server's
 * description of the message was not readable.
 */
export function parseBodyStructure(raw: string): ImapBodyPart[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const text = raw.slice(0, MAX_STRUCTURE_CHARS);
  const open = text.indexOf('(');
  if (open === -1) return [];
  const parsed = parseList(text, open + 1, 1);
  const parts: ImapBodyPart[] = [];
  collectParts(parsed.items, '', parts);
  return parts;
}

/** The first part that should be shown as the message body, or null. */
export function selectBodyPart(
  parts: readonly ImapBodyPart[],
  subtype: 'plain' | 'html',
): ImapBodyPart | null {
  for (const part of parts) {
    if (part.type === 'text' && part.subtype === subtype && !part.isAttachment) {
      return part;
    }
  }
  return null;
}

/** Attachment metadata, names, types and sizes only, never content. */
export function attachmentsFromParts(
  parts: readonly ImapBodyPart[],
): ImapAttachmentInfo[] {
  const infos: ImapAttachmentInfo[] = [];
  for (const part of parts) {
    if (!part.isAttachment) continue;
    infos.push({
      filename: part.filename,
      contentType: part.type.length > 0 ? `${part.type}/${part.subtype}` : '',
      sizeBytes: part.sizeBytes,
    });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Transfer decoding
// ---------------------------------------------------------------------------

function decodeQuotedPrintable(raw: string): Buffer {
  const joined = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined.charAt(i);
    if (ch === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = joined.charCodeAt(i);
    // The socket already decoded UTF-8, so a character above 0x7f here came
    // from an 8-bit body; re-encode it rather than truncating it to one byte.
    if (code > 0x7f) {
      for (const byte of Buffer.from(ch, 'utf8')) bytes.push(byte);
      continue;
    }
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

/** Charsets we can turn back into text without pulling in an encoding table. */
function decodeCharset(buffer: Buffer, charset: string): string {
  if (/^(iso-?8859-1|latin-?1|windows-1252|cp1252)$/.test(charset)) {
    return buffer.toString('latin1');
  }
  return buffer.toString('utf8');
}

/**
 * Turn one fetched section into readable text.
 *
 * Handles base64 and quoted-printable, which is what mail actually arrives as;
 * 7bit/8bit/binary sections are already text by the time the socket has decoded
 * them. Never throws, an encoding we cannot undo yields the raw section, which
 * is worse to read than the real thing and better than nothing.
 */
export function decodeTextPart(raw: string, encoding: string, charset: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    if (encoding === 'base64') {
      const cleaned = raw.replace(/[^A-Za-z0-9+/=]/g, '');
      return decodeCharset(Buffer.from(cleaned, 'base64'), charset).replace(/\r\n/g, '\n');
    }
    if (encoding === 'quoted-printable') {
      return decodeCharset(decodeQuotedPrintable(raw), charset).replace(/\r\n/g, '\n');
    }
    return raw.replace(/\r\n/g, '\n');
  } catch {
    return raw.replace(/\r\n/g, '\n');
  }
}

// ---------------------------------------------------------------------------
// FETCH response reading
// ---------------------------------------------------------------------------

const FETCH_START = /^\* \d+ FETCH \(/;
/** `BODY[..]` or `BODY.PEEK[..]`, with an optional `<partial>` suffix. */
const SECTION_MARKER = /BODY(?:\.PEEK)?\[[^\]]*\](?:<[^>]*>)?[ \t]*/;
/** The line that closes a FETCH response: `)`, or `UID 42)` on some servers. */
const RESPONSE_END = /^\s*(?:UID \d+\s*)?\)\s*$/;

/** True when the server actually returned a message for the fetch. */
export function hasFetchResponse(lines: readonly string[]): boolean {
  return lines.some((line) => FETCH_START.test(line));
}

/**
 * Pull the section payload out of a single-message FETCH response.
 *
 * The session inlines a `{n}` literal into the line that announced it, so the
 * payload usually arrives as the tail of the `* n FETCH (BODY[..] ` line;
 * short sections may instead arrive as a quoted string, and an absent one as
 * NIL. Returns null when there was no FETCH response at all, which is how a
 * UID that no longer exists is told apart from a section that is empty.
 */
export function extractFetchSection(lines: readonly string[]): string | null {
  const startIndex = lines.findIndex((line) => FETCH_START.test(line));
  if (startIndex === -1) return null;

  const first = lines[startIndex] ?? '';
  const marker = SECTION_MARKER.exec(first);
  let head = marker === null ? '' : first.slice(marker.index + marker[0].length);

  if (head.startsWith('"')) {
    return readQuoted(head, 0).value;
  }
  if (/^NIL\)?\s*$/i.test(head.trim())) return '';
  if (head === ')') head = '';

  const collected: string[] = head.length > 0 ? [head] : [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // The response closes with `)`, which a server that puts the automatic
    // UID item last writes as `UID 42)`. Either ends the payload; so does the
    // tagged completion, in case the close never arrives.
    if (RESPONSE_END.test(line) || /^A\d+ (OK|NO|BAD)\b/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n');
}

/**
 * Pull the BODYSTRUCTURE expression out of a FETCH response.
 * Lines are joined first, because a literal inside the structure (a filename,
 * typically) fragments the response across several of them.
 */
export function extractBodyStructure(lines: readonly string[]): string {
  const joined = lines.join('\r\n');
  const marker = /BODYSTRUCTURE\s*/i.exec(joined);
  if (marker === null) return '';
  const rest = joined.slice(marker.index + marker[0].length);
  if (!rest.startsWith('(')) return '';
  const end = skipList(rest, 1);
  return rest.slice(0, end);
}
