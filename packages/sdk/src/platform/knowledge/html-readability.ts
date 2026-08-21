/**
 * html-readability.ts, readable article text out of an HTML document, when
 * the optional parser is installed to produce it.
 *
 * `jsdom` and `@mozilla/readability` are both declared under
 * `optionalDependencies`. This file used to import both statically, which made
 * that declaration untrue for every surface that reaches knowledge extraction,
 * and the daemon reaches it, through knowledge/extractors.ts. With
 * `packages/sdk/node_modules/jsdom` removed, measured here:
 * `bun build packages/sdk/src/platform/daemon/cli.ts --compile` failed with
 * `Could not resolve: "jsdom"` and produced no binary at all, and the same
 * graph run from source died at MODULE INIT with `Cannot find package 'jsdom'`
 *, before main(), before the activity logger had a destination, and before
 * daemon/cli.ts's fatal-boot handler existed to say anything about it.
 *
 * Both are now reached through utils/optional-dependency.ts at the moment an
 * extraction actually needs them. When they are absent the extraction returns
 * `null` with a stated reason, and knowledge/extractors.ts falls back to its
 * lightweight HTML path carrying that reason as a warning, which is what the
 * `optionalDependencies` declaration promised in the first place.
 */

import { loadOptionalDependency } from '../utils/optional-dependency.js';

export interface ReadableHtmlExtraction {
  readonly title?: string | undefined;
  readonly byline?: string | undefined;
  readonly siteName?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly textContent: string;
  readonly length: number;
  readonly links: readonly string[];
  readonly headings: readonly string[];
  readonly paragraphSamples: readonly string[];
}

/** Whether the readable-HTML path can run in this installation, and why not. */
export interface HtmlReadabilityAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

const HTML_PARSE_LIMIT_BYTES = 5 * 1024 * 1024;

type JsdomModule = typeof import('jsdom');
type ReadabilityModule = typeof import('@mozilla/readability');

interface ReadabilityToolchain {
  readonly JSDOM: JsdomModule['JSDOM'];
  readonly Readability: ReadabilityModule['Readability'];
}

type ReadabilityToolchainLoad =
  | { readonly available: true; readonly toolchain: ReadabilityToolchain }
  | { readonly available: false; readonly reason: string };

/**
 * Resolve both optional packages, or state which one is missing.
 *
 * The specifiers are written out literally so a bundler still sees them and
 * bundles the packages when they ARE installed; only the moment of evaluation
 * moves from module init to first use.
 */
export async function loadHtmlReadabilityToolchain(): Promise<ReadabilityToolchainLoad> {
  const jsdom = await loadOptionalDependency('jsdom', () => import('jsdom'));
  if (!jsdom.available) return { available: false, reason: jsdom.reason };
  const readability = await loadOptionalDependency(
    '@mozilla/readability',
    () => import('@mozilla/readability'),
  );
  if (!readability.available) return { available: false, reason: readability.reason };
  return {
    available: true,
    toolchain: { JSDOM: jsdom.module.JSDOM, Readability: readability.module.Readability },
  };
}

/**
 * Report whether readable-HTML extraction is available without performing one.
 * Loads the packages if they have not been tried yet; the outcome is cached per
 * process by utils/optional-dependency.ts, so this costs one resolution attempt.
 */
export async function describeHtmlReadabilityAvailability(): Promise<HtmlReadabilityAvailability> {
  const loaded = await loadHtmlReadabilityToolchain();
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}

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

/**
 * Extract readable article text, or `null` when there is nothing readable,
 * and also `null` when the optional parser is not installed. The two cases are
 * told apart by `describeHtmlReadabilityAvailability()`; extractors.ts reports
 * the second as a warning on its fallback result, so a missing package never
 * looks like an empty page.
 */
export async function extractReadableHtml(html: string): Promise<ReadableHtmlExtraction | null> {
  const loaded = await loadHtmlReadabilityToolchain();
  if (!loaded.available) return null;
  const { JSDOM, Readability } = loaded.toolchain;
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
    const title = headings[0]! ?? normalizeText(parsed?.title);
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
