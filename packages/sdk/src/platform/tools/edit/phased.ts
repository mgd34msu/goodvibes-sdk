/**
 * Phased wrapper for the edit tool.
 *
 * Delegates entirely to the existing `createEditTool` implementation and adds
 * the PhasedTool metadata required by the phased executor.
 */
import { asPhasedTool } from '../../runtime/tools/adapter.js';
import { createEditTool } from './index.js';
import type { EditToolOptions } from './index.js';
import type { FileStateCache } from '../../state/file-cache.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a phased edit tool.
 *
 * Category  : `write` — edit operations mutate files on disk.
 * Cancellable: `false` — mid-flight edits could corrupt open transactions;
 *   the executor waits for completion before processing cancellation.
 *
 * @param fileCache - Shared FileStateCache instance for OCC conflict detection.
 * @param options   - Optional edit tool configuration (cwd, fileUndoManager).
 * @returns A PhasedTool that delegates execution to `createEditTool`.
 */
export function createPhasedEditTool(
  fileCache: FileStateCache,
  options?: EditToolOptions,
) {
  const inner = createEditTool(fileCache, options);
  return asPhasedTool(inner, { category: 'write', cancellable: false });
}
