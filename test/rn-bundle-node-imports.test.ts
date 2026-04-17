/**
 * Release gate: assert that companion entry point dist bundles do not
 * transitively pull in any `node:*` imports or `Bun.*` API calls.
 *
 * Metro and similar RN bundlers cannot handle `node:` protocol imports and
 * will hard-fail during release bundling. `Bun.*` API calls indicate the
 * agentic (Bun-only) surface has leaked into a companion bundle — this is a
 * hard architectural violation and must block release.
 *
 * This test catches regressions before they reach CI.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = resolve(__dirname, '../packages/sdk/dist');

/**
 * Companion entry points that must be free of `node:*` imports and `Bun.*`
 * calls in the built output. These are the files Metro / Expo's bundler and
 * browser bundlers will trace from.
 */
const COMPANION_ENTRIES = [
  'react-native.js',
  'expo.js',
  'browser.js',
  'web.js',
  // The /auth subpath is also consumed by RN/browser consumers for token helpers.
  'auth.js',
];

/**
 * Patterns that must NOT appear in companion dist files.
 * - node: imports fail Metro bundling hard.
 * - Bun.* calls indicate a Bun-only API leaked into the companion surface.
 */
const DISALLOWED: { pattern: RegExp; label: string }[] = [
  { pattern: /from ['"]node:/, label: 'node: import' },
  { pattern: /require\(['"]node:/, label: 'node: require' },
  { pattern: /\bBun\.\w+/, label: 'Bun.* API call (Bun-only surface leak)' },
];

describe('Companion bundle guard: no node: imports or Bun.* calls', () => {
  for (const entry of COMPANION_ENTRIES) {
    for (const { pattern, label } of DISALLOWED) {
      test(`dist/${entry} contains no ${label}`, () => {
        const filePath = resolve(SDK_DIST, entry);
        const fileExists = existsSync(filePath);
        expect(fileExists).toBe(true); // Fail loudly if dist not built
        if (!fileExists) return;
        let content: string;
        try {
          content = readFileSync(filePath, 'utf8');
        } catch {
          return;
        }
        const match = content.match(pattern);
        expect(
          match,
          `${entry} contains a disallowed ${label}: ${match?.[0] ?? ''}`,
        ).toBeNull();
      });
    }
  }
});
