/**
 * Cursor-based pagination utilities for daemon route handlers.
 *
 * Cursor format: opaque base64url-encoded JSON `{id: string, createdAt: number}`
 * encoding the stable sort position. Cursors remain valid across inserts
 * (no offset-based pagination).
 *
 * @public
 */

/**
 * Paginated response envelope. Returned by list endpoints that support
 * cursor-based pagination.
 *
 * @public
 */
export interface PaginatedResponse<T> {
  /** The page of items. */
  readonly items: readonly T[];
  /**
   * Opaque cursor to pass as `?cursor=` to retrieve the next page.
   * Absent when this is the last page.
   */
  readonly nextCursor?: string | undefined;
  /** Whether there are more items beyond this page. */
  readonly hasMore: boolean;
}

/** Internal cursor payload. @internal */
interface CursorPayload {
  readonly id: string;
  readonly createdAt?: number | undefined;
}

/**
 * Encode a cursor from a stable sort position.
 *
 * @param id - The item id used as the tiebreak.
 * @param createdAt - Optional creation timestamp for secondary sort key.
 * @returns Opaque base64url cursor string.
 * @public
 */
export function encodeCursor(id: string, createdAt?: number): string {
  const payload: CursorPayload = createdAt !== undefined ? { id, createdAt } : { id };
  const json = JSON.stringify(payload);
  // base64url encode (no padding, URL-safe characters)
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor string.
 *
 * @param raw - The cursor string from `?cursor=`.
 * @returns The decoded payload, or `null` if the cursor is invalid.
 * @public
 */
export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        id: p.id as string,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Options for `paginateItems`.
 * @public
 */
export interface PaginateItemsOptions {
  /**
   * Set to `true` when items are sorted **descending** by `createdAt` (newest
   * first).  This inverts the insertion-point comparison used during
   * deleted-cursor recovery so that the correct position is found regardless
   * of sort direction.  Defaults to `false` (ascending / oldest-first).
   */
  readonly descending?: boolean | undefined;
}

/**
 * Apply cursor-based pagination to an already-sorted array of items.
 *
 * Items must be sorted in a stable order. The cursor encodes the last-seen
 * item's `id` (and optionally `createdAt`). Items after the cursor position
 * are returned.
 *
 * ### Deleted-cursor recovery (m3/m4)
 * When the cursor's `id` is not found in the current page (i.e. the item was
 * deleted mid-walk), the implementation falls back to the `createdAt`
 * timestamp in the cursor to locate the insertion point.
 *
 * - **Ascending** (default, `options.descending` falsy): finds the first item
 *   whose own `createdAt` is **strictly greater** than the cursor's
 *   `createdAt`, then starts the page from that position.
 * - **Descending** (`options.descending: true`): finds the first item whose
 *   own `createdAt` is **strictly less** than the cursor's `createdAt`, which
 *   is the correct forward position in a newest-first sequence.
 *
 * Without `createdAt` available in the cursor, recovery falls back to the
 * first position (index 0) to avoid returning an empty page.
 *
 * Callers that need stable recovery across deletions should pass `getCreatedAt`
 * and ensure cursors are encoded with `createdAt`.  Callers whose store sorts
 * descending must also pass `options.descending: true`.
 *
 * @param items - Sorted array of all items.
 * @param limit - Maximum number of items to return (already clamped by caller).
 * @param rawCursor - Raw cursor string from the request (`?cursor=`).
 * @param getId - Extract the item's id.
 * @param getCreatedAt - Optional: extract the item's creation timestamp (ms since epoch).
 * @param options - Optional pagination options (e.g. sort direction).
 * @returns `PaginatedResponse<T>` or an error string for invalid cursors.
 * @public
 */
export function paginateItems<T>(
  items: readonly T[],
  limit: number,
  rawCursor: string | null,
  getId: (item: T) => string,
  getCreatedAt?: (item: T) => number | undefined,
  options?: PaginateItemsOptions,
): PaginatedResponse<T> | { readonly error: string } {
  let startIndex = 0;

  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) {
      return { error: `Invalid cursor: ${rawCursor}` };
    }
    const afterIndex = items.findIndex((item) => getId(item) === decoded.id);
    if (afterIndex === -1) {
      // Cursor id not found — item was deleted mid-walk.
      // Use createdAt from the cursor to locate the insertion point.
      // For ascending sequences: first item with createdAt > cursor's createdAt.
      // For descending sequences: first item with createdAt < cursor's createdAt.
      // Without createdAt, restart from index 0.
      if (decoded.createdAt !== undefined && getCreatedAt !== undefined) {
        const descending = options?.descending === true;
        const insertionIndex = items.findIndex(
          (item) => {
            const ts = getCreatedAt(item);
            return descending
              ? ts !== undefined && ts < decoded.createdAt!
              : ts !== undefined && ts > decoded.createdAt!;
          },
        );
        startIndex = insertionIndex === -1 ? items.length : insertionIndex;
      } else {
        startIndex = 0;
      }
    } else {
      startIndex = afterIndex + 1;
    }
  }

  const page = items.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < items.length;

  const lastItem = page[page.length - 1];
  const nextCursor = hasMore && lastItem !== undefined
    ? encodeCursor(
        getId(lastItem),
        getCreatedAt !== undefined ? getCreatedAt(lastItem) : undefined,
      )
    : undefined;

  return { items: page, nextCursor, hasMore };
}

/**
 * Check whether the request URL contains pagination parameters.
 *
 * Used to distinguish backward-compatible (no params → plain array)
 * from paginated (with params → `PaginatedResponse<T>`) calls.
 *
 * @public
 */
export function hasPaginationParams(url: URL): boolean {
  return url.searchParams.has('limit') || url.searchParams.has('cursor');
}
