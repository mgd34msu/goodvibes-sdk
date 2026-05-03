import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const BUILT_PACKAGE_ENTRIES = [
  'contracts',
  'daemon-sdk',
  'errors',
  'operator-sdk',
  'peer-sdk',
  'sdk',
  'transport-core',
  'transport-http',
  'transport-realtime',
] as const;

describe('compiled dist fixtures', () => {
  for (const packageName of BUILT_PACKAGE_ENTRIES) {
    test(`${packageName} dist entry is not older than source entry`, () => {
      const sourceEntry = join(import.meta.dir, '..', 'packages', packageName, 'src', 'index.ts');
      const distEntry = join(import.meta.dir, '..', 'packages', packageName, 'dist', 'index.js');
      expect(existsSync(sourceEntry)).toBe(true);
      expect(existsSync(distEntry)).toBe(true);
      expect(statSync(distEntry).mtimeMs).toBeGreaterThanOrEqual(statSync(sourceEntry).mtimeMs);
    });
  }
});
