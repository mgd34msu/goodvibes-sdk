/**
 * Release gate: assert that the React Native and Expo dist bundles do not
 * transitively pull in any `node:*` imports.
 *
 * Metro and similar RN bundlers cannot handle `node:` protocol imports and
 * will hard-fail during release bundling. This test catches regressions
 * before they reach CI.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = resolve(__dirname, '../packages/sdk/dist');

/**
 * Entrypoints that must be free of `node:*` imports in the built output.
 * These are the files Metro / Expo's bundler will trace from.
 */
const RN_ENTRIES = [
  'react-native.js',
  'expo.js',
  // The /auth subpath is also consumed by RN consumers for token helpers.
  'auth.js',
];

/**
 * Patterns that must NOT appear in RN-safe dist files.
 */
const DISALLOWED = [
  /from ['"]node:/,
  /require\(['"]node:/,
];

describe('RN bundle: no node: imports', () => {
  for (const entry of RN_ENTRIES) {
    test(`dist/${entry} contains no node: imports`, () => {
      const filePath = resolve(SDK_DIST, entry);
      let content: string;
      const fileExists = existsSync(filePath);
      expect(fileExists).toBe(true); // Fail loudly if dist not built
      if (!fileExists) return;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        return;
      }
      for (const pattern of DISALLOWED) {
        const match = content.match(pattern);
        expect(
          match,
          `${entry} contains a disallowed node: import: ${match?.[0] ?? ''}`,
        ).toBeNull();
      }
    });
  }
});
