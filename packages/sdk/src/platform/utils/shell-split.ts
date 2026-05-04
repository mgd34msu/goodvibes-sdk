// ---------------------------------------------------------------------------
// shellSplit — POSIX-compatible word tokenizer
// ---------------------------------------------------------------------------
// Splits a shell command string into tokens, respecting:
//   - Double-quoted strings: preserve spaces, process \\ and \" escapes
//   - Single-quoted strings: preserve spaces, no escape processing
//   - Backslash escapes outside quotes
//   - Whitespace separation
//
// Does NOT support: subshell expansion, glob expansion, variable substitution.
// Intended for splitting trigger action strings into argv arrays for Bun.spawn.
// ---------------------------------------------------------------------------

/**
 * Split a shell command string into an argument array.
 * Handles double-quoted strings, single-quoted strings, and backslash escapes.
 *
 * @example
 * shellSplit('echo hello world')      // ['echo', 'hello', 'world']
 * shellSplit('echo "hello world"')    // ['echo', 'hello world']
 * shellSplit('path/with\\ space')     // ['path/with space']
 */
export function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip leading whitespace between tokens
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    // Accumulate one token
    let token = '';

    while (i < len && !/\s/.test(input[i]!)) {
      const ch = input[i]!;

      if (ch === '"') {
        // Double-quoted region: process \\ and \" escapes
        i++;
        while (i < len && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < len) {
            const next = input[i + 1];
            // Only process recognised escapes inside double quotes
            if (next === '"' || next === '\\') {
              token += next;
              i += 2;
            } else {
              token += input[i];
              i++;
            }
          } else {
            token += input[i];
            i++;
          }
        }
        i++; // consume closing "
      } else if (ch === "'") {
        // Single-quoted region: no escape processing
        i++;
        while (i < len && input[i] !== "'") {
          token += input[i];
          i++;
        }
        i++; // consume closing '
      } else if (ch === '\\' && i + 1 < len) {
        // Backslash escape outside quotes
        token += input[i + 1];
        i += 2;
      } else {
        token += ch;
        i++;
      }
    }

    if (token.length > 0) {
      tokens.push(token);
    }
  }

  return tokens;
}
