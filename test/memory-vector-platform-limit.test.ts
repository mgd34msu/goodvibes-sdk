/**
 * A platform that refuses SQLite extension loading (macOS system SQLite in a
 * compiled binary) is a capability limit, not a fault: the vector store must
 * degrade with platformLimitReason set and NO error field, while a genuine
 * packaging defect (missing extension file) must stay a loud error.
 */
import { describe, expect, test } from 'bun:test';
import { SqliteVecPlatformUnsupportedError } from '../packages/sdk/src/platform/state/sqlite-vec-loader.ts';

describe('sqlite-vec platform-limit classification', () => {
  test('the typed platform error carries the honest literal-fallback wording', () => {
    const err = new SqliteVecPlatformUnsupportedError('not authorized');
    expect(err.platformLimit).toBe(true);
    expect(err.message).toContain('does not allow loading extensions');
    expect(err.message).toContain('literal matching');
    // The reason must never read as a fault: release smokes grep for these.
    expect(err.message.toLowerCase()).not.toContain('error');
    expect(err.message.toLowerCase()).not.toContain('fail');
  });
  test('the real darwin refusal message classifies as the platform limit', () => {
    // Verbatim from a macOS-compiled binary (Apple system SQLite):
    const darwin = 'This build of sqlite3 does not support dynamic extension loading';
    const err = new SqliteVecPlatformUnsupportedError(darwin);
    expect(err.platformLimit).toBe(true);
  });
});

import { loadSqliteVecExtension } from '../packages/sdk/src/platform/state/sqlite-vec-loader.ts';

describe('refusal classification against the real messages', () => {
  const fakeDb = (msg: string) => ({ loadExtension: () => { throw new Error(msg); } });
  test('darwin system-sqlite refusal → platform limit', () => {
    // Force the bundled path off; loadSqliteVec delegates and throws our fake's message
    expect(() => loadSqliteVecExtension(fakeDb('This build of sqlite3 does not support dynamic extension loading') as never))
      .toThrow(SqliteVecPlatformUnsupportedError);
  });
  test('missing file stays a loud defect', () => {
    expect(() => loadSqliteVecExtension(fakeDb('dlopen failed: no such file or directory') as never))
      .not.toThrow(SqliteVecPlatformUnsupportedError);
  });
});
