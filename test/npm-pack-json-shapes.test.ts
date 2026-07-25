/**
 * `npm pack --json` has emitted more than one document shape across npm majors,
 * and the release pack gate reads a `filename` out of it. Reading `[0]` off the
 * npm 12 object form yields undefined and fails later with an opaque
 * `result.filename` error, so every shape is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { parseNpmPackJson, selectPackResult } from '../scripts/release-shared.ts';

const NPM_10_ARRAY = JSON.stringify([
  { id: '@pellux/goodvibes-errors@1.14.0', name: '@pellux/goodvibes-errors', filename: 'pellux-goodvibes-errors-1.14.0.tgz' },
]);

const NPM_12_NAME_KEYED = JSON.stringify({
  '@pellux/goodvibes-errors': {
    id: '@pellux/goodvibes-errors@1.14.0',
    name: '@pellux/goodvibes-errors',
    filename: 'pellux-goodvibes-errors-1.14.0.tgz',
  },
});

const BARE_OBJECT = JSON.stringify({
  name: '@pellux/goodvibes-errors',
  filename: 'pellux-goodvibes-errors-1.14.0.tgz',
});

describe('npm pack --json shapes', () => {
  test('the npm 10/11 array form yields the tarball filename', () => {
    expect(parseNpmPackJson(NPM_10_ARRAY).filename).toBe('pellux-goodvibes-errors-1.14.0.tgz');
  });

  test('the npm 12 name-keyed object form yields the tarball filename', () => {
    expect(parseNpmPackJson(NPM_12_NAME_KEYED).filename).toBe('pellux-goodvibes-errors-1.14.0.tgz');
  });

  test('a bare single-result object yields the tarball filename', () => {
    expect(parseNpmPackJson(BARE_OBJECT).filename).toBe('pellux-goodvibes-errors-1.14.0.tgz');
  });

  test('leading npm notice chatter on stdout is ignored', () => {
    const noisy = `npm notice run a wrapper script\nnpm notice using npm@12.0.1\n${NPM_12_NAME_KEYED}\n`;
    expect(parseNpmPackJson(noisy).filename).toBe('pellux-goodvibes-errors-1.14.0.tgz');
  });

  test('braces inside string values do not truncate the document', () => {
    const withBraces = JSON.stringify({
      '@pellux/goodvibes-errors': {
        name: '@pellux/goodvibes-errors',
        integrity: 'sha512-{not-a-brace}',
        filename: 'pellux-goodvibes-errors-1.14.0.tgz',
      },
    });
    expect(parseNpmPackJson(withBraces).filename).toBe('pellux-goodvibes-errors-1.14.0.tgz');
  });

  test('output carrying no JSON document is reported, not silently undefined', () => {
    expect(() => parseNpmPackJson('npm ERR! something went wrong')).toThrow(/printed no JSON document/);
  });

  test('a JSON document with no recognizable pack result is reported', () => {
    expect(() => parseNpmPackJson(JSON.stringify({ unrelated: { size: 1 } }))).toThrow(/unrecognized JSON shape/);
  });

  test('selectPackResult reports undefined rather than throwing on an unknown shape', () => {
    expect(selectPackResult(42)).toBeUndefined();
    expect(selectPackResult(null)).toBeUndefined();
    expect(selectPackResult([])).toBeUndefined();
  });
});
