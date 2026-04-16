import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;

const targets = [
  join(root, 'packages', 'sdk', 'src', '_internal', 'platform', 'version.ts'),
];

for (const target of targets) {
  const source = readFileSync(target, 'utf8');
  // Tolerate both `"...";;` and `'...';` shapes so a prior manual edit with
  // the wrong quote style (or stray duplicate semicolon) gets normalized
  // back to the canonical `let version = 'X.Y.Z';` format that
  // test/version-sync.test.ts matches on.
  const next = source.replace(
    /let version = ['"][^'"]*['"];+/,
    `let version = '${version}';`,
  );
  if (next !== source) {
    writeFileSync(target, next);
  }
}

console.log(`synced SDK version fallback -> ${version}`);
