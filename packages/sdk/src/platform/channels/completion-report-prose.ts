/**
 * Recognize an agent completion report written as PROSE, and reduce it to the
 * one thing a person asked for: the answer.
 *
 * reply-render.ts already strips the report's JSON form. The report has a
 * second form, and it is the one that reached the owner's phone: the base
 * agent prompt (agents/orchestrator-prompts.ts) asks every agent to close with
 *
 *   - Summary: 1-2 sentences
 *   - Changes: files created/modified
 *   - Decisions: choices made + rationale
 *   - Issues: problems encountered
 *   - Uncertainties: anything the caller should verify
 *
 * so "Hey, are you there?" came back as a filled-in form with `Changes: None`
 * under it. That is an internal contract between an agent and the WRFC
 * controller. It belongs in the transcript and in operator surfaces; on a lock
 * screen it is paperwork where an answer should be.
 *
 * The source of that shape is fixed too (a conversational spawn no longer asks
 * for a report at all). This module is the boundary half of the same fix, and
 * it is deliberate duplication: any future prompt or archetype change can
 * reintroduce the shape, and no such change should be able to put a form back
 * on someone's phone.
 *
 * Pure string work — no I/O, no clock, no surface knowledge.
 */

/**
 * Headings the report template produces. Matching is on the heading WORD, so
 * `## Summary`, `**Summary:**`, `- Summary:` and `Summary:` are one thing.
 */
const REPORT_HEADINGS: ReadonlySet<string> = new Set([
  'summary', 'result', 'changes', 'decisions', 'issues', 'uncertainties',
  'files created', 'files modified', 'files deleted', 'files changed',
  'gathered context', 'planned actions', 'applied changes', 'constraints',
  'tests written', 'tests added', 'tests passed', 'tests failed', 'failures',
  'coverage', 'score', 'dimensions', 'evidence', 'verification',
  'acceptance checklist', 'constraint findings',
]);

/**
 * Headings that carry the answer. One of these must be present for anything to
 * be treated as a report — a message with a `Changes:` line and no summary is
 * somebody talking about changes.
 */
const ANSWER_HEADINGS: readonly string[] = ['summary', 'result'];

/**
 * How many distinct report headings must appear before this is a report.
 *
 * Two, not one: a perfectly ordinary reply can open with "Summary: ..." and
 * mean it. A reply that ALSO carries a second template heading is the form.
 */
const MIN_REPORT_HEADINGS = 2;

/** Section bodies that fill in the form without saying anything. */
const EMPTY_SECTION = /^(?:none|n\/a|na|nothing|no changes|not applicable|-|—|–)\s*[.]?$/i;

interface HeadingLine {
  /** Normalized heading word, e.g. `summary`. */
  readonly key: string;
  /** Text that followed the heading on the same line. */
  readonly inline: string;
}

/** Normalize a candidate heading: lowercase, collapsed spaces, no markup. */
function normalizeHeading(raw: string): string {
  return raw
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Read one line as a report heading, or null.
 *
 * Two shapes count, and only these two:
 *   1. A markdown heading whose text is a report heading (`## Summary`).
 *   2. A label followed by a colon (`Summary:`, `- Summary:`, `**Summary**:`),
 *      optionally as a list item.
 *
 * The colon requirement is what keeps a sentence that merely begins with the
 * word "Changes" from being read as a section boundary.
 */
export function readReportHeading(line: string): HeadingLine | null {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*:?\s*$/.exec(line);
  if (heading?.[1]) {
    const key = normalizeHeading(heading[1]);
    return REPORT_HEADINGS.has(key) ? { key, inline: '' } : null;
  }
  const labeled = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)?((?:\*\*|__)?[A-Za-z][A-Za-z /]{0,28}(?:\*\*|__)?)\s*:\s*(.*)$/.exec(line);
  if (!labeled?.[1]) return null;
  const key = normalizeHeading(labeled[1]);
  return REPORT_HEADINGS.has(key) ? { key, inline: (labeled[2] ?? '').trim() } : null;
}

interface ReportShape {
  /** Index of the first line that opened the report. */
  readonly startLine: number;
  /** Section key -> its content lines, in order of appearance. */
  readonly sections: ReadonlyMap<string, string[]>;
}

/**
 * Locate the report inside a body, as a line span plus its sections.
 *
 * The span always runs to the END of the text. Unlike the JSON form, prose has
 * no closing delimiter — there is no way to tell "the report ended and the
 * agent went back to talking" from "the report continues". Prose written
 * BEFORE the first heading survives, which is the case that actually occurs
 * (an agent answers, then files its paperwork).
 */
function findReportShape(text: string): ReportShape | null {
  const lines = text.split('\n');
  const sections = new Map<string, string[]>();
  let startLine = -1;
  let current: string[] | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = readReportHeading(lines[index] ?? '');
    if (heading) {
      if (startLine === -1) startLine = index;
      current = sections.get(heading.key) ?? [];
      if (heading.inline) current.push(heading.inline);
      sections.set(heading.key, current);
      continue;
    }
    if (startLine === -1) continue;
    current?.push(lines[index] ?? '');
  }

  if (startLine === -1 || sections.size < MIN_REPORT_HEADINGS) return null;
  if (!ANSWER_HEADINGS.some((key) => sections.has(key))) return null;
  return { startLine, sections };
}

/**
 * A section's content as plain prose: list markers removed, blank lines and
 * "None."-style filler dropped.
 */
function sectionProse(lines: readonly string[] | undefined): string {
  if (!lines) return '';
  const cleaned = lines
    .map((line) => line.replace(/^\s{0,8}(?:[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter((line) => line.length > 0 && !EMPTY_SECTION.test(line));
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Replace a prose completion report with the answer it carries.
 *
 * Returns the text unchanged when it is not a report. When it IS one, the
 * result is the prose that preceded it plus the summary — and when the summary
 * says nothing, the result can legitimately be empty. Empty is honest; the
 * caller sends nothing rather than sending a form.
 */
export function stripProseCompletionReport(text: string): string {
  const shape = findReportShape(text);
  if (!shape) return text;

  const preamble = text.split('\n').slice(0, shape.startLine).join('\n').trim();
  const answer = sectionProse(shape.sections.get('summary'))
    || sectionProse(shape.sections.get('result'));

  return [preamble, answer]
    .filter((part) => part.length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
