import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ReadableHtmlExtraction {
  readonly title?: string;
  readonly byline?: string;
  readonly siteName?: string;
  readonly excerpt?: string;
  readonly textContent: string;
  readonly length: number;
  readonly links: readonly string[];
  readonly headings: readonly string[];
  readonly paragraphSamples: readonly string[];
}

const HTML_PARSE_LIMIT_BYTES = 5 * 1024 * 1024;

function normalizeText(value: string | undefined | null): string {
  return (value ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function uniqueText(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = normalizeText(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function truncateHtml(html: string): string {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes <= HTML_PARSE_LIMIT_BYTES) return html;
  return html.slice(0, HTML_PARSE_LIMIT_BYTES);
}

export function extractReadableHtml(html: string): ReadableHtmlExtraction | null {
  const dom = new JSDOM(truncateHtml(html), {
    contentType: 'text/html',
    includeNodeLocations: false,
    pretendToBeVisual: false,
  });
  try {
    const document = dom.window.document;
    document.querySelectorAll('script, style, noscript, iframe, template, svg, canvas').forEach((node) => node.remove());
    const headings = uniqueText(
      Array.from(document.querySelectorAll('h1, h2, h3'), (node) => node.textContent ?? ''),
      24,
    );
    const paragraphSamples = uniqueText(
      Array.from(document.querySelectorAll('p'), (node) => node.textContent ?? ''),
      12,
    );
    const links = uniqueText(
      Array.from(document.querySelectorAll('a[href]'), (node) => node.getAttribute('href') ?? ''),
      80,
    );
    const parsed = new Readability(document.cloneNode(true) as Document).parse();
    const textContent = normalizeText(parsed?.textContent ?? document.body?.textContent ?? '');
    if (!textContent) return null;
    const title = headings[0] ?? normalizeText(parsed?.title);
    return {
      ...(title ? { title } : {}),
      ...(normalizeText(parsed?.byline) ? { byline: normalizeText(parsed?.byline) } : {}),
      ...(normalizeText(parsed?.siteName) ? { siteName: normalizeText(parsed?.siteName) } : {}),
      ...(normalizeText(parsed?.excerpt) ? { excerpt: normalizeText(parsed?.excerpt) } : {}),
      textContent,
      length: parsed?.length ?? textContent.length,
      links,
      headings,
      paragraphSamples,
    };
  } finally {
    dom.window.close();
  }
}
