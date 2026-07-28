/**
 * Reading `* n FETCH (...)` responses whole.
 *
 * This exists because the two ad hoc readers it replaces each searched a FETCH
 * response for one thing and made an assumption about everything else, and both
 * assumptions were wrong against a real server.
 *
 * What a real server actually sends
 * ─────────────────────────────────
 * A `BODY[...]` section arrives as a `{N}` literal — RFC 3501 §4.3 — which is a
 * byte count on the end of the line followed by exactly that many bytes:
 *
 *     * 3 FETCH (UID 307 BODY[HEADER.FIELDS (FROM SUBJECT)] {58}
 *     From: a@b.test
 *     Subject: Hello
 *
 *     )
 *
 * `ImapSession` reads the count, takes the bytes, and hands the response up as
 * ONE string with the payload welded onto the line that announced it. That is
 * the correct thing to do — the payload is not lines, it is bytes, and it may
 * contain anything including a line that looks like a response. But it means
 * every reader downstream sees a `* 3 FETCH (` line with a whole header block
 * hanging off the end of it, and a reader that expected the payload on lines of
 * its own finds nothing.
 *
 * The old `parseFetchHeaders` did worse than find nothing: it tested whether
 * the text after `* n FETCH ` started with `(` and discarded it if so. Against
 * a folded literal that text is `(UID 307 BODY[...] From: a@b.test…` — so the
 * whole header block went out with the data items it was welded to, and the
 * client built envelopes with every field empty while reporting success.
 *
 * Where the UID is, is the server's choice
 * ────────────────────────────────────────
 * `UID FETCH` makes the server include a `UID` data item whether or not it was
 * asked for (§6.4.8), and the server chooses where in the list it goes. Both of
 * these are conformant and both are in the wild:
 *
 *     * 3 FETCH (UID 307 BODY[HEADER.FIELDS (…)] {58}…)
 *     * 3 FETCH (BODY[HEADER.FIELDS (…)] {58}… UID 307)
 *
 * In the second, the `UID` lands AFTER the literal, which means it is not on
 * the `* n FETCH` line at all — it is on the line that closes the response. The
 * old `parseFetchUids` searched `line.slice(0, line.indexOf('BODY'))` of the
 * start line only, found nothing, and returned an empty map; the client then
 * produced no envelopes and the caller could not tell that from an empty
 * mailbox.
 *
 * So this reads the response as a response
 * ────────────────────────────────────────
 * One pass over the lines, tracking parenthesis depth, quoted strings and
 * `[section]` brackets, collecting the data items at depth 1 as structural text
 * and every `BODY[...]` payload as opaque bytes. A `UID` is then read from the
 * structural text, from wherever in the response it appeared — and never from
 * inside a payload, because payload text is never structural text.
 *
 * A response that cannot be read says so
 * ──────────────────────────────────────
 * `parseError` is the field this module exists for as much as the payloads are.
 * A caller advancing a cursor has to distinguish "the server did not mention
 * this message" from "the server mentioned it and we could not read the answer",
 * and it can only do that if the second one is reported rather than silently
 * looking like the first.
 */

/** One `* n FETCH (...)` response, read whole. */
export interface ImapFetchResponse {
  /**
   * The response's own sequence number.
   *
   * NOT a UID, even under `UID FETCH` — the prefix is a sequence number in both
   * commands, which is exactly why `uid` is read separately and joined rather
   * than assumed equal.
   */
  readonly seq: number;
  /** The `UID` data item, from wherever in the response it appeared. */
  readonly uid: number | null;
  /**
   * `BODY[<spec>]` payloads, keyed by the section spec upper-cased with runs of
   * whitespace collapsed: `HEADER.FIELDS (FROM SUBJECT)`, `TEXT`, or `''` for
   * `BODY[]`. A `<partial>` suffix is not part of the key.
   */
  readonly sections: ReadonlyMap<string, string>;
  /**
   * Null when the response was read whole; a plain-language reason when it was
   * not.
   *
   * A response carrying this describes NOTHING about the message it named. A
   * caller must not read the resulting absence as the message being gone.
   */
  readonly parseError: string | null;
}

/** `* 3 FETCH ` — the sequence number and the start of the data-item list. */
const FETCH_START = /^\* (\d+) FETCH /;

/** A tagged completion, which ends any response still open before it. */
const TAGGED_COMPLETION = /^\S+ (?:OK|NO|BAD)\b/;

/**
 * The line that closes a response whose payload arrived on lines of its own:
 * `)`, or `UID 42)` on a server that puts the automatic UID item last.
 */
const CONTINUATION_END = /^\s*(?:UID (\d+)\s*)?\)\s*$/;

/**
 * Defensive bound on the structural (non-payload) text of one response.
 *
 * Payloads are already bounded by the session's literal cap. This bounds the
 * data-item list itself, and hitting it is reported as a parse failure rather
 * than quietly truncated — a truncated data-item list is where the `UID` would
 * have been.
 */
const MAX_STRUCTURAL_CHARS = 64_000;

/** Defensive bound on how many lines one unterminated response may absorb. */
const MAX_RESPONSE_LINES = 10_000;

interface OpenResponse {
  readonly seq: number;
  depth: number;
  inQuote: boolean;
  inBracket: boolean;
  bracketAccum: string;
  structural: string;
  truncated: boolean;
  readonly sections: Map<string, string>;
  /**
   * Set when a `BODY[...]` marker ended its line with no value on it, meaning
   * the payload is arriving on the following lines instead of as a folded
   * literal. Held until the closing `)` line.
   */
  pending: { readonly spec: string; readonly collected: string[] } | null;
  closed: boolean;
  error: string | null;
  lines: number;
}

function newOpenResponse(seq: number): OpenResponse {
  return {
    seq,
    depth: 0,
    inQuote: false,
    inBracket: false,
    bracketAccum: '',
    structural: '',
    truncated: false,
    sections: new Map<string, string>(),
    pending: null,
    closed: false,
    error: null,
    lines: 0,
  };
}

function normalizeSpec(spec: string): string {
  return spec.trim().replace(/\s+/g, ' ').toUpperCase();
}

function describeSection(spec: string): string {
  return spec.length === 0 ? 'BODY[]' : `BODY[${spec}]`;
}

/** Read a quoted string starting at the opening quote. */
function readQuotedString(text: string, from: number): { value: string; next: number } {
  let value = '';
  let index = from + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\' && index + 1 < text.length) {
      value += text.charAt(index + 1);
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  return { value, next: text.length };
}

/**
 * Read the value that follows a `BODY[...]` marker, and report where scanning
 * of structural text resumes.
 *
 * Three forms are legal and all three appear in the wild:
 *
 *   - a `{n}` literal, which the session has already folded onto this line, so
 *     it runs to the end of the chunk and every later data item is on the next
 *     line — this is what essentially every server sends for a header block;
 *   - a quoted string, which some servers use for very short sections;
 *   - `NIL`, meaning the section is absent, which is not the same as unreadable.
 *
 * A marker with nothing after it on the line is the fourth case: the payload is
 * on the lines that follow. That shape does not come off a real socket, because
 * the session folds literals — but it is what a scripted response looks like,
 * and reading it costs nothing.
 */
function readSectionValue(open: OpenResponse, chunk: string, from: number): number {
  const spec = normalizeSpec(open.bracketAccum);
  open.bracketAccum = '';
  let index = from;

  // `<0.4096>`: the partial-section suffix. Part of the marker, not the key.
  const partial = /^<[0-9.]*>/.exec(chunk.slice(index));
  if (partial !== null) index += partial[0].length;
  while (chunk.charAt(index) === ' ' || chunk.charAt(index) === '\t') index += 1;

  if (index >= chunk.length) {
    open.pending = { spec, collected: [] };
    return chunk.length;
  }
  if (chunk.charAt(index) === '"') {
    const quoted = readQuotedString(chunk, index);
    open.sections.set(spec, quoted.value);
    return quoted.next;
  }
  const rest = chunk.slice(index);
  if (/^NIL(?=[\s)]|$)/i.test(rest)) {
    open.sections.set(spec, '');
    return index + 3;
  }
  // A folded literal: byte-exact, so it owns the remainder of this line.
  open.sections.set(spec, rest);
  return chunk.length;
}

/** Scan one line of structural (non-payload) response text. */
function consume(open: OpenResponse, chunk: string): void {
  let index = 0;
  while (index < chunk.length) {
    const char = chunk.charAt(index);

    if (open.inQuote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') open.inQuote = false;
      index += 1;
      continue;
    }
    if (open.inBracket) {
      if (char === ']') {
        open.inBracket = false;
        index = readSectionValue(open, chunk, index + 1);
        continue;
      }
      open.bracketAccum += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      open.inQuote = true;
      index += 1;
      continue;
    }
    if (char === '[') {
      open.inBracket = true;
      open.bracketAccum = '';
      index += 1;
      continue;
    }
    if (char === '(') {
      open.depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      open.depth -= 1;
      if (open.depth <= 0) {
        open.closed = true;
        return;
      }
      index += 1;
      continue;
    }
    // Only the top-level data-item list is structural. A `UID 5` nested inside
    // a parenthesised item, a quoted string or a section spec is not the
    // message's UID and must not be read as one.
    if (open.depth === 1) {
      if (open.structural.length >= MAX_STRUCTURAL_CHARS) {
        open.truncated = true;
      } else {
        open.structural += char;
      }
    }
    index += 1;
  }
}

/** Feed one line to a response whose payload is arriving on its own lines. */
function consumePending(open: OpenResponse, line: string): void {
  const pending = open.pending;
  if (pending === null) return;
  const end = CONTINUATION_END.exec(line);
  if (end === null) {
    pending.collected.push(line);
    return;
  }
  open.sections.set(pending.spec, pending.collected.join('\n'));
  open.pending = null;
  // The closing line is where a trailing `UID` data item lives on the servers
  // that write one; it is structural text and is read as such.
  if (end[1] !== undefined) open.structural += ` UID ${end[1]} `;
  open.closed = true;
}

function seal(open: OpenResponse): ImapFetchResponse {
  let error = open.error;
  if (error === null && open.truncated) {
    error = `the FETCH response for sequence number ${open.seq} listed more than `
      + `${MAX_STRUCTURAL_CHARS} characters of data items and was not read`;
  }
  if (error === null && open.pending !== null) {
    error = `the ${describeSection(open.pending.spec)} section of the FETCH response for `
      + `sequence number ${open.seq} was announced but never closed`;
  }
  if (error === null && !open.closed) {
    error = `the FETCH response for sequence number ${open.seq} was never closed`;
  }
  const uidMatch = error === null ? /\bUID (\d+)\b/.exec(open.structural) : null;
  const uid = uidMatch === null ? null : parseInt(uidMatch[1] ?? '0', 10);
  return {
    seq: open.seq,
    uid: uid !== null && uid > 0 ? uid : null,
    sections: open.sections,
    parseError: error,
  };
}

/**
 * Read every `* n FETCH (...)` response in a command's collected lines.
 *
 * Responses come back in the order the server sent them. Anything that is not
 * part of a FETCH response — the tagged completion, other untagged data — is
 * ignored rather than guessed at.
 */
export function parseFetchResponses(lines: readonly string[]): ImapFetchResponse[] {
  const responses: ImapFetchResponse[] = [];
  let open: OpenResponse | null = null;

  const close = (reason: string | null): void => {
    if (open === null) return;
    if (reason !== null && open.error === null && !open.closed) open.error = reason;
    responses.push(seal(open));
    open = null;
  };

  for (const line of lines) {
    const start = FETCH_START.exec(line);

    if (open !== null) {
      // A new response, or the command's completion, ends whatever came before
      // it — and ends it as UNREAD, because a response that never closed is a
      // response we do not have.
      if (start !== null) {
        close(`the FETCH response for sequence number ${open.seq} was cut short by the next one`);
      } else if (open.pending === null && TAGGED_COMPLETION.test(line)) {
        close(`the FETCH response for sequence number ${open.seq} was cut short by the `
          + `command's completion`);
      } else {
        open.lines += 1;
        if (open.pending !== null) consumePending(open, line);
        else consume(open, line);
        if (open.closed) close(null);
        else if (open.lines > MAX_RESPONSE_LINES) {
          open.error = `the FETCH response for sequence number ${open.seq} ran past `
            + `${MAX_RESPONSE_LINES} lines without closing`;
          close(null);
        }
        continue;
      }
    }

    if (start === null) continue;
    const seq = parseInt(start[1] ?? '0', 10);
    open = newOpenResponse(seq);
    open.lines = 1;
    consume(open, line.slice(start[0].length));
    if (open.closed) close(null);
  }

  close('the FETCH response ended without its closing parenthesis');
  return responses;
}

/** The first section payload whose normalized spec the predicate accepts. */
export function fetchSection(
  response: ImapFetchResponse,
  matches: (spec: string) => boolean,
): string | null {
  for (const [spec, value] of response.sections) {
    if (matches(spec)) return value;
  }
  return null;
}
