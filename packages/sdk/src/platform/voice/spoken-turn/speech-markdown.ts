/**
 * speech-markdown, strips markdown formatting out of assistant text before it
 * reaches a speech synthesizer. Assistant responses are markdown; a TTS engine
 * has no renderer, so without this a synthesizer reads formatting characters
 * aloud verbatim ("asterisk asterisk bold asterisk asterisk", "hash", "pipe").
 * Everything here is plain-text policy, no I/O, so it is shared verbatim by
 * every voice consumer through {@link TtsTextChunker}.
 */

/** Matches a full line that is only a horizontal rule: 3+ repeats of one of -, *, _ with optional spacing. */
const HORIZONTAL_RULE_LINE = /^[-*_](?:[ \t]*[-*_]){2,}$/;

/** A markdown table separator row, e.g. `|---|:--:|` or `---|---`. */
const TABLE_SEPARATOR_LINE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;
const HEADING_PREFIX = /^\s{0,3}#{1,6}\s+/;
const LIST_BULLET_PREFIX = /^\s*(?:[-*+]|\d+\.)\s+/;

const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi;
const RAW_HTML_TAG = /<\/?[a-zA-Z!][^<>]*>/g;
const INLINE_CODE = /`([^`]+)`/g;

const STRIKETHROUGH = /~~(.+?)~~/g;
const BOLD_STAR = /\*\*(.+?)\*\*/g;
// Double-underscore bold guards against intraword use (snake__case style is rare
// but the same protection as single-underscore emphasis costs nothing).
const BOLD_UNDERSCORE = /(?<![\w])__(.+?)__(?![\w])/g;
// Single-asterisk emphasis: content must not start/end with whitespace, which
// keeps spaced math ("a * b") from pairing up as emphasis. Plain "2*3" never
// matches at all, it only has one asterisk, so there is no pair to strip.
const ITALIC_STAR = /\*([^\s*](?:[^*]*[^\s*])?)\*/g;
// Single-underscore emphasis: the (?<![\w_]) / (?![\w_]) guards are what keep
// snake_case_word intact, an underscore preceded or followed by a word
// character is intraword, not an emphasis marker.
const ITALIC_UNDERSCORE = /(?<![\w_])_([^\s_](?:[^_]*[^\s_])?)_(?![\w_])/g;

/**
 * Strips markdown formatting for speech, keeping the words. Pure and
 * single-shot: run it once over a whole chunk (it expects any newlines still
 * in the text, since heading/list/table/blockquote handling is line-anchored).
 * Nested constructs (bold link text, bold inside a heading) come out as plain
 * words because line-level stripping runs before inline stripping, and inline
 * stripping runs links/images before the emphasis markers wrapping them.
 */
export function stripMarkdownForSpeech(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 3 && HORIZONTAL_RULE_LINE.test(trimmed)) continue;
    if (trimmed.includes('|') && TABLE_SEPARATOR_LINE.test(trimmed) && /-/.test(trimmed)) continue;

    let stripped = line.replace(BLOCKQUOTE_PREFIX, '');
    stripped = stripped.replace(HEADING_PREFIX, '');
    stripped = stripped.replace(LIST_BULLET_PREFIX, '');
    stripped = stripTableRow(stripped);
    out.push(stripInline(stripped));
  }

  return out.join('\n');
}

/** A table data row reads as its cells joined by ", ", pipes carry no spoken meaning. */
function stripTableRow(line: string): string {
  if (!line.includes('|')) return line;
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells = body.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  return cells.length > 0 ? cells.join(', ') : line;
}

function stripInline(line: string): string {
  let result = line;
  // Images and links resolve to their visible text first, so emphasis markers
  // wrapping a link (`**[text](url)**`) strip cleanly afterward instead of
  // leaving stray brackets.
  result = result.replace(IMAGE, '$1');
  result = result.replace(LINK, '$1');
  result = result.replace(AUTOLINK, (_match, url: string) => autolinkSpokenForm(url));
  result = result.replace(RAW_HTML_TAG, '');
  result = result.replace(INLINE_CODE, '$1');
  result = result.replace(STRIKETHROUGH, '$1');
  result = result.replace(BOLD_STAR, '$1');
  result = result.replace(BOLD_UNDERSCORE, '$1');
  result = result.replace(ITALIC_STAR, '$1');
  result = result.replace(ITALIC_UNDERSCORE, '$1');
  return result;
}

function autolinkSpokenForm(url: string): string {
  if (url.toLowerCase().startsWith('mailto:')) return url.slice('mailto:'.length);
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

type FenceChar = '`' | '~';

/**
 * StreamingCodeFenceFilter, swallows fenced code blocks (```) out of a
 * streamed delta sequence, replacing each whole block with one spoken phrase.
 * Code is unreadable aloud, and a stream never hands us a fence in one piece
 * (the delta boundary can land mid-backtick), so this carries the small
 * amount of state needed to recognize a fence marker that arrives split
 * across `push()` calls: the fence-relevant prefix of the CURRENT line only
 * (up to 3 spaces of indent, then a run of backtick/tilde chars), everything
 * else streams straight through the moment it is no longer part of that
 * prefix, so latency-sensitive prose never waits on a line's `\n`.
 *
 * ~~~-style fences are handled too (same recognizer, either fence char), on
 * the same terms as backtick fences: opening char sets which one closes it.
 */
export class StreamingCodeFenceFilter {
  private prefixBuf = '';
  private indentSeen = 0;
  private fenceRunChar: FenceChar | null = null;
  private fenceRunLen = 0;
  private inPassthroughLine = false;
  private inSwallowLine = false;
  /** While inSwallowLine: whether the line being swallowed is the closing fence marker (its newline surfaces) vs. the opener or plain code content (fully silent). */
  private swallowLineIsCloser = false;
  private inFence = false;
  private openFenceChar: FenceChar = '`';
  private openFenceLen = 0;

  push(delta: string): string {
    let out = '';
    for (let i = 0; i < delta.length; i++) {
      out += this.consumeChar(delta[i]!);
    }
    return out;
  }

  /** Whatever undecided line-start text never resolved (no more input coming) passes through as plain text; a dangling open fence stays swallowed, its placeholder already went out when it opened. */
  flush(): string {
    const leftover = this.prefixBuf;
    const wasInFence = this.inFence;
    this.resetLineState();
    return wasInFence ? '' : leftover;
  }

  reset(): void {
    this.resetLineState();
    this.inPassthroughLine = false;
    this.inSwallowLine = false;
    this.swallowLineIsCloser = false;
    this.inFence = false;
    this.openFenceChar = '`';
    this.openFenceLen = 0;
  }

  private consumeChar(ch: string): string {
    if (this.inPassthroughLine) {
      if (ch === '\n') this.inPassthroughLine = false;
      return ch;
    }
    if (this.inSwallowLine) {
      if (ch === '\n') {
        this.inSwallowLine = false;
        // The closing fence line's own newline is the one piece of it that
        // survives, it is what lets prose resume on its own line. Every
        // other swallowed line (the opener, or actual code content) stays
        // fully silent, newline included.
        return this.swallowLineIsCloser ? '\n' : '';
      }
      return '';
    }
    return this.consumePrefixChar(ch);
  }

  private consumePrefixChar(ch: string): string {
    this.prefixBuf += ch;

    if (this.fenceRunChar === null) {
      if (ch === ' ' && this.indentSeen < 3) {
        this.indentSeen++;
        return '';
      }
      if (ch === '`' || ch === '~') {
        this.fenceRunChar = ch;
        this.fenceRunLen = 1;
        return '';
      }
      return this.resolveNotFence();
    }

    if (ch === this.fenceRunChar) {
      this.fenceRunLen++;
      return '';
    }

    return this.fenceRunLen >= 3 ? this.resolveFenceLine() : this.resolveNotFence();
  }

  private resolveNotFence(): string {
    const emitted = this.prefixBuf;
    const lineComplete = emitted.endsWith('\n');
    this.resetLineState();

    if (this.inFence) {
      // Not a fence marker at all, plain code content, swallow it (and its
      // newline; only a real closing fence line's newline survives).
      if (!lineComplete) {
        this.inSwallowLine = true;
        this.swallowLineIsCloser = false;
      }
      return '';
    }
    if (!lineComplete) this.inPassthroughLine = true;
    return emitted;
  }

  private resolveFenceLine(): string {
    const runChar = this.fenceRunChar as FenceChar;
    const runLen = this.fenceRunLen;
    const lineComplete = this.prefixBuf.endsWith('\n');
    const wasInFence = this.inFence;
    this.resetLineState();

    const isOpener = !wasInFence;
    // A same-ish marker that is the wrong fence char, or shorter than the
    // opener, is not a valid closer, the fence stays open and this line is
    // still code content, not a marker line.
    const isValidCloser = wasInFence && runChar === this.openFenceChar && runLen >= this.openFenceLen;

    if (!isOpener && !isValidCloser) {
      if (!lineComplete) {
        this.inSwallowLine = true;
        this.swallowLineIsCloser = false;
      }
      return '';
    }

    if (isOpener) {
      this.inFence = true;
      this.openFenceChar = runChar;
      this.openFenceLen = runLen;
    } else {
      this.inFence = false;
    }

    // The marker line itself carries no spoken content. The opener's line
    // break stays swallowed with it (the placeholder already marks the
    // spot); the closer's line break surfaces so prose resumes on its own
    // line, same as the source markdown.
    if (lineComplete) return isOpener ? ' Code block omitted. ' : '\n';
    this.inSwallowLine = true;
    this.swallowLineIsCloser = isValidCloser;
    return isOpener ? ' Code block omitted. ' : '';
  }

  private resetLineState(): void {
    this.prefixBuf = '';
    this.indentSeen = 0;
    this.fenceRunChar = null;
    this.fenceRunLen = 0;
  }
}
