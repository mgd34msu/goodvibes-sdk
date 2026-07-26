/**
 * Inline reasoning delimiters in OpenAI-compatible assistant content.
 *
 * Some endpoints put the model's reasoning in a structured field
 * (`reasoning`, `reasoning_content`) — openai-stream-delta.ts already routes
 * those onto the reasoning channel. Others put it INSIDE the assistant
 * message, wrapped in a tag, and send it as ordinary content: cerebras serving
 * qwen-3 / gpt-oss is the case that surfaced this.
 *
 * When that happens the reasoning is not reasoning as far as the rest of the
 * platform is concerned — it is the answer. It reaches the transcript, the
 * session export, and every channel body as `assistant_text`, so
 * `reasoningVisibility` never gets a chance to act on it. That is how a
 * cerebras reply put reasoning into an ntfy notification whose surface policy
 * is `reasoningVisibility: 'suppress'`.
 *
 * The split belongs here, at the provider boundary, for the same reason the
 * structured fields are handled here: the wire format is the provider's
 * concern, and doing it once means every consumer — TUI transcript, webui,
 * session export, channel surfaces — receives the same correct
 * content/reasoning split without re-solving it. A filter at any single render
 * site would fix that site and leave the raw tag in every other one.
 */

/**
 * Tag names recognised as inline reasoning wrappers.
 *
 * Deliberately short. Each entry is a name that models emit as a literal
 * XML-ish wrapper around chain-of-thought; a name that could plausibly appear
 * as real markup in an answer does not belong here.
 */
export const INLINE_REASONING_TAGS: readonly string[] = ['think', 'thinking', 'reasoning'];

const OPEN_TAGS: ReadonlyMap<string, string> = new Map(
  INLINE_REASONING_TAGS.map((tag) => [`<${tag}>`, tag]),
);

/** Longest delimiter, which bounds how much text has to be held back mid-stream. */
const MAX_DELIMITER_LENGTH = Math.max(
  ...INLINE_REASONING_TAGS.map((tag) => Math.max(tag.length + 2, tag.length + 3)),
);

export interface InlineReasoningSplit {
  /** The answer, with every reasoning span removed. */
  readonly content: string;
  /** The reasoning spans, joined in the order they appeared. */
  readonly reasoning: string;
}

function findEarliestOpenTag(text: string): { readonly index: number; readonly tag: string; readonly length: number } | null {
  let best: { index: number; tag: string; length: number } | null = null;
  for (const [marker, tag] of OPEN_TAGS) {
    const index = text.indexOf(marker);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, tag, length: marker.length };
  }
  return best;
}

/**
 * How much of a trailing fragment must be held back because it could still
 * grow into a delimiter. Any delimiter starts with '<', so only a trailing
 * run that begins at the last unmatched '<' is ever at risk.
 */
function heldBackFrom(text: string): number {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen === -1) return text.length;
  if (text.length - lastOpen >= MAX_DELIMITER_LENGTH) return text.length;
  return lastOpen;
}

/**
 * Split a COMPLETE assistant message into answer and inline reasoning.
 *
 * An unterminated opening tag (the model was cut off mid-thought, or the
 * endpoint dropped the closing tag) takes everything after it as reasoning
 * rather than leaving a dangling `<think>` in the answer.
 */
export function splitInlineReasoning(text: string): InlineReasoningSplit {
  if (!text.includes('<')) return { content: text, reasoning: '' };
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let rest = text;
  for (;;) {
    const open = findEarliestOpenTag(rest);
    if (!open) {
      contentParts.push(rest);
      break;
    }
    contentParts.push(rest.slice(0, open.index));
    const afterOpen = rest.slice(open.index + open.length);
    const closeMarker = `</${open.tag}>`;
    const closeIndex = afterOpen.indexOf(closeMarker);
    if (closeIndex === -1) {
      reasoningParts.push(afterOpen);
      break;
    }
    reasoningParts.push(afterOpen.slice(0, closeIndex));
    rest = afterOpen.slice(closeIndex + closeMarker.length);
  }
  return {
    content: contentParts.join('').replace(/\n{3,}/g, '\n\n').trim(),
    reasoning: reasoningParts.join('\n').trim(),
  };
}

/**
 * Streaming form of {@link splitInlineReasoning}.
 *
 * Applied to the delta loop rather than only to the assembled response so the
 * two agree: splitting only at the end would stream the reasoning to the TUI
 * as answer text and then retract it when the turn completed. Text that could
 * still turn out to be the start of a delimiter is held back until the next
 * chunk resolves it, so a tag split across chunk boundaries is not missed and
 * no partial tag is ever emitted.
 *
 * `flush()` must be called once the stream ends to release whatever is held.
 */
export class InlineReasoningStreamSplitter {
  private buffer = '';
  private openTag: string | null = null;

  push(chunk: string): InlineReasoningSplit {
    this.buffer += chunk;
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    for (;;) {
      if (this.openTag === null) {
        const open = findEarliestOpenTag(this.buffer);
        if (open) {
          contentParts.push(this.buffer.slice(0, open.index));
          this.buffer = this.buffer.slice(open.index + open.length);
          this.openTag = open.tag;
          continue;
        }
        const safe = heldBackFrom(this.buffer);
        contentParts.push(this.buffer.slice(0, safe));
        this.buffer = this.buffer.slice(safe);
        break;
      }
      const closeMarker = `</${this.openTag}>`;
      const closeIndex = this.buffer.indexOf(closeMarker);
      if (closeIndex !== -1) {
        reasoningParts.push(this.buffer.slice(0, closeIndex));
        this.buffer = this.buffer.slice(closeIndex + closeMarker.length);
        this.openTag = null;
        continue;
      }
      const safe = heldBackFrom(this.buffer);
      reasoningParts.push(this.buffer.slice(0, safe));
      this.buffer = this.buffer.slice(safe);
      break;
    }
    return { content: contentParts.join(''), reasoning: reasoningParts.join('') };
  }

  /** Release the held-back tail. Inside an unterminated tag it is reasoning. */
  flush(): InlineReasoningSplit {
    const remainder = this.buffer;
    this.buffer = '';
    if (this.openTag !== null) {
      this.openTag = null;
      return { content: '', reasoning: remainder };
    }
    return { content: remainder, reasoning: '' };
  }
}
