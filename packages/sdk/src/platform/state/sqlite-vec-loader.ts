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
 * code-index-store.ts (the repo source-tree code index; see CHANGELOG 0.38.0) so both
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
 * Thrown when the RUNTIME PLATFORM cannot load SQLite extensions at all —
 * most commonly a macOS-compiled binary, where bun:sqlite links Apple's
 * system SQLite, which ships with extension loading disabled. This is a
 * permanent capability limit of the platform, not a defect in the build:
 * callers should degrade to their documented no-vector mode with the
 * `reason` surfaced, rather than reporting an error. A missing extension
 * FILE (a genuine packaging defect) deliberately does NOT map to this class.
 */
export class SqliteVecPlatformUnsupportedError extends Error {
  readonly platformLimit = true;

  constructor(cause: string) {
    super(
      "this platform's SQLite does not allow loading extensions"
      + ' (macOS system SQLite); the semantic vector index is unavailable'
      + ` and memory search uses literal matching. Underlying refusal: ${cause}`,
    );
    this.name = 'SqliteVecPlatformUnsupportedError';
  }
}

/** True when a loadExtension throw is the platform capability refusal, not a packaging defect. */
function isExtensionLoadingRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Apple's SQLite refuses with an authorization message; a build with
  // SQLITE_OMIT_LOAD_EXTENSION names the capability. A missing file surfaces
  // as ENOENT/dlopen-no-such-file and must stay a loud defect.
  return /not authorized|omit.*load.*extension|extension loading is disabled/i.test(message);
}

/**
 * Loads the sqlite-vec extension into a Bun SQLite database.
 * Handles both bundled-binary and development execution contexts.
 *
 * Throws SqliteVecPlatformUnsupportedError when the platform itself refuses
 * extension loading (see the class doc); rethrows everything else untouched.
 */
export function loadSqliteVecExtension(db: Database): void {
  const bundledPath = resolveSqliteVecPath();
  try {
    if (bundledPath) {
      db.loadExtension(bundledPath);
    } else {
      loadSqliteVec(db);
    }
  } catch (err) {
    if (isExtensionLoadingRefusal(err)) {
      throw new SqliteVecPlatformUnsupportedError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
