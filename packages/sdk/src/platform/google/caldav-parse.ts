/**
 * Minimal, dependency-free parsing helpers for CalDAV wire formats.
 *
 * Two things are parsed here:
 *   1. WebDAV multistatus XML (the envelope every PROPFIND/REPORT response
 *      comes back in) into a flat list of `{ href, status, props }` records.
 *   2. The iCalendar (`text/calendar`) payload carried inside a
 *      `calendar-data` prop, into simple VEVENT records.
 *
 * No XML library is used. CalDAV servers only ever send a small, predictable
 * subset of XML (no CDATA sections, no processing instructions inside the
 * body, no mixed content beyond text + a handful of known child elements), so
 * a focused regex/state parser over that subset is enough — this mirrors how
 * the rest of the agent parses constrained wire formats (see
 * `src/agent/email/imap-client.ts`).
 *
 * Everything here is defensive: malformed or unexpected input yields empty
 * results, never a thrown exception. Real servers disagree on namespace
 * prefixes (`d:`, `D:`, `cal:`, `caldav:`, or none at all), so every lookup
 * matches on the element's local name and ignores whatever prefix is in
 * front of it.
 */

// ---------------------------------------------------------------------------
// WebDAV multistatus parsing
// ---------------------------------------------------------------------------

/** One `<response>` entry from a multistatus document, flattened. */
export interface DavMultistatusEntry {
  readonly href: string;
  /** The raw `<status>` text of the propstat used for `props` (e.g. "HTTP/1.1 200 OK"). */
  readonly status: string;
  readonly props: Readonly<Record<string, string>>;
}

interface ExtractedElement {
  /** Full tag name as written, including any namespace prefix. */
  readonly tagName: string;
  readonly inner: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

const TEXT_PROP_NAMES = ['displayname', 'getetag', 'calendar-data'] as const;
const HREF_PROP_NAMES = ['current-user-principal', 'calendar-home-set'] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds every element with the given local name (any or no namespace
 * prefix) at any depth within `xml`, returning its inner content. Malformed
 * elements missing a closing tag fall back to "rest of the input" as their
 * inner content rather than throwing.
 */
function extractAllElements(xml: string, localName: string): ExtractedElement[] {
  const results: ExtractedElement[] = [];
  const namePattern = escapeRegExp(localName);
  const openRe = new RegExp(`<((?:[A-Za-z0-9_.-]+:)?${namePattern})(?:\\s[^>]*)?(/?)>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(xml)) !== null) {
    const fullTagName = match[1] ?? '';
    const selfClosing = match[2] === '/';
    const startIndex = match.index;
    const openEnd = openRe.lastIndex;
    if (selfClosing) {
      results.push({ tagName: fullTagName, inner: '', startIndex, endIndex: openEnd });
      continue;
    }
    const closeRe = new RegExp(`</\\s*${escapeRegExp(fullTagName)}\\s*>`);
    const rest = xml.slice(openEnd);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) {
      // Malformed: no matching close tag. Treat the remainder as inner
      // content and stop scanning — nothing useful lies past broken markup.
      results.push({ tagName: fullTagName, inner: rest, startIndex, endIndex: xml.length });
      break;
    }
    const inner = rest.slice(0, closeMatch.index);
    const endIndex = openEnd + closeMatch.index + closeMatch[0].length;
    results.push({ tagName: fullTagName, inner, startIndex, endIndex });
    openRe.lastIndex = endIndex;
  }
  return results;
}

function extractElement(xml: string, localName: string): ExtractedElement | null {
  return extractAllElements(xml, localName)[0] ?? null;
}

/** Local names of every direct-or-nested opening/self-closing tag found in `xml`. */
function extractChildLocalNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)(?:\s[^>]*)?\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(parseInt(digits, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function isOkStatus(statusText: string): boolean {
  return /\s200(\s|$)/.test(` ${statusText}`);
}

function fillKnownProps(propInner: string, props: Record<string, string>): void {
  for (const name of TEXT_PROP_NAMES) {
    if (props[name] !== undefined) continue;
    const element = extractElement(propInner, name);
    if (element) props[name] = decodeXmlEntities(element.inner.trim());
  }
  for (const name of HREF_PROP_NAMES) {
    if (props[name] !== undefined) continue;
    const element = extractElement(propInner, name);
    if (!element) continue;
    const hrefElement = extractElement(element.inner, 'href');
    if (hrefElement) props[name] = decodeXmlEntities(hrefElement.inner.trim());
  }
  if (props['resourcetype'] === undefined) {
    const element = extractElement(propInner, 'resourcetype');
    if (element) props['resourcetype'] = extractChildLocalNames(element.inner).join(',');
  }
}

/**
 * Parses a WebDAV multistatus XML body into one flattened entry per
 * `<response>`. Each entry carries whichever of `current-user-principal`,
 * `calendar-home-set`, `displayname`, `resourcetype`, `getetag`, and
 * `calendar-data` were present, keyed under exactly those names.
 *
 * When a response has more than one `<propstat>` (a mix of successful and
 * failed property lookups, e.g. a 200 batch plus a 404 batch), only the
 * `200`-status propstat(s) contribute properties; `status` reflects that
 * outcome. If none reports 200, every propstat is scanned anyway so a
 * caller still gets whatever was returned instead of nothing.
 *
 * Never throws: malformed input yields an empty array.
 */
export function parseMultistatus(xml: string): DavMultistatusEntry[] {
  if (typeof xml !== 'string' || xml.trim().length === 0) return [];
  try {
    const responses = extractAllElements(xml, 'response');
    const out: DavMultistatusEntry[] = [];
    for (const response of responses) {
      const propstats = extractAllElements(response.inner, 'propstat');
      const beforePropstat = propstats.length > 0 ? response.inner.slice(0, propstats[0]!.startIndex) : response.inner;
      const hrefElement = extractElement(beforePropstat, 'href') ?? extractElement(response.inner, 'href');
      const href = hrefElement ? decodeXmlEntities(hrefElement.inner.trim()) : '';

      let firstStatus = '';
      let okStatus = '';
      const okPropstats: ExtractedElement[] = [];
      for (const propstat of propstats) {
        const statusElement = extractElement(propstat.inner, 'status');
        const statusText = statusElement ? statusElement.inner.trim() : '';
        if (!firstStatus) firstStatus = statusText;
        if (isOkStatus(statusText)) {
          if (!okStatus) okStatus = statusText;
          okPropstats.push(propstat);
        }
      }
      const propSources = okPropstats.length > 0 ? okPropstats : propstats;
      const props: Record<string, string> = {};
      for (const propstat of propSources) fillKnownProps(propstat.inner, props);

      out.push({ href, status: okStatus || firstStatus, props });
    }
    return out;
  } catch {
    return [];
  }
}

/** True when a parsed `resourcetype` prop value (comma-joined local names) denotes a calendar collection. */
export function isCalendarResourceType(resourceTypeValue: string | undefined): boolean {
  if (!resourceTypeValue) return false;
  return resourceTypeValue.split(',').includes('calendar');
}

// ---------------------------------------------------------------------------
// iCalendar (calendar-data) parsing
// ---------------------------------------------------------------------------

/** One parsed VEVENT. `rrule` is the raw RRULE value, never expanded here. */
export interface CalDavEventRecord {
  readonly uid: string;
  readonly summary: string;
  /** Raw DTSTART value, e.g. "20260101T100000Z" or "20260101" for all-day. */
  readonly dtstart: string;
  /** Raw DTEND value; empty string when the event has no DTEND. */
  readonly dtend: string;
  readonly allDay: boolean;
  readonly location?: string;
  /** DTSTART's TZID parameter, when present (not applicable to UTC/all-day values). */
  readonly tzid?: string;
  readonly rrule?: string;
}

/**
 * Unfolds RFC 5545 folded lines: a CRLF (or bare LF/CR — servers are not all
 * strict) followed immediately by a single space or tab is a continuation
 * marker, not a line break. Removing exactly that newline-plus-one-character
 * sequence rejoins the folded line; anything after the fold point on the
 * continuation line is real content and must be preserved untouched.
 */
export function unfoldIcsLines(raw: string): string {
  return raw.replace(/(\r\n|\r|\n)[ \t]/g, '');
}

function unescapeIcsText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        out += '\n';
        i++;
        continue;
      }
      if (next === ',' || next === ';' || next === '\\') {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) return i;
  }
  return -1;
}

interface IcsField {
  readonly value: string;
  readonly params: Readonly<Record<string, string>>;
}

function parseIcsLine(line: string): { readonly name: string; readonly field: IcsField } | null {
  if (!line) return null;
  const colonIndex = findUnquotedColon(line);
  if (colonIndex === -1) return null;
  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const parts = head.split(';');
  const name = (parts[0] ?? '').trim();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let paramValue = part.slice(eq + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"') && paramValue.length >= 2) {
      paramValue = paramValue.slice(1, -1);
    }
    if (key) params[key] = paramValue;
  }
  return { name: name.toUpperCase(), field: { value, params } };
}

function buildEventRecord(fields: ReadonlyMap<string, IcsField>): CalDavEventRecord | null {
  const uid = fields.get('UID')?.value.trim();
  if (!uid) return null;
  const summaryField = fields.get('SUMMARY');
  const dtstartField = fields.get('DTSTART');
  const dtendField = fields.get('DTEND');
  const locationField = fields.get('LOCATION');
  const rruleField = fields.get('RRULE');

  const dtstart = dtstartField?.value ?? '';
  const allDay = dtstartField?.params['VALUE'] === 'DATE' || /^\d{8}$/.test(dtstart);
  const tzid = dtstartField?.params['TZID'];
  const location = locationField ? unescapeIcsText(locationField.value) : undefined;

  return {
    uid,
    summary: summaryField ? unescapeIcsText(summaryField.value) : '',
    dtstart,
    dtend: dtendField?.value ?? '',
    allDay,
    ...(location !== undefined ? { location } : {}),
    ...(tzid !== undefined ? { tzid } : {}),
    ...(rruleField !== undefined ? { rrule: rruleField.value } : {}),
  };
}

/**
 * Parses every VEVENT block out of a raw iCalendar (`calendar-data`) payload.
 * Handles line unfolding first, then walks BEGIN:VEVENT/END:VEVENT blocks.
 * Events without a UID are dropped (UID is the only property this module
 * treats as mandatory). Never throws: malformed input yields an empty array.
 */
export function parseCalendarDataEvents(calendarData: string): CalDavEventRecord[] {
  if (typeof calendarData !== 'string' || calendarData.trim().length === 0) return [];
  try {
    const unfolded = unfoldIcsLines(calendarData);
    const lines = unfolded.split(/\r\n|\r|\n/);
    const events: CalDavEventRecord[] = [];
    let current: Map<string, IcsField> | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^BEGIN:VEVENT$/i.test(line)) {
        current = new Map();
        continue;
      }
      if (/^END:VEVENT$/i.test(line)) {
        if (current) {
          const record = buildEventRecord(current);
          if (record) events.push(record);
        }
        current = null;
        continue;
      }
      if (!current || line.length === 0) continue;
      const parsed = parseIcsLine(line);
      if (!parsed) continue;
      current.set(parsed.name, parsed.field);
    }
    return events;
  } catch {
    return [];
  }
}
