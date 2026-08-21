import type { Frame, FrameLocator, Locator, Page } from 'playwright-core';
import { isCardFieldDescriptor } from '../security/card-fields.js';
import type { BrowserElementRef, BrowserSnapshot, CardFieldGuard } from './browser-types.js';

/**
 * Snapshot-and-ref addressing.
 *
 * Every input action targets an element that came from a snapshot of a page
 * this tool controls, and the element's identity is re-checked immediately
 * before the action runs. There is no code path that types into "whatever has
 * focus": without a resolvable ref, an action fails instead of guessing.
 */

const MAX_ELEMENTS = 400;
const MAX_NAME_LENGTH = 160;

interface RawElement {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly selector: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly depth: number;
  /** True when activating this control submits a form, an outward effect. */
  readonly submits: boolean;
  /**
   * The attributes that identify a payment field, collected but NOT judged here.
   *
   * This function is serialized and evaluated inside the page, so it cannot
   * import anything, a classification written here could never be tested
   * against real inputs, only read. So the raw attributes come back and
   * `isCardFieldDescriptor` decides in-process, where a test can drive it.
   */
  readonly control?: {
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
 * Runs inside the page. It must be entirely self-contained, it is serialized
 * and evaluated in the browser, so it cannot reference anything from module
 * scope. It reads the DOM and never mutates it: no injected attributes, no
 * markers left behind in the user's real, logged-in page.
 */
function collectElements(limit: number): RawElement[] {
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[onclick]',
    'h1',
    'h2',
    'h3',
    'label',
  ].join(',');

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const cssEscape = (value: string): string => {
    if (typeof window.CSS?.escape === 'function') return window.CSS.escape(value);
    return value.replace(/[^\w-]/g, (character) => `\\${character}`);
  };

  /**
   * A CSS path to the element, crossing open shadow boundaries by continuing
   * from the shadow host. Playwright's CSS engine pierces open shadow roots,
   * so a single path resolves whether or not the element lives inside one,
   * verified against a real page rather than assumed.
   */
  const selectorFor = (element: Element): string => {
    if (element.id && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) {
      return `#${cssEscape(element.id)}`;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      const root: Node = current.getRootNode();
      // Step out of a shadow root onto its host and keep going.
      const host: Element | null = root instanceof ShadowRoot ? root.host : null;
      const parent: Element | null = current.parentElement ?? host;
      if (!parent) break;
      const tag = current.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 && index > 0 ? `${tag}:nth-of-type(${String(index)})` : tag);
      current = parent;
    }
    return parts.length > 0 ? `html > body ${parts.join(' > ')}`.replace('html > body body', 'html > body') : 'html';
  };

  const roleFor = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'label') return 'label';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'generic';
  };

  const nameFor = (element: Element): string => {
    const labelled = element.getAttribute('aria-label')
      ?? element.getAttribute('alt')
      ?? element.getAttribute('placeholder')
      ?? element.getAttribute('title');
    if (labelled && labelled.trim()) return labelled.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target?.textContent?.trim()) return target.textContent.trim();
    }
    if (element.tagName === 'INPUT') {
      const input = element as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return input.value;
      const label = input.labels?.[0]?.textContent?.trim();
      if (label) return label;
      const name = input.getAttribute('name');
      if (name) return name;
      return '';
    }
    const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
    return text.replace(/\s+/g, ' ').trim();
  };

  const depthOf = (element: Element): number => {
    let depth = 0;
    let current: Element | null = element.parentElement;
    while (current) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };

  const submitsForm = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input') return type === 'submit' || type === 'image';
    if (tag === 'button') {
      if (type === 'submit') return true;
      // A button inside a form with no explicit type submits it by default.
      return type === '' && element.closest('form') !== null;
    }
    return false;
  };

  /** Every root to search: the document plus every open shadow root inside it. */
  const collectRoots = (): (Document | ShadowRoot)[] => {
    const roots: (Document | ShadowRoot)[] = [document];
    const queue: (Document | ShadowRoot)[] = [document];
    while (queue.length > 0) {
      const root = queue.shift();
      if (!root) break;
      for (const element of Array.from(root.querySelectorAll('*'))) {
        const shadow = element.shadowRoot;
        if (shadow) {
          roots.push(shadow);
          queue.push(shadow);
        }
      }
    }
    return roots;
  };

  const candidates: Element[] = [];
  for (const root of collectRoots()) {
    candidates.push(...Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)));
  }

  const results: RawElement[] = [];
  const seen = new Set<Element>();
  for (const element of candidates) {
    if (results.length >= limit) break;
    if (seen.has(element)) continue;
    seen.add(element);
    if (!isVisible(element)) continue;
    const tag = element.tagName.toLowerCase();
    const input = element as HTMLInputElement;
    const isFormControl = tag === 'input' || tag === 'textarea' || tag === 'select';
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    results.push({
      tag,
      role: roleFor(element),
      name: nameFor(element).slice(0, 160),
      selector: selectorFor(element),
      value: isFormControl && type !== 'password' ? String(input.value ?? '') : null,
      disabled: isFormControl ? Boolean(input.disabled) : false,
      checked: type === 'checkbox' || type === 'radio' ? Boolean(input.checked) : null,
      depth: depthOf(element),
      submits: submitsForm(element),
      control: {
        type,
        autocomplete: element.getAttribute('autocomplete') ?? '',
        name: element.getAttribute('name') ?? '',
        id: element.getAttribute('id') ?? '',
        placeholder: element.getAttribute('placeholder') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        label: isFormControl ? (input.labels?.[0]?.textContent ?? '').slice(0, 160) : '',
      },
    });
  }
  return results;
}

/** Reads back one element's identity so a ref can be re-verified before use. */
function describeElement(element: Element): { readonly tag: string; readonly name: string } {
  const labelled = element.getAttribute('aria-label')
    ?? element.getAttribute('alt')
    ?? element.getAttribute('placeholder')
    ?? element.getAttribute('title');
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    const buttonName = type === 'submit' || type === 'button' || type === 'reset' ? input.value : '';
    return {
      tag: element.tagName.toLowerCase(),
      name: (labelled ?? buttonName ?? input.labels?.[0]?.textContent ?? input.getAttribute('name') ?? '').trim().slice(0, 160),
    };
  }
  if (labelled && labelled.trim()) {
    return { tag: element.tagName.toLowerCase(), name: labelled.trim().slice(0, 160) };
  }
  const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
  return { tag: element.tagName.toLowerCase(), name: text.replace(/\s+/g, ' ').trim().slice(0, 160) };
}

let snapshotCounter = 0;

export class StaleElementError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'StaleElementError';
  }
}

/** Snapshots taken per page, so a ref can only be used against the page that produced it. */
export class SnapshotStore {
  private readonly snapshots = new Map<string, BrowserSnapshot>();

  set(snapshot: BrowserSnapshot): void {
    this.snapshots.set(`${snapshot.sessionId}:${snapshot.pageId}`, snapshot);
  }

  get(sessionId: string, pageId: string): BrowserSnapshot | null {
    return this.snapshots.get(`${sessionId}:${pageId}`) ?? null;
  }

  clear(sessionId: string, pageId: string): void {
    this.snapshots.delete(`${sessionId}:${pageId}`);
  }
}

/** The selector of one element within its own document, used to address iframes. */
function selectorOfFrameElement(element: Element): string {
  if (element.id) return `#${element.id.replace(/[^\w-]/g, '\\$&')}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === 1 && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const tag = current.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${String(index)})` : tag);
    current = parent;
  }
  return parts.join(' > ');
}

/**
 * The chain of iframe selectors leading to a frame, outermost first.
 * Returns null when any link cannot be addressed, so a frame is either fully
 * reachable or reported not at all, never half-addressable.
 */
async function frameChainFor(frame: Frame): Promise<readonly string[] | null> {
  // A host-backed frame already knows its chain; the host computed it when it
  // listed the frames, so there is nothing to ask for again.
  const precomputed = (frame as unknown as { readonly __frameChain?: readonly string[] }).__frameChain;
  if (precomputed) return precomputed;
  const chain: string[] = [];
  let current: Frame | null = frame;
  while (current && current.parentFrame()) {
    const element = await current.frameElement().catch(() => null);
    if (!element) return null;
    const selector = await element.evaluate(selectorOfFrameElement).catch(() => '');
    if (!selector) return null;
    chain.unshift(selector);
    current = current.parentFrame();
  }
  return chain;
}

/**
 * Snapshots are a read path back to a card number, and this is where it closes.
 *
 * `payments.checkout.fillCard` has the daemon type the owner's card into a
 * page so the model never holds it. Ten seconds later the model can call
 * `action:"snapshot"` and read `value` off every form control on that page,
 * including the one just filled. Without the two steps below, the containment
 * is theatre.
 *
 *   STRUCTURAL   a control the page itself declares to be a payment field
 *                never reports a value, filled or not, guard or no guard.
 *   VALUE-BASED  while material is live, the exact strings typed are removed
 *                from every name and value reported, wherever they appear.
 *
 * Both, because each covers the other's gap: the classification is defeated by
 * a page that misnames its fields, and the value matching only exists when a
 * guard is installed, which is why the fill refuses to run without one.
 */
export async function takeSnapshot(
  page: Page,
  sessionId: string,
  pageId: string,
  options: { readonly limit?: number | undefined; readonly guard?: CardFieldGuard | undefined } = {},
): Promise<BrowserSnapshot> {
  const limit = Math.max(1, Math.min(MAX_ELEMENTS, options.limit ?? MAX_ELEMENTS));
  const raw: (RawElement & { readonly frameChain: readonly string[] })[] = [];
  for (const frame of page.frames()) {
    if (raw.length >= limit) break;
    const chain = frame === page.mainFrame() ? [] : await frameChainFor(frame);
    if (chain === null) continue;
    const collected = await frame.evaluate(collectElements, limit - raw.length).catch(() => [] as RawElement[]);
    raw.push(...collected.map((element) => ({ ...element, frameChain: chain })));
  }
  snapshotCounter += 1;
  const scrub = (text: string): string =>
    options.guard === undefined ? text : options.guard.redact(sessionId, pageId, text);

  const elements: BrowserElementRef[] = raw.map((element, index) => {
    // A payment field's value is never reported. Not masked, not truncated,
    // absent, exactly as a password field's already is.
    // Built defensively: `element` comes back from `frame.evaluate`, so its
    // shape is whatever that frame produced. A host-backed frame, an older
    // driver, or a frame whose evaluate partially failed can all hand back a
    // record with no `control`, and a classifier that threw on one would take
    // out EVERY snapshot, not just the payment case it was added for.
    const control = element.control ?? undefined;
    const cardField = isCardFieldDescriptor({
      tag: element.tag,
      type: control?.type ?? '',
      autocomplete: control?.autocomplete ?? '',
      name: control?.name ?? '',
      id: control?.id ?? '',
      placeholder: control?.placeholder ?? '',
      ariaLabel: control?.ariaLabel ?? '',
      label: control?.label ?? '',
    });
    const value = cardField || element.value === null ? undefined : scrub(element.value);
    return {
      ref: `e${String(index + 1)}`,
      role: element.role,
      // The name is scrubbed too: a page is free to copy what was typed into a
      // label, an aria-label or a placeholder, and every one of those becomes
      // this field.
      name: scrub(element.name).slice(0, MAX_NAME_LENGTH),
      tag: element.tag,
      selector: element.selector,
      value,
      disabled: element.disabled || undefined,
      checked: element.checked ?? undefined,
      depth: element.depth,
      submits: element.submits,
      frameChain: element.frameChain,
      ...(cardField ? { cardField: true } : {}),
    };
  });
  return {
    sessionId,
    pageId,
    url: page.url(),
    title: await page.title().catch(() => ''),
    snapshotId: `s${String(snapshotCounter)}`,
    elements,
    truncated: raw.length >= limit,
  };
}

/** Narrows the page to the frame an element lives in, following the chain. */
function frameScope(page: Page, frameChain: readonly string[]): Page | FrameLocator {
  let scope: Page | FrameLocator = page;
  for (const selector of frameChain) {
    scope = scope.frameLocator(selector);
  }
  return scope;
}

function namesAgree(expected: string, actual: string): boolean {
  const left = expected.trim().toLowerCase();
  const right = actual.trim().toLowerCase();
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Turns a ref into a live locator, refusing when the page has moved on.
 *
 * A ref that no longer resolves, or resolves to a different element than the
 * snapshot recorded, fails with an instruction to re-snapshot. Acting on a
 * position alone is how automation clicks the wrong thing.
 */
export async function resolveRef(
  page: Page,
  snapshot: BrowserSnapshot | null,
  ref: string,
): Promise<{ readonly locator: Locator; readonly element: BrowserElementRef }> {
  if (!snapshot) {
    throw new StaleElementError(
      `No snapshot has been taken for this page, so ref ${ref} means nothing yet.`,
      'Call action:"snapshot" first, then use a ref from that snapshot.',
    );
  }
  const element = snapshot.elements.find((candidate) => candidate.ref === ref);
  if (!element) {
    throw new StaleElementError(
      `Ref ${ref} is not in the current snapshot of ${snapshot.url}.`,
      'Call action:"snapshot" to get current refs for this page.',
    );
  }
  if (page.url() !== snapshot.url) {
    throw new StaleElementError(
      `The page moved from ${snapshot.url} to ${page.url()} after the snapshot, so ref ${ref} no longer describes anything on it.`,
      'Call action:"snapshot" for the current page, then act on a ref from that snapshot.',
    );
  }
  const scope = frameScope(page, element.frameChain);
  const locator = scope.locator(element.selector).first();
  const count = await scope.locator(element.selector).count();
  if (count === 0) {
    throw new StaleElementError(
      `Ref ${ref} (${element.role} "${element.name}") is no longer present on ${page.url()}.`,
      'Call action:"snapshot" to get current refs, then retry.',
    );
  }
  const actual = await locator.evaluate(describeElement);
  if (actual.tag !== element.tag || !namesAgree(element.name, actual.name)) {
    throw new StaleElementError(
      `Ref ${ref} now points at a different element (snapshot recorded ${element.tag} "${element.name}", the page currently has ${actual.tag} "${actual.name}").`,
      'Call action:"snapshot" to get current refs, then retry.',
    );
  }
  return { locator, element };
}
