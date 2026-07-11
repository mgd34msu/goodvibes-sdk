/**
 * read-access.ts — a small shared seam that lets search / list / map tools apply
 * the SAME read-permission decision the read tool gets, per candidate file.
 *
 * The single source of truth is the injected {@link ReadAccessFilter}, wired at
 * the composition root to `PermissionManager.previewReadAccess`. Tools MUST use
 * this filter rather than re-implementing any path matching, so read-side deny
 * defaults (e.g. shipped credential-read rules) can never be bypassed by a search
 * that returns content or paths, and can never drift from a parallel matcher.
 *
 * Two enforcement shapes, matching the read tool's contract:
 *   - CONTENT results (grep match text, previews, extracted exports/symbols): a
 *     restricted file's content NEVER appears.
 *   - Path-only listings: the path is still shown but flagged access-restricted
 *     (hiding existence would be dishonest; exposing content is the real leak).
 *
 * Either way the result metadata carries a count of how many results were
 * withheld — the same "names shown, values withheld" idiom as withheld_env.
 */

/** Returns true when a read of `absolutePath` is currently allowed (content may be shown). */
export type ReadAccessFilter = (absolutePath: string) => boolean;

/** A filter that allows everything — the default when no permission seam is wired. */
export const ALLOW_ALL_READ_ACCESS: ReadAccessFilter = () => true;

/** Split items into content-allowed vs access-restricted by their path. */
export function partitionByReadAccess<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  filter: ReadAccessFilter | undefined,
): { allowed: T[]; restricted: T[] } {
  if (!filter) return { allowed: [...items], restricted: [] };
  const allowed: T[] = [];
  const restricted: T[] = [];
  for (const item of items) {
    (filter(pathOf(item)) ? allowed : restricted).push(item);
  }
  return { allowed, restricted };
}

/**
 * The metadata note for withheld results, or null when nothing was withheld.
 * Phrasing mirrors the withheld_env "N …" idiom so surfaces read consistently.
 */
export function accessRestrictedNote(restrictedCount: number): string | null {
  if (restrictedCount <= 0) return null;
  return `${restrictedCount} result${restrictedCount === 1 ? '' : 's'} in access-restricted file${restrictedCount === 1 ? '' : 's'}`;
}
