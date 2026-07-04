/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { load as loadSqliteVec } from 'sqlite-vec';

/**
 * Resolves the path to the sqlite-vec native extension.
 *
 * When running inside a Bun bundled executable (import.meta.url path contains
 * "$bunfs"), the npm package's import.meta.resolve() cannot find the extension
 * because the virtual filesystem does not contain node_modules. In that case,
 * the extension must be co-located with the binary under
 * `<execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>`.
 *
 * In development (bun run / node), the package's own getLoadablePath() is used
 * via the re-exported `load()` function.
 *
 * Shared by memory-vector-store.ts (MemoryStore's vector index) and
 * code-index-store.ts (the repo source-tree code index, Wave-5 W5.3) so both
 * indexes load the exact same native extension the exact same way.
 */
export function resolveSqliteVecPath(): string {
  const isBundled = import.meta.url.includes('$bunfs');
  if (isBundled) {
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch;
    const suffix = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
    return join(dirname(process.execPath), 'lib', `sqlite-vec-${os}-${arch}`, `vec0.${suffix}`);
  }
  // In dev mode, delegate to sqlite-vec's own resolver.
  return '';
}

/**
 * Loads the sqlite-vec extension into a Bun SQLite database.
 * Handles both bundled-binary and development execution contexts.
 */
export function loadSqliteVecExtension(db: Database): void {
  const bundledPath = resolveSqliteVecPath();
  if (bundledPath) {
    db.loadExtension(bundledPath);
  } else {
    loadSqliteVec(db);
  }
}
