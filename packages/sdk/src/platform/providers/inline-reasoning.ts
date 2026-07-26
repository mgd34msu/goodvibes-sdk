/**
 * Keeping a model's reasoning out of its answer, at the provider boundary.
 *
 * A cerebras reply put reasoning into an ntfy notification whose surface
 * policy is `reasoningVisibility: 'suppress'`. The suppression was never at
 * fault — the reasoning never reached the reasoning channel at all, so nothing
 * downstream could tell it apart from the answer. It reached the transcript,
 * the session export and every channel body as plain assistant text.
 *
 * Reasoning arrives in two shapes, and BOTH were landing in `content`:
 *
 * 1. A structured field (`reasoning`, `reasoning_content`).
 *    openai-stream-delta.ts knows how to route these, but only when its
 *    `allowReasoning` option is set — and openai-compat derived that from the
 *    provider's `reasoningFormat`, which is a REQUEST-side setting naming
 *    which reasoning PARAMETER an endpoint accepts. Cerebras, groq and mistral
 *    are all registered `reasoningFormat: 'none'`, which told the extractor to
 *    FOLD a returned reasoning field into `content`. Cerebras returns
 *    reasoning on exactly that field, so its chain-of-thought became ordinary
 *    answer text, interleaved with the real answer. What a response CARRIES is
 *    not a function of what the request ASKED FOR: a reasoning field is
 *    reasoning on every endpoint, so openai-compat now always classifies it.
 *
 * 2. A tag inside the content stream (`<think>…</think>`), which some models
 *    emit with no structured field at all. {@link splitInlineReasoning} and
 *    {@link InlineReasoningStreamSplitter} below handle that shape.
 *
 * Both belong here rather than at a render site: the wire format is the
 * provider's concern, and splitting once means every consumer — TUI
 * transcript, webui, session export, channel surfaces — gets the same correct
 * content/reasoning split and applies its own visibility policy to it. A
 * filter at any single render site would fix that site and leave every other
 * one reading reasoning as the answer.
 *
 * One invariant governs all of it: the split must never EMPTY a reply. A model
 * that writes nothing outside its reasoning has no answer beside it, so the
 * reasoning IS the answer — see the floor in openai-compat.ts, which is what
 * the old folding behaviour was really protecting.
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

/** What a stream-delta extractor produced for one chunk. */
export interface StreamTextFragments {
  readonly content: readonly string[];
  readonly reasoning: readonly string[];
}

/** Forwards a classified fragment to the caller's live delta handler. */
export type StreamTextEmit = (delta: { content?: string; reasoning?: string }) => void;

/**
 * Accumulates one streamed turn, keeping reasoning out of the answer.
 *
 * Owns both shapes reasoning arrives in — a structured `reasoning` /
 * `reasoning_content` field, and a tag inside the content stream — and keeps
 * the running answer and the running reasoning apart, forwarding each fragment
 * as it is classified so a live view is never shown reasoning as answer text
 * and then made to retract it.
 */
export class StreamTextAccumulator {
  private readonly splitter = new InlineReasoningStreamSplitter();
  private contentText = '';
  private reasoningText = '';

  push(fragments: StreamTextFragments, emit?: StreamTextEmit): void {
    for (const fragment of fragments.content) {
      const split = this.splitter.push(fragment);
      if (split.content) this.take(split.content, 'content', emit);
      if (split.reasoning) this.take(split.reasoning, 'reasoning', emit);
    }
    for (const fragment of fragments.reasoning) this.take(fragment, 'reasoning', emit);
  }

  /**
   * Release whatever the splitter still holds back and report the turn.
   *
   * `content` is empty when the model wrote nothing outside its reasoning —
   * the caller decides what that means, since an empty answer is normal on a
   * tool-call turn and a lost reply on any other.
   */
  finish(emit?: StreamTextEmit): InlineReasoningSplit {
    const tail = this.splitter.flush();
    if (tail.content) this.take(tail.content, 'content', emit);
    if (tail.reasoning) this.take(tail.reasoning, 'reasoning', emit);
    return { content: this.contentText, reasoning: this.reasoningText };
  }

  private take(text: string, kind: 'content' | 'reasoning', emit?: StreamTextEmit): void {
    if (kind === 'content') this.contentText += text;
    else this.reasoningText += text;
    emit?.({ [kind]: text });
  }
}
