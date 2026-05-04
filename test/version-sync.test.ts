import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('version-sync', () => {
test('SDK baked version fallback stays aligned with the root package version', () => {
  const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const versionSource = readFileSync(
    resolve(ROOT, 'packages', 'sdk', 'src', 'platform', 'version.ts'),
    'utf8',
  );
  const match = versionSource.match(/\bversion\s*=\s*['"](\d+\.\d+\.\d+[^'"]*)['"]/);

  expect(match).not.toBeNull();
  expect(match?.[1]).toBe(rootPackage.version);
});
});
