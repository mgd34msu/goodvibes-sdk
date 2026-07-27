/**
 * Tokenizer — converts a raw shell command string into an ordered list
 * of CommandToken objects.
 *
 * Handles:
 *  - Single- and double-quoted strings (preserves inner whitespace)
 *  - Shell operators: &&, ||, ;, |, >, >>, <, 2>
 *  - Variable expansions: $VAR, ${VAR}
 *  - Subshell expressions: $(...) and `...`
 *  - Flags (tokens starting with -)
 *  - Path-like tokens (contain / or ~)
 *
 * Safety contracts:
 *  - Inputs exceeding MAX_INPUT_LENGTH are truncated before processing
 *  - Tokenization halts once MAX_TOKEN_COUNT tokens are produced
 *  - Both guards ensure bounded runtime regardless of pathological input
 */

import type { CommandToken } from './types.js';

/**
 * Maximum number of characters accepted from a raw command string.
 * Inputs longer than this are hard-truncated before tokenization begins.
 * Emergency truncation ensures the tokenizer can never hang
 * on extremely long inputs even if other guards are bypassed.
 */
export const MAX_INPUT_LENGTH = 65_536;

/**
 * Maximum number of tokens the tokenizer will produce from a single input.
 * Once this limit is reached tokenization halts and the partial token list
 * is returned. Prevents pathological inputs with O(N) whitespace-separated
 * tokens from consuming unbounded memory or time.
 */
export const MAX_TOKEN_COUNT = 1_024;

/** Shell operator strings recognized by the tokenizer. */
const OPERATOR_TOKENS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '2>', '<<', '<<-', '<<~']);

/** Characters that terminate an unquoted heredoc delimiter word. */
const HEREDOC_DELIMITER_END = /[\s;|&<>]/;

/**
 * Returns the offset just past a heredoc body — the character after the line
 * whose trimmed text equals `delimiter`, or the end of input if the heredoc is
 * never terminated.
 *
 * @param input     - Full command string.
 * @param from      - Offset just past the heredoc delimiter word.
 * @param delimiter - Terminator word, already unquoted.
 */
function skipHeredocBody(input: string, from: number, delimiter: string): number {
  const len = input.length;
  const bodyStart = input.indexOf('\n', from);
  if (bodyStart < 0) return len;

  let cursor = bodyStart + 1;
  while (cursor < len) {
    const lineEnd = input.indexOf('\n', cursor);
    const line = input.slice(cursor, lineEnd < 0 ? len : lineEnd);
    if (line.trim() === delimiter) {
      return lineEnd < 0 ? len : lineEnd + 1;
    }
    if (lineEnd < 0) return len;
    cursor = lineEnd + 1;
  }
  return len;
}

/** Shell redirect operator prefixes (single-char). */
const REDIRECT_CHARS = new Set(['>', '<']);

/**
 * Determines the semantic type for a raw token string.
 *
 * @param raw - The raw token value.
 * @param isFirst - True when this is the first non-operator token in its segment.
 * @returns The appropriate CommandToken type.
 */
function classifyTokenType(
  raw: string,
  isFirst: boolean,
): CommandToken['type'] {
  if (OPERATOR_TOKENS.has(raw)) {
    if (raw === '|' || raw === '&&' || raw === '||' || raw === ';') {
      return raw === '|' ? 'pipe' : 'operator';
    }
    return 'redirect';
  }
  if (raw.startsWith('$(') || raw.startsWith('`')) return 'subshell';
  if (raw.startsWith('-')) return 'flag';
  if (raw.includes('/') || raw.startsWith('~')) return 'path';
  if (isFirst) return 'command';
  return 'argument';
}

/**
 * Splits a command string into raw token strings, respecting quoting.
 *
 * @param input - The raw command string.
 * @returns Array of [rawValue, position] pairs.
 */
function splitRaw(input: string, maxTokens: number): Array<{ value: string; position: number }> {
  const results: Array<{ value: string; position: number }> = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    if (input[i] === ' ' || input[i] === '\t' || input[i] === '\n') {
      i++;
      continue;
    }

    const start = i;

    // Check for two-character operators first
    if (i + 1 < len) {
      const two = input.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>' || two === '2>') {
        results.push({ value: two, position: start });
        i += 2;
        if (results.length >= maxTokens) return results;
        continue;
      }
    }

    const ch = input[i]!;

    // Heredoc: `<<`/`<<-`/`<<~` DELIM, body lines, terminator line.
    //
    // The body is data handed to the receiving process, not shell source. Left
    // untokenized it was scanned as ordinary shell text, so `;`/`&&`/`|` inside
    // the body split it into fabricated command segments — a heredoc carrying
    // the characters `rm -rf` was reported as a denied destructive segment that
    // the shell would never execute. Consume the operator and delimiter as
    // tokens (the redirect stays visible) and skip the body.
    //
    // `<<<` is a here-string: it takes a single word, not a body, so it falls
    // through to the ordinary redirect handling below.
    if (ch === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
      let j = i + 2;
      let operator = '<<';
      if (input[j] === '-' || input[j] === '~') {
        operator += input[j]!;
        j += 1;
      }
      results.push({ value: operator, position: start });
      if (results.length >= maxTokens) return results;

      while (j < len && (input[j] === ' ' || input[j] === '\t')) j += 1;

      // Delimiter word, optionally quoted (`<<'EOF'` suppresses expansion).
      const delimiterStart = j;
      let delimiter = '';
      const quote = input[j];
      if (quote === '"' || quote === "'") {
        j += 1;
        while (j < len && input[j] !== quote) {
          delimiter += input[j];
          j += 1;
        }
        if (j < len) j += 1;
      } else {
        while (j < len && !HEREDOC_DELIMITER_END.test(input[j]!)) {
          delimiter += input[j];
          j += 1;
        }
      }
      if (delimiter.length > 0) {
        results.push({ value: input.slice(delimiterStart, j), position: delimiterStart });
        if (results.length >= maxTokens) return results;
      }

      i = delimiter.length > 0 ? skipHeredocBody(input, j, delimiter) : j;
      continue;
    }

    // Single-character operators
    if (ch === ';' || ch === '|' || ch === '<') {
      results.push({ value: ch, position: start });
      i++;
      if (results.length >= maxTokens) return results;
      continue;
    }
    if (ch === '>') {
      results.push({ value: '>', position: start });
      i++;
      if (results.length >= maxTokens) return results;
      continue;
    }

    // Backtick subshell
    if (ch === '`') {
      let j = i + 1;
      while (j < len && input[j] !== '`') j++;
      const raw = input.slice(i, j + 1);
      results.push({ value: raw, position: start });
      i = j + 1;
      if (results.length >= maxTokens) return results;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < len && input[j] !== quote) {
        if (input[j] === '\\' && quote === '"') j++; // skip escaped char
        j++;
      }
      const raw = input.slice(i, j + 1);
      results.push({ value: raw, position: start });
      i = j + 1;
      if (results.length >= maxTokens) return results;
      continue;
    }

    // Regular token — read until whitespace or operator
    let j = i;
    while (j < len) {
      const c = input[j]!;
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === ';' || c === '|' || c === '<' || c === '>') break;
      if ((input[j] === '&' || input[j] === '|') && j + 1 < len && (input.slice(j, j + 2) === '&&' || input.slice(j, j + 2) === '||')) break;
      // Backslash escape: consume the next character as a literal
      if (c === '\\' && j + 1 < len) { j += 2; continue; }
      j++;
    }
    results.push({ value: input.slice(i, j), position: start });
    i = j;
    if (results.length >= maxTokens) return results;
  }

  return results;
}

/**
 * Tokenizes a raw shell command string into an ordered array of CommandTokens.
 *
 * @param command - The raw shell command string to tokenize.
 * @returns Ordered array of CommandToken objects.
 */
export function tokenize(command: string): CommandToken[] {
  // Hard-truncate inputs that exceed the maximum length limit.
  // This emergency truncation bounds runtime independently of all
  // other logic — if the string is too long, we cut it before any parsing.
  const safe = command.length > MAX_INPUT_LENGTH ? command.slice(0, MAX_INPUT_LENGTH) : command;
  const raw = splitRaw(safe, MAX_TOKEN_COUNT);
  const tokens: CommandToken[] = [];
  let seenCommand = false;

  for (const { value, position } of raw) {
    const isOperator = OPERATOR_TOKENS.has(value);
    const isFirst = !seenCommand && !isOperator;

    const type = classifyTokenType(value, isFirst);

    // After an operator, the next non-operator token is a new command
    if (type === 'operator' || type === 'pipe') {
      seenCommand = false;
    } else if (type === 'command') {
      seenCommand = true;
    }

    tokens.push({ value, type, position });
  }

  return tokens;
}
