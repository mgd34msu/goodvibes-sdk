const DEFAULT_MAX_PATTERN_CHARS = 512;
const DEFAULT_MAX_INPUT_CHARS = 50_000;
const ALLOWED_FLAGS = /^[dgimsuvy]*$/;

const RISKY_PATTERN_CHECKS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /(^|[^\\])\\[1-9]/, reason: 'backreferences are not allowed in operator-supplied regular expressions' },
  { pattern: /\((?:[^()\\]|\\.)*[+*{][^)]*\)\s*[+*{]/, reason: 'nested quantified groups are not allowed' },
  { pattern: /\.\*(?:[^|)]{0,64})\.\*/, reason: 'multiple wildcard repeats in one expression are not allowed' },
];

export interface SafeRegExpOptions {
  readonly operation: string;
  readonly maxPatternChars?: number;
  readonly maxInputChars?: number;
}

export function compileSafeRegExp(source: string, flags: string, options: SafeRegExpOptions): RegExp {
  const maxPatternChars = options.maxPatternChars ?? DEFAULT_MAX_PATTERN_CHARS;
  if (source.length > maxPatternChars) {
    throw new Error(`${options.operation} regex exceeds ${maxPatternChars} characters`);
  }
  if (!ALLOWED_FLAGS.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error(`${options.operation} regex flags are invalid`);
  }
  for (const check of RISKY_PATTERN_CHECKS) {
    if (check.pattern.test(source)) {
      throw new Error(`${options.operation} regex rejected: ${check.reason}`);
    }
  }
  return new RegExp(source, flags);
}

export function assertSafeRegexInput(input: string, options: SafeRegExpOptions): void {
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  if (input.length > maxInputChars) {
    throw new Error(`${options.operation} regex input exceeds ${maxInputChars} characters`);
  }
}

export function safeRegExpTest(regex: RegExp, input: string, options: SafeRegExpOptions): boolean {
  assertSafeRegexInput(input, options);
  regex.lastIndex = 0;
  return regex.test(input);
}

export function safeRegExpExec(regex: RegExp, input: string, options: SafeRegExpOptions): RegExpExecArray | null {
  assertSafeRegexInput(input, options);
  return regex.exec(input);
}
