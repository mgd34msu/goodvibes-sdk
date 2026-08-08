import { describe, expect, test } from 'bun:test';
import { TtsTextChunker } from '../packages/sdk/src/platform/voice/spoken-turn/text-chunker.js';
import { StreamingCodeFenceFilter, stripMarkdownForSpeech } from '../packages/sdk/src/platform/voice/spoken-turn/speech-markdown.js';

describe('TtsTextChunker', () => {
  test('flushes complete sentences before retaining the next fragment', () => {
    const chunker = new TtsTextChunker({ minBoundaryChars: 8 });

    expect(chunker.push('Hello there. Keep going')).toEqual(['Hello there.']);
    expect(chunker.flushAll()).toEqual(['Keep going']);
  });

  test('flushes buffered speech after max latency even without punctuation', () => {
    let now = 1_000;
    const chunker = new TtsTextChunker({
      maxLatencyMs: 500,
      now: () => now,
    });

    expect(chunker.push('short phrase')).toEqual([]);
    now += 499;
    expect(chunker.flushDue()).toEqual([]);
    now += 1;
    expect(chunker.flushDue()).toEqual(['short phrase']);
  });

  test('splits long chunks at a word boundary', () => {
    const chunker = new TtsTextChunker({
      maxChunkChars: 18,
      minBoundaryChars: 200,
    });

    expect(chunker.push('alpha beta gamma delta')).toEqual(['alpha beta gamma']);
    expect(chunker.flushAll()).toEqual(['delta']);
  });

  test('strips markdown formatting from a flushed chunk', () => {
    const chunker = new TtsTextChunker({ minBoundaryChars: 8 });

    expect(chunker.push('This is **bold** and _italic_ text.')).toEqual(['This is bold and italic text.']);
  });

  test('a fenced code block split across many deltas produces one placeholder and no code text', () => {
    const chunker = new TtsTextChunker({ minBoundaryChars: 4 });
    const deltas = ['Before.\n``', '`typ', 'escript\nconst x', ' = 1;\n``', '`\nAfter.'];

    const chunks: string[] = [];
    for (const delta of deltas) chunks.push(...chunker.push(delta));
    chunks.push(...chunker.flushAll());

    const joined = chunks.join(' ');
    expect(joined).toContain('Before.');
    expect(joined).toContain('Code block omitted.');
    expect(joined).toContain('After.');
    expect(joined).not.toContain('const x');
    expect(joined).not.toContain('typescript');
    expect(chunks.filter((c) => c.includes('Code block omitted.')).length).toBe(1);
  });
});

describe('stripMarkdownForSpeech', () => {
  test('strips headings, keeping the text', () => {
    expect(stripMarkdownForSpeech('# Title\n## Subtitle')).toBe('Title\nSubtitle');
  });

  test('strips bold, italic, and strikethrough markers without mangling identifiers or math', () => {
    expect(stripMarkdownForSpeech('**bold** __also bold__ *italic* _also italic_ ~~gone~~')).toBe(
      'bold also bold italic also italic gone',
    );
    expect(stripMarkdownForSpeech('snake_case_word stays intact')).toBe('snake_case_word stays intact');
    expect(stripMarkdownForSpeech('the answer is 2*3 not 2 * 3')).toBe('the answer is 2*3 not 2 * 3');
  });

  test('strips inline code, keeping the code text', () => {
    expect(stripMarkdownForSpeech('run `npm install` first')).toBe('run npm install first');
  });

  test('strips links and images, keeping the visible text', () => {
    expect(stripMarkdownForSpeech('see [the docs](https://example.com/docs) for more')).toBe('see the docs for more');
    expect(stripMarkdownForSpeech('![a diagram](https://example.com/diagram.png)')).toBe('a diagram');
  });

  test('strips autolinks down to the host', () => {
    expect(stripMarkdownForSpeech('visit <https://example.com/path?q=1>')).toBe('visit example.com');
  });

  test('drops list bullets, blockquote markers, and horizontal rules', () => {
    expect(stripMarkdownForSpeech('- first\n* second\n1. third')).toBe('first\nsecond\nthird');
    expect(stripMarkdownForSpeech('> quoted line')).toBe('quoted line');
    expect(stripMarkdownForSpeech('above\n---\nbelow')).toBe('above\nbelow');
  });

  test('drops raw HTML tags', () => {
    expect(stripMarkdownForSpeech('a<br/>b <div class="x">text</div>')).toBe('ab text');
  });

  test('table rows: separator row is dropped, data rows read as comma-separated cells', () => {
    const table = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
    expect(stripMarkdownForSpeech(table)).toBe('Name, Age\nAlice, 30');
  });

  test('nested/combined constructs come out as plain words', () => {
    expect(stripMarkdownForSpeech('# **[Home](https://example.com)**')).toBe('Home');
    expect(stripMarkdownForSpeech('**bold link [here](https://example.com) yes**')).toBe('bold link here yes');
  });
});

describe('StreamingCodeFenceFilter', () => {
  test('passes prose through unchanged when there is no fence', () => {
    const filter = new StreamingCodeFenceFilter();
    expect(filter.push('Hello ') + filter.push('world.')).toBe('Hello world.');
    expect(filter.flush()).toBe('');
  });

  test('swallows a fenced block opened and closed within one push, emitting the placeholder once', () => {
    const filter = new StreamingCodeFenceFilter();
    const out = filter.push('Before\n```js\nconst x = 1;\n```\nAfter');
    expect(out).toBe('Before\n Code block omitted. \nAfter');
  });

  test('carries partial fence-marker state across many small deltas, including a fence split mid-backtick', () => {
    const filter = new StreamingCodeFenceFilter();
    const deltas = ['Before.\n`', '`', '`ts\ncode here\nmore code\n`', '`', '`\nAfter.'];
    let out = '';
    for (const delta of deltas) out += filter.push(delta);
    out += filter.flush();

    expect(out).toBe('Before.\n Code block omitted. \nAfter.');
  });

  test('an unclosed fence at flush() stays swallowed', () => {
    const filter = new StreamingCodeFenceFilter();
    let out = filter.push('Before\n```\nsome code\nmore code');
    out += filter.flush();
    expect(out).toBe('Before\n Code block omitted. ');
  });

  test('an indented fence inside a list item is still recognized', () => {
    const filter = new StreamingCodeFenceFilter();
    const out = filter.push('  ```\n  code\n  ```\nAfter');
    expect(out).toBe(' Code block omitted. \nAfter');
  });
});
