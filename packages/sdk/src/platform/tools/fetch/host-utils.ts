/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared host utility functions for fetch tool modules.
 *
 * Extracted to avoid duplication across trust-tiers.ts and any future
 * network-scope modules.
 */

/**
 * Glob-simple host pattern match (supports `*` and `**`).
 * `*` matches one non-dot segment; `**` matches across dots.
 *
 * @param host    - Hostname string to test.
 * @param pattern - Glob pattern (e.g. `*.example.com`, `**`).
 * @returns       True when the host matches the pattern.
 */
import { globBodyToRegexSource } from '../../utils/glob-to-regex.js';

const _globRegexCache = new Map<string, RegExp>();

function getGlobRegex(pattern: string): RegExp {
  let re = _globRegexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${globBodyToRegexSource(pattern, '[^.]*', '.*')}$`, 'i');
    if (_globRegexCache.size > 100) _globRegexCache.clear(); // simple eviction
    _globRegexCache.set(pattern, re);
  }
  return re;
}

export function hostMatchesGlob(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return getGlobRegex(pattern).test(host);
}
