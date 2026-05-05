import { publicPackageDirs, run } from './release-shared.ts';

for (const dir of publicPackageDirs) {
  run('bunx', ['publint', dir], process.cwd());
}

console.log('publint check passed for all public packages');
