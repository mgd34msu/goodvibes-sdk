import type { PermissionPromptRequest } from '../permissions/prompt.js';

/**
 * approval-hunk-apply.ts
 *
 * The SERVER-SIDE home of per-hunk approval math. This is the moved
 * `buildModifiedEditArgs` from the TUI's src/permissions/hunk-selection.ts, so
 * that TUI, webui, and any future surface produce IDENTICAL modified-edit args
 * for the same request + hunk selection. Before this move the reducer lived
 * TUI-local and a remote surface (webui) could not compute the subset the same
 * way — it never saw the hunks. Now the broker applies the selection once,
 * canonically, from the pending approval's own `request.args.edits`.
 *
 * Scoped to the `edit` tool: EditInput.edits is already an array of independent
 * find/replace units (each a natural "hunk"), so no diff/patch-apply primitive
 * is needed. Non-edit tools have no hunks — a selection against them is a
 * validation error, not a silent whole-request approve.
 *
 * PARITY CONTRACT (pinned by test): for a request whose `args.edits` is a valid
 * EditItem[] and a selection set S of in-range indices, the modified args are
 * `{ ...request.args, edits: edits.filter((_, i) => S.has(i)) }` — the exact
 * shape the retired TUI reducer produced.
 */

/**
 * Structural shape of one edit hunk, read defensively off `request.args.edits`.
 * Mirrors the TUI's `EditItemLike` (path/find/replace/id) so the parity oracle
 * and this reader agree on what counts as a hunk.
 */
export interface EditHunkLike {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly id?: string | undefined;
}

/** Runtime guard: is `value` shaped like an edit hunk? */
function isEditHunkLike(value: unknown): value is EditHunkLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['path'] === 'string'
    && typeof candidate['find'] === 'string'
    && typeof candidate['replace'] === 'string'
    && (candidate['id'] === undefined || typeof candidate['id'] === 'string')
  );
}

/**
 * Extract a validated EditHunkLike[] from a permission request's args, or null
 * if the args are not edit-shaped (no `edits` array, empty, or any entry that is
 * not a valid hunk). Mirrors the TUI's `readEditItems` exactly.
 */
export function readApprovalEditHunks(args: Record<string, unknown>): EditHunkLike[] | null {
  const edits = args['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const items: EditHunkLike[] = [];
  for (const entry of edits) {
    if (!isEditHunkLike(entry)) return null;
    items.push(entry);
  }
  return items;
}

/**
 * buildModifiedEditArgs — returns `request.args` with `edits` filtered to exactly
 * the selected hunk indices (in original order), preserving every other
 * EditInput field untouched. This is the retired TUI `buildModifiedEditArgs`,
 * now server-side. Callers pass a selection as an index array or Set.
 *
 * If the request is not edit-shaped, `edits` becomes `[]` (matching the TUI's
 * `readEditItems(...) ?? []` degenerate path). Validate first with
 * {@link resolveApprovalHunkSelection} when you need an honest rejection instead
 * of a silent empty selection.
 */
export function buildModifiedEditArgs(
  request: Pick<PermissionPromptRequest, 'args'>,
  selectedHunks: ReadonlySet<number> | readonly number[],
): Record<string, unknown> {
  const selected = selectedHunks instanceof Set ? selectedHunks : new Set(selectedHunks);
  const hunks = readApprovalEditHunks(request.args) ?? [];
  const filtered = hunks.filter((_, index) => selected.has(index));
  return { ...request.args, edits: filtered };
}

export type ApprovalHunkSelectionResolution =
  | {
      readonly ok: true;
      readonly modifiedArgs: Record<string, unknown>;
      readonly selectedCount: number;
      readonly totalHunks: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Validate a per-hunk selection against a pending approval's own request and,
 * when valid, compute the canonical modified args. This is the single place the
 * bounds/shape rules live:
 *  - the request MUST be edit-shaped (has a valid `edits` array) — selecting
 *    hunks on a non-edit tool is a client error, not a whole-request approve;
 *  - every index MUST be a finite integer in [0, totalHunks);
 *  - duplicate indices are tolerated (deduped by the Set) — selecting the same
 *    hunk twice is not an error.
 *
 * An empty selection is allowed and yields `edits: []` (the caller — the human's
 * surface — is responsible for the "nothing selected" UX; the wire honors it as
 * an explicit approve-of-nothing). Callers that want "no selection = approve
 * all" must simply NOT pass a selection (see the broker's back-compat path).
 */
export function resolveApprovalHunkSelection(
  request: Pick<PermissionPromptRequest, 'args'>,
  selectedHunks: readonly number[],
): ApprovalHunkSelectionResolution {
  const hunks = readApprovalEditHunks(request.args);
  if (hunks === null) {
    return { ok: false, reason: 'This approval has no per-hunk edit list; selectedHunks is not applicable.' };
  }
  for (const index of selectedHunks) {
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) {
      return {
        ok: false,
        reason: `selectedHunks index ${String(index)} is out of range for ${hunks.length} hunk(s).`,
      };
    }
  }
  const selected = new Set(selectedHunks);
  return {
    ok: true,
    modifiedArgs: buildModifiedEditArgs(request, selected),
    selectedCount: selected.size,
    totalHunks: hunks.length,
  };
}
