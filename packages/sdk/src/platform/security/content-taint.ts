/**
 * content-taint.ts, does THIS outward action's content derive from something
 * a stranger wrote?
 *
 * ── Why the question has to be this precise ───────────────────────────────
 *
 * The coarse question, "has this process read anything untrusted?", is
 * useless in a daemon. A daemon reads mail and pages continuously, so the
 * coarse answer is permanently yes, and a boundary that is permanently
 * tripped gets replaced by a disclosure nobody reads. That is exactly what
 * happened: the daemon ended up *reporting* untrusted exposure on a send
 * receipt while a product with a human attached *refused* the send. The
 * unattended surface was the most permissive one, which is backwards, an
 * unattended daemon is where a prompt injection pays off best, because there
 * is nobody to notice.
 *
 * So the question asked here is narrow and answerable: does the CONTENT of
 * this specific outward action derive from untrusted input? A scheduled report
 * that queries a database and mails a summary derives from nothing a stranger
 * wrote and proceeds. A send whose recipient, subject or body carries text that
 * came out of a page or a mailbox is refused, on every surface, daemon
 * included.
 *
 * ── How derivation is detected ────────────────────────────────────────────
 *
 * By overlap with the untrusted text actually read, not by provenance
 * bookkeeping the caller could forget to thread. Two signals, both conservative
 * in the direction of refusing:
 *
 *   - a shared run of `MIN_SHARED_WORDS` normalized words, which catches a
 *     quoted or lightly-reworded instruction;
 *   - a shared literal span of `MIN_SHARED_CHARS` characters, which catches a
 *     url, an address, an account number or a token copied verbatim, the
 *     payloads that do not look like prose.
 *
 * Both thresholds are deliberately above the length of ordinary shared
 * phrasing ("thanks", "let me know", a greeting), because a check that fires on
 * every polite sentence would be turned off within a week.
 *
 * What this does NOT claim: that a sufficiently clever paraphrase is caught. It
 * is not a classifier and cannot be. It catches derivation that leaves textual
 * evidence, which is what copying an instruction out of a message looks like.
 * The remaining defence for the rest is that untrusted content carries no
 * authority to begin with, and that outward actions still require confirmation.
 */

/** A shared run of this many normalized words counts as derivation. */
export const MIN_SHARED_WORDS = 8;

/** A shared literal span of this many characters counts as derivation. */
export const MIN_SHARED_CHARS = 40;

/** Longest single field considered; a caller cannot force an O(huge) scan. */
const MAX_FIELD_CHARS = 20_000;

/**
 * A span appearing in this many DISTINCT untrusted origins is boilerplate, not
 * derivation.
 *
 * Confidentiality footers, unsubscribe lines and standard disclaimers are long
 * enough to clear the span threshold and appear in mail from everyone. Treating
 * them as evidence would refuse ordinary correspondence, and the fix must not
 * be to raise the threshold, that would weaken the case the check exists for,
 * which is a verbatim account number or token. Repetition across unrelated
 * senders is the signal that distinguishes boilerplate from a payload.
 */
const BOILERPLATE_DISTINCT_ORIGINS = 2;

/** Untrusted text retained for comparison, with where it came from. */
export interface TaintSource {
  readonly surface: string;
  readonly origin: string;
  readonly text: string;
}

export interface TaintOptions {
  /**
   * Fields tested by EXACT CONTAINMENT rather than by the length thresholds.
   *
   * A recipient address is short and high-signal: `accounts-payable@vendor.example`
   * is 3 words and 31 characters, under both thresholds, so an injection that
   * only redirects where mail goes would pass a length test entirely. Length is
   * the wrong instrument for a field where the whole value IS the payload.
   */
  readonly exactMatchFields?: readonly string[] | undefined;
  /**
   * Recipients that are allowed even when they appear in untrusted text.
   *
   * Exactly one case: replying to where a message actually came from. The
   * address must be established from DELIVERY EVIDENCE, the envelope sender,
   * and never from a `From:` header, which the sender writes. Without this,
   * every legitimate auto-reply is refused, because the address it replies to
   * is by definition present in the message it answers.
   */
  readonly replyToEnvelopeSenders?: readonly string[] | undefined;
  /**
   * Strip quoted regions from these fields before checking.
   *
   * A reply that quotes the message it answers repeats it verbatim by design.
   * Quoting is not derivation of an INSTRUCTION; it is context. Whether that
   * is safe is a judgement the owner should make knowingly, see the module
   * header for what stays refused.
   */
  readonly stripQuotedFields?: readonly string[] | undefined;
}

export interface TaintFinding {
  /** Which outward field carried it, 'body', 'subject', 'to', … */
  readonly field: string;
  readonly surface: string;
  readonly origin: string;
  /**
   * The overlapping text, truncated. Included so a refusal can SHOW the
   * operator what matched rather than asserting a match they cannot check.
   */
  readonly excerpt: string;
  readonly kind: 'shared-words' | 'shared-span';
}

function normalizeWords(value: string): string[] {
  return value
    .slice(0, MAX_FIELD_CHARS)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function normalizeSpan(value: string): string {
  return value.slice(0, MAX_FIELD_CHARS).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every run of `size` consecutive words, as joined keys. */
function shingles(words: readonly string[], size: number): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    out.add(words.slice(index, index + size).join(' '));
  }
  return out;
}

/**
 * The longest span of `candidate` that also appears in `source`, capped.
 *
 * A rolling scan rather than a full LCS table: the inputs are bounded and only
 * the "is there one at least this long" answer is needed, so quadratic-worst
 * behaviour on a 20k cap is acceptable and the code stays readable.
 */
function longestSharedSpan(candidate: string, source: string, minimum: number): string | null {
  if (candidate.length < minimum || source.length < minimum) return null;
  for (let start = 0; start + minimum <= candidate.length; start += 1) {
    let length = minimum;
    let best: string | null = null;
    while (start + length <= candidate.length) {
      const slice = candidate.slice(start, start + length);
      if (!source.includes(slice)) break;
      best = slice;
      length += 1;
    }
    if (best !== null) return best;
  }
  return null;
}

function truncate(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Find every field of an outward action whose content derives from untrusted
 * input.
 *
 * `fields` is a record of the caller's own field names to their values, so a
 * refusal names the field an operator would recognise ("body", "subject")
 * rather than an index.
 */

/**
 * Remove quoted regions from a reply body.
 *
 * Two conventions cover nearly all real mail: `>`-prefixed lines, and an
 * attribution line ("On <date>, <someone> wrote:") after which everything is
 * the quoted original. Anything not matched stays in and is still checked.
 */
export function stripQuotedRegions(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .*wrote:\s*$/i.test(line.trim())) break;
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Normalized recipient address, for exact containment. */
function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  const angled = /<([^<>]+)>\s*$/.exec(trimmed);
  return (angled?.[1] ?? trimmed).replace(/^<|>$/g, '').trim().toLowerCase();
}

/** How many distinct origins contain this span, boilerplate repeats, payloads do not. */
function originsContaining(span: string, sources: readonly TaintSource[]): number {
  const origins = new Set<string>();
  for (const source of sources) {
    if (normalizeSpan(source.text).includes(span)) origins.add(source.origin);
  }
  return origins.size;
}

export function findContentTaint(
  fields: Readonly<Record<string, string | undefined>>,
  sources: readonly TaintSource[],
  options: TaintOptions = {},
): readonly TaintFinding[] {
  const findings: TaintFinding[] = [];
  if (sources.length === 0) return findings;

  const exactFields = new Set(options.exactMatchFields ?? []);
  const stripFields = new Set(options.stripQuotedFields ?? []);
  const allowedReplies = new Set((options.replyToEnvelopeSenders ?? []).map(normalizeAddress));

  for (const [field, rawInput] of Object.entries(fields)) {
    if (rawInput === undefined || rawInput.trim().length === 0) continue;
    const rawValue = stripFields.has(field) ? stripQuotedRegions(rawInput) : rawInput;
    if (rawValue.trim().length === 0) continue;

    // Short, high-signal fields: the value itself is the payload, so the test
    // is containment rather than length.
    if (exactFields.has(field)) {
      const address = normalizeAddress(rawValue);
      if (address.length === 0) continue;
      if (allowedReplies.has(address)) continue;
      const hit = sources.find((source) => normalizeSpan(source.text).includes(address));
      if (hit !== undefined) {
        findings.push({
          field,
          surface: hit.surface,
          origin: hit.origin,
          excerpt: truncate(address),
          kind: 'shared-span',
        });
      }
      continue;
    }

    const words = normalizeWords(rawValue);
    const span = normalizeSpan(rawValue);
    const fieldShingles = words.length >= MIN_SHARED_WORDS ? shingles(words, MIN_SHARED_WORDS) : null;

    for (const source of sources) {
      if (source.text.trim().length === 0) continue;

      if (fieldShingles !== null) {
        const sourceShingles = shingles(normalizeWords(source.text), MIN_SHARED_WORDS);
        let shared: string | null = null;
        for (const shingle of fieldShingles) {
          if (!sourceShingles.has(shingle)) continue;
          // Boilerplate applies to the word rule as well as the span rule, a
          // confidentiality footer clears both, and exempting only one branch
          // means whichever fires first decides, which is not a rule at all.
          if (originsContaining(shingle, sources) >= BOILERPLATE_DISTINCT_ORIGINS) continue;
          shared = shingle;
          break;
        }
        if (shared !== null) {
          findings.push({
            field,
            surface: source.surface,
            origin: source.origin,
            excerpt: truncate(shared),
            kind: 'shared-words',
          });
          break;
        }
      }

      const sharedSpan = longestSharedSpan(span, normalizeSpan(source.text), MIN_SHARED_CHARS);
      // A span present in several unrelated senders' mail is boilerplate, a
      // confidentiality footer, an unsubscribe line, not something lifted
      // from one message.
      if (sharedSpan !== null && originsContaining(sharedSpan, sources) >= BOILERPLATE_DISTINCT_ORIGINS) {
        continue;
      }
      if (sharedSpan !== null) {
        findings.push({
          field,
          surface: source.surface,
          origin: source.origin,
          excerpt: truncate(sharedSpan),
          kind: 'shared-span',
        });
        break;
      }
    }
  }
  return findings;
}

/**
 * The refusal an operator reads.
 *
 * Names the field, the surface and the origin, and shows the overlapping text,
 * because "refused: untrusted content" with no evidence is indistinguishable
 * from a bug and gets worked around.
 */
export function describeContentTaint(action: string, findings: readonly TaintFinding[]): string {
  const first = findings[0];
  if (first === undefined) return `${action} was refused.`;
  const fields = [...new Set(findings.map((finding) => finding.field))].join(', ');
  return (
    `Refused ${action}: its ${fields} derives from content read from ${first.surface} `
    + `(${first.origin}), which anyone can write. The overlapping text is "${first.excerpt}". `
    + 'Content that arrived from outside cannot decide what leaves this machine. '
    + 'Compose the message from your own instruction instead, or send it yourself.'
  );
}
