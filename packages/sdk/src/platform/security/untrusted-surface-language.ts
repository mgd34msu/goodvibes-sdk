/**
 * untrusted-surface-language.ts — saying what a thing is, in the noun it has.
 *
 * ── Why this is not cosmetic ──────────────────────────────────────────────
 *
 * The refusal the owner met said his Gmail was controlled by "anyone able to
 * write to those pages". A mailbox is not a page and nobody writes to it; they
 * send to it. Reading that sentence, the honest conclusion is that the boundary
 * does not know what it just looked at — and a boundary that visibly does not
 * understand its own evidence is one the reader stops believing, which is the
 * failure the taint module's header warns about in as many words.
 *
 * The wrong noun got there the ordinary way: the rule was written for the
 * browser, the mail surface was added later, and it inherited the browser's
 * sentence because there was only one sentence. So the surfaces get their own
 * words here, in one place, rather than each refusal site inventing them.
 *
 * ── What the wording has to carry ─────────────────────────────────────────
 *
 * Two things, per surface:
 *
 *  - what the thing IS, with its origin — "the web page at https://x.example",
 *    "a message in your mailbox from email:x.example (claimed)";
 *  - who can put text in it — publishers of a site, anyone who knows an
 *    address, anyone in a channel, whoever produced a document.
 *
 * The second is the load-bearing half. It is the reason the content carries no
 * authority, and stating it in terms the reader can check is what makes a
 * refusal reconstructable rather than an assertion.
 */

/**
 * Surfaces whose content is written by someone other than the owner.
 *
 * `'calendar-event'` is its own member rather than a case of `'document'`.
 * Where a calendar event came from is an inviter's address or a subscription
 * URL the daemon polls, and that is precisely the fact a reader of the ledger
 * needs: "content from alice@example.invalid (claimed organizer)" and "content
 * from a feed at calendars.example.invalid" are different provenance, and
 * folding both into "document" would erase the difference in the one place it
 * decides whether a refusal reads as sensible.
 */
export type UntrustedSurface = 'web-page' | 'email' | 'channel-message' | 'document' | 'calendar-event';

/** One (surface, origin) pair that contributed exposure to the current turn. */
export interface UntrustedExposure {
  readonly surface: UntrustedSurface;
  readonly origin: string;
}

/** The thing itself, named with its origin. */
export function describeUntrustedSource(exposure: UntrustedExposure): string {
  const origin = exposure.origin.trim().length > 0 ? exposure.origin.trim() : 'an unidentified source';
  switch (exposure.surface) {
    case 'web-page':
      return `the web page at ${origin}`;
    case 'email':
      return `a message in your mailbox from ${origin}`;
    case 'channel-message':
      return `a channel message from ${origin}`;
    case 'document':
      return `the document ${origin}`;
    case 'calendar-event':
      // The origin is an inviter's address or the feed the daemon polls, so it
      // reads naturally either way: "a calendar event from alice@example.com"
      // and "a calendar event from calendars.example.com".
      return `a calendar event from ${origin}`;
  }
}

/** Who is able to put text into that surface — the reason it carries no authority. */
export function describeWhoControls(surface: UntrustedSurface): string {
  switch (surface) {
    case 'web-page':
      return 'anyone able to publish on that site';
    case 'email':
      return 'anyone who knows the address';
    case 'channel-message':
      return 'anyone who can post in that channel';
    case 'document':
      return 'whoever produced it';
    case 'calendar-event':
      return 'anyone who can invite you, or whoever publishes that feed';
  }
}

/**
 * A list of exposures as one readable clause, grouped so a turn that read
 * fifteen pages does not produce fifteen sentences.
 *
 * Grouping is by surface: the "who controls it" half is a property of the
 * surface, so repeating it per origin is noise, while merging surfaces would
 * attach a mailbox's sentence to a web page.
 */
export function describeExposures(exposures: readonly UntrustedExposure[]): string {
  if (exposures.length === 0) return '';
  const bySurface = new Map<UntrustedSurface, string[]>();
  for (const exposure of exposures) {
    const origins = bySurface.get(exposure.surface) ?? [];
    if (!origins.includes(exposure.origin)) origins.push(exposure.origin);
    bySurface.set(exposure.surface, origins);
  }
  const clauses: string[] = [];
  for (const [surface, origins] of bySurface) {
    const listed = origins.map((origin) => describeUntrustedSource({ surface, origin }));
    clauses.push(`${joinList(listed)} — written by ${describeWhoControls(surface)}`);
  }
  return joinList(clauses);
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}
