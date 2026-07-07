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
});
