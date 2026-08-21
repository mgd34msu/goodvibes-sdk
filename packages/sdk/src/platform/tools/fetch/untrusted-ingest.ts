/**
 * untrusted-ingest.ts, telling the ledger that this tool read a page.
 *
 * ── The hole this closes ──────────────────────────────────────────────────
 *
 * The `fetch` tool recorded nothing. The browser engine recorded its page
 * reads, both mail surfaces recorded their message reads, and this one, the
 * cheapest and by far the most-used door onto the open web, was invisible to
 * the outward-effect guard entirely. A page loaded through `browser.*` could
 * not steer a send; the same page loaded through `fetch` could, with no
 * resistance at all. A boundary with a gap that size in its most-travelled path
 * is not a boundary, because anyone who wanted to drive an outward action would
 * simply use the door that is not watched.
 *
 * ── Why recording the TEXT is the part that matters ───────────────────────
 *
 * Recording only "a page was read" would close the hole and open a worse one.
 * The guard would then know a fetch happened and nothing about what it said, so
 * every later outward action would take the coarse path and be refused, and a
 * model that fetches a page in almost every session would find sending
 * permanently unavailable. That is precisely the failure this round exists to
 * undo, re-created on a new surface.
 *
 * With the text present the question stays narrow and answerable: does what is
 * about to leave repeat what was read. Ordinary work after a fetch proceeds
 * untouched, and only a message carrying the page's own words is refused.
 */

import { getProcessUntrustedContentLedger, originOf } from '../../security/untrusted-content.js';
import type { FetchUrlResult } from './types.js';

/**
 * Record each fetched page as untrusted content, with its origin and its text.
 *
 * A failed fetch is not recorded: nothing was read, so nothing could have been
 * derived from it, and treating a 404 as exposure would refuse later sends on
 * the strength of a page that never arrived. Same reasoning for an empty body.
 *
 * `final_url` wins over the requested url when they differ, because a redirect
 * means the text came from where it landed, and the landing origin is the one
 * a person needs in order to check the refusal for themselves.
 */
export function recordFetchedPagesAsUntrusted(results: readonly FetchUrlResult[]): void {
  const ledger = getProcessUntrustedContentLedger();
  const at = new Date().toISOString();
  for (const result of results) {
    if (result.error !== undefined) continue;
    const content = result.content;
    if (typeof content !== 'string' || content.trim().length === 0) continue;
    ledger.record({
      surface: 'web-page',
      origin: originOf(result.final_url ?? result.url),
      at,
      content,
    });
  }
}
