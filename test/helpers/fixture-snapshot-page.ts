/**
 * fixture-snapshot-page.ts, a page object `takeSnapshot` can walk, built from
 * a fixture merchant's real markup.
 *
 * ══ Why this exists rather than a browser ═════════════════════════════════
 *
 * The leak this suite is chasing is: the daemon types the card, then the model
 * calls `action:"snapshot"` and reads it back out of the reported form values.
 * Proving that closed needs `takeSnapshot` itself, with real field attributes
 * and real filled values, not a hand-written element list, which would prove
 * only that the redactor redacts what a test author remembered to hand it.
 *
 * What it must NOT need is a downloaded browser binary. A containment property
 * this important cannot be exercised only in the subset of runs where a
 * Chromium download succeeded.
 *
 * So the fixture's own HTML is parsed here into exactly the record shape the
 * in-page collector produces, and the values come from the driver's form state
 *, what the daemon actually typed. Everything downstream of the collector is
 * the real code: the card-field classification, the guard, the scrubbing, the
 * element list the model would receive.
 *
 * The two fixtures make this worth doing twice over. Alpha's inputs carry the
 * standard `autocomplete="cc-number"` tokens, so the structural layer catches
 * them. Beta's carry none at all and are named in German, `kreditkartennummer`,
 * `pruefziffer`, so beta exercises the value-based layer instead, which is
 * exactly the split the design claims.
 */
import type { Page } from 'playwright-core';

/** One control, in the shape the in-page collector returns it. */
interface CollectedElement {
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly selector: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly depth: number;
  readonly submits: boolean;
  readonly control: {
    readonly type: string;
    readonly autocomplete: string;
    readonly name: string;
    readonly id: string;
    readonly placeholder: string;
    readonly ariaLabel: string;
    readonly label: string;
  };
}

/**
 * Collect every form control in some markup, with the values a form currently
 * holds.
 *
 * `values` is keyed by the same target string the checkout driver fills, the
 * element's id, so a page built here reports what the daemon typed, character
 * for character, before any redaction runs.
 */
export async function collectFixtureControls(
  html: string,
  values: ReadonlyMap<string, string>,
): Promise<CollectedElement[]> {
  const collected: CollectedElement[] = [];
  const rewriter = new HTMLRewriter().on('input, textarea, select, button', {
    element(element) {
      const tag = element.tagName.toLowerCase();
      const id = element.getAttribute('id') ?? '';
      const name = element.getAttribute('name') ?? '';
      const placeholder = element.getAttribute('placeholder') ?? '';
      collected.push({
        role: tag === 'button' ? 'button' : 'textbox',
        // A real collector falls back to the placeholder or the name for an
        // unlabelled input, and both fixtures rely on that, so does the leak
        // this file exists to catch, since a page can echo a typed value into
        // either one.
        name: placeholder.length > 0 ? placeholder : name,
        tag,
        selector: id.length > 0 ? `#${id}` : tag,
        value: tag === 'button' ? null : values.get(id) ?? '',
        disabled: false,
        checked: null,
        depth: 3,
        submits: tag === 'button',
        control: {
          type: element.getAttribute('type') ?? 'text',
          autocomplete: element.getAttribute('autocomplete') ?? '',
          name,
          id,
          placeholder,
          ariaLabel: element.getAttribute('aria-label') ?? '',
          label: '',
        },
      });
    },
  });
  await rewriter.transform(new Response(html)).text();
  return collected;
}

/**
 * A `Page` carrying those controls.
 *
 * Only the four things `takeSnapshot` asks a page for are implemented,
 * `frames`, `mainFrame`, `url` and `title`, because implementing more would
 * be inventing browser behaviour this test is in no position to vouch for.
 */
export function fixtureSnapshotPage(input: {
  readonly url: string;
  readonly title: string;
  readonly elements: readonly CollectedElement[];
  /** Body text the page renders, for the paths that report words rather than fields. */
  readonly bodyText?: string;
}): Page {
  const frame = {
    evaluate: async (): Promise<readonly CollectedElement[]> => input.elements,
    parentFrame: () => null,
    url: () => input.url,
    innerText: async () => input.bodyText ?? '',
  };
  return {
    frames: () => [frame],
    mainFrame: () => frame,
    url: () => input.url,
    title: async () => input.title,
  } as unknown as Page;
}
