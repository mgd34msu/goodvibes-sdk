import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let version = '0.33.10';
try {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8'));
  version = pkg.version ?? version;
} catch {
  // Keep the baked value when package.json is not available.
}

export const VERSION = version;
