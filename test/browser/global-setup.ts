import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function setup(): void {
  const browserBundle = resolve(__dirname, '../../packages/sdk/dist/browser.js');
  if (!existsSync(browserBundle)) {
    throw new Error('Browser test bundle is missing. Run `bun run build` before `vitest --config vitest.browser.config.ts`.');
  }
}
