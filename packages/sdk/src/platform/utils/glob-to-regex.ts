/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared glob-to-regex conversion utility.
 * Handles **, *, and ? wildcards correctly for file path matching.
 */
export function buildGlobMatcher(glob: string): (path: string) => boolean {
  const regex = globToRegex(glob);
  return (path: string) => regex.test(path.replace(/\\/g, '/'));
}

const GLOB_REGEX_SPECIALS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/**
 * Convert a glob body to a regex-source body in a SINGLE forward pass.
 *
 * Escapes regex metacharacters and maps `**`, `*`, and `?` to the caller's
 * chosen sub-expressions. Deliberately avoids the older approach of round-
 * tripping through a placeholder sentinel with `String.replace(/…/g, …)`: a
 * `g`-flagged regex literal reused across many calls can, on some engines,
 * carry `lastIndex` state into a subsequent `replace` and skip the
 * placeholder-restore step — leaving a literal sentinel in the pattern so the
 * `**` case silently stops matching. A character scan holds no state and
 * cannot mis-fire that way.
 *
 * @param glob      - Glob body (already stripped of any anchors the caller adds).
 * @param star      - Regex source that a single `*` maps to.
 * @param globstar  - Regex source that a `**` maps to.
 * @param question  - Regex source that a `?` maps to; when omitted, `?` is
 *                    treated as a literal character (escaped if needed).
 */
export function globBodyToRegexSource(
  glob: string,
  star: string,
  globstar: string,
  question?: string,
): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += globstar;
        i += 1;
      } else {
        out += star;
      }
    } else if (ch === '?' && question !== undefined) {
      out += question;
    } else if (GLOB_REGEX_SPECIALS.has(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

export function globToRegex(glob: string): RegExp {
  // Single forward pass: escape metacharacters and expand wildcards together,
  // treating `**/` as an optional path prefix. `**` alone crosses separators
  // (`.+`), a lone `*` stays within a path segment (`[^/]*`), and `?` matches a
  // single non-separator character.
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.+/)?';
          i += 2;
        } else {
          out += '.+';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (GLOB_REGEX_SPECIALS.has(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`(^|/)${out}$`);
}
