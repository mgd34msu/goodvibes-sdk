/**
 * Per-segment verdict evaluation for Shell AST normalization.
 *
 * Evaluates policy per AST segment, aggregates a final compound verdict,
 * and produces structured denial output with per-segment reasons.
 *
 * Each segment verdict is a runtime contract: callers can inspect which
 * segments were safe vs. unsafe and surface that information to the user.
 *
 * @module normalization/verdict
 */

import type { CommandClassification } from './types.js';
import type { ShellNode, CommandNode } from './ast.js';
import { collectCommandNodes, describeNode } from './ast.js';
import { classifySegment, catastrophicReason } from './classifier.js';
import type { CommandSegment } from './types.js';

/**
 * Conservative set of classifications for callers that gate by class
 * WITHOUT a permission layer in front of them (e.g. policy tooling,
 * standalone analysis). Destructive and escalation are excluded.
 *
 * The exec tool does NOT use this set: by the time a command executes, the
 * permission layer (user settings, prompts, session approvals) has already
 * approved the call, so the exec layer passes ALL_COMMAND_CLASSES and keeps
 * only the unconditional catastrophic block.
 */
export const DEFAULT_ALLOWED_CLASSES: ReadonlySet<CommandClassification> = new Set([
  'read',
  'write',
  'network',
]);

/**
 * Every command classification. Passed by callers whose class-level risk
 * decisions are owned by the permission layer (allow/prompt/deny settings),
 * leaving only catastrophic and obfuscation checks at this layer.
 */
export const ALL_COMMAND_CLASSES: ReadonlySet<CommandClassification> = new Set([
  'read',
  'write',
  'network',
  'destructive',
  'escalation',
]);

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * The policy verdict for a single command segment.
 *
 * Each verdict is an immutable runtime contract that records why a segment
 * was allowed or denied, making the decision auditable and explainable.
 */
export interface SegmentVerdict {
  /** The raw command string for this segment. */
  raw: string;
  /** Canonical command name. */
  command: string;
  /** Semantic risk classification. */
  classification: CommandClassification;
  /** Whether this segment was allowed by policy. */
  allowed: boolean;
  /**
   * Human-readable reason for the verdict.
   * Always set; describes the policy that matched or the safe classification.
   */
  reason: string;
  /** Whether this segment contains obfuscated content (encoded chars, substitution). */
  hasObfuscation: boolean;
  /** Descriptions of any obfuscation patterns found. */
  obfuscationPatterns: string[];
}

/**
 * The aggregated verdict for a compound command.
 *
 * Contains the overall allow/deny decision plus per-segment records for
 * user-facing denial output and audit logging.
 */
export interface CompoundVerdict {
  /** The original command string. */
  original: string;
  /** Whether the entire compound command is allowed. */
  allowed: boolean;
  /** The highest-risk classification across all segments. */
  highestClassification: CommandClassification;
  /** Per-segment verdict records (in parse order). */
  segments: SegmentVerdict[];
  /**
   * Human-readable denial explanation including per-segment reasons.
   * Only set when `allowed` is false.
   */
  denialExplanation?: string | undefined;
  /** Whether any segment contains obfuscated content. */
  hasObfuscation: boolean;
}

// ── Obfuscation detection ──────────────────────────────────────────────────────

/**
 * Patterns that indicate potential obfuscation or bypass attempts.
 * Each entry provides a description and a predicate.
 */
/**
 * A `%` followed by two hex-ish characters is grammatically identical in a
 * printf/strftime specifier (`%4d`, `%02d`, `%2f`, `date +%ad`) and in a URL
 * escape (`%2F`, `%20`). Testing every argument against `/%[0-9a-fA-F]{2}/`
 * therefore reported ordinary formatting commands as obfuscation. Percent
 * encoding now only counts when the argument carries it the way a URI does —
 * an explicit `scheme://`, or an encoded path separator (`%2F`, `%5C`), which
 * is the evasion this check exists to catch — and the printf family, which
 * legitimately emits `%2f` (float, width 2), is exempt.
 *
 * This narrows an existing detector; it adds no new denial class. An encoded
 * NUL keeps its own dedicated 'null-byte injection attempt' check below.
 */
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
const URI_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** Encoded `/` and `\` — separators that change path meaning once decoded. */
const ENCODED_PATH_SEPARATOR = /%(?:2[fF]|5[cC])/;
const FORMAT_SPECIFIER_COMMANDS = new Set(['printf', 'awk', 'gawk', 'mawk', 'nawk', 'seq']);

function isPercentEncoded(arg: string, command: string): boolean {
  if (FORMAT_SPECIFIER_COMMANDS.has(command.toLowerCase())) return false;
  if (!PERCENT_ESCAPE.test(arg)) return false;
  return URI_SCHEME.test(arg) || ENCODED_PATH_SEPARATOR.test(arg);
}

// ── NUL: handling null-delimited data vs injecting a NUL into command text ────

/**
 * Tools with a documented NUL-delimited data mode. Feeding them `\0` is how
 * null-separated records are read and written on Unix — `tr '\0' '\n'` over
 * /proc/<pid>/environ, `tr -d '\0'`, `xargs -0`, `sort -z`, `grep -z`,
 * `find -print0`. The check below used to match the two-character text `\0`
 * anywhere in the command, so all of those read as an injection attempt and
 * ordinary diagnostics were refused mid-debugging.
 */
const NULL_DELIMITED_TOOLS = new Set([
  'tr', 'xargs', 'sort', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'find', 'fd',
  'perl', 'awk', 'gawk', 'mawk', 'nawk', 'cut', 'uniq', 'comm', 'shuf', 'du',
  'parallel', 'env', 'printenv', 'jq', 'xxd',
]);

/** Strips one layer of surrounding shell quotes from a token. */
function unquote(arg: string): string {
  const m = /^(['"])(.*)\1$/s.exec(arg);
  return m?.[2] ?? arg;
}

/**
 * Any textual spelling of a NUL escape: `\0`, `\00`, `\000`, `\x0`, `\x00`.
 *
 * Each form refuses to match when the escape actually continues into a
 * different character — `\012` is a newline, not a NUL followed by `12` — but
 * the octal form only excludes further OCTAL digits, so `\0evil` is still
 * recognised as a NUL escape carrying a payload.
 */
const NUL_ESCAPE_TEXT = /\\(?:0{1,3}(?![0-7])|[xX]0{1,2}(?![0-9a-fA-F]))/;

/** An argument that is nothing but NUL escapes — a delimiter, not a payload. */
function isNulDelimiterArg(arg: string): boolean {
  return /^(?:\\(?:0{1,3}|[xX]0{1,2}))+$/.test(unquote(arg));
}

/**
 * Distinguishes NUL HANDLING from NUL INJECTION.
 *
 * Denied unconditionally: an actual NUL byte in the command text, and `%00`
 * (an encoded NUL, which is the path-truncation trick this check exists for).
 * Neither can appear benignly — `execve` cannot even carry an embedded NUL.
 *
 * The textual escape `\0` is different: the shell does not turn it into a NUL
 * byte, it is just two characters handed to a program that understands them. It
 * is treated as obfuscation only when the receiving command has no
 * null-delimited mode, and even for a null-aware tool only when every NUL-
 * bearing argument is a bare delimiter — `tr 'x' 'y\0evil'` smuggles the escape
 * into a larger payload and stays denied.
 */
function nullByteObfuscation(raw: string, args: string[], command: string): boolean {
  if (raw.includes('\u0000')) return true;
  if (raw.includes('%00')) return true;
  if (!NUL_ESCAPE_TEXT.test(raw)) return false;
  if (!NULL_DELIMITED_TOOLS.has(command.toLowerCase())) return true;
  return !args.every((a) => !NUL_ESCAPE_TEXT.test(a) || isNulDelimiterArg(a));
}

// ── Command substitution: reading a value vs assembling a command ─────────────

/**
 * Commands that run whatever command follows them. `sudo $(cat payload)` puts
 * the substitution in command-name position even though the first word is not
 * the substitution itself, so these are skipped when locating that position.
 */
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'timeout', 'nice', 'ionice', 'nohup', 'setsid', 'stdbuf',
  'command', 'exec', 'time', 'watch', 'flock', 'script', 'chrt', 'taskset', 'env',
]);

/**
 * Commands that interpret an ARGUMENT as command text. A substitution in their
 * arguments is command assembly no matter how innocent the inner command looks:
 * `sh -c "$(curl …)"` runs whatever came back.
 */
const ARGUMENT_INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox',
  'eval', 'source', '.', 'xargs', 'parallel', 'ssh', 'su',
]);

/**
 * Inner-substitution content that produces bytes rather than reading a value —
 * the decode-then-run shape. `$(echo cm0gLXJm | base64 -d)` is not a value.
 */
const SUBSTITUTION_DECODERS =
  /\b(?:base64|base32|b64decode|xxd|uudecode|openssl\s+(?:enc|base64)|gunzip|zcat|bunzip2|uncompress|iconv|eval)\b|\bgzip\s+-d|\bxz\s+-d/;

/** One command substitution found in the raw text. */
interface Substitution {
  /** Text between the delimiters. */
  readonly inner: string;
  /** Offset of the opening delimiter in the raw string. */
  readonly start: number;
}

/**
 * Extract `$( … )` and backtick substitutions from raw command text, matching
 * parentheses by depth so a nested substitution is not cut short.
 *
 * The tokenizer cannot be used for this: it splits on whitespace inside a
 * substitution, so `$(cat payload)` arrives as the two tokens `$(cat` and
 * `payload)` with the boundaries lost.
 */
function extractSubstitutions(raw: string): Substitution[] {
  const found: Substitution[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') { i++; continue; }
    if (raw[i] === '$' && raw[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < raw.length && depth > 0; j++) {
        if (raw[j] === '\\') { j++; continue; }
        if (raw[j] === '(') depth++;
        else if (raw[j] === ')') depth--;
      }
      found.push({ inner: raw.slice(i + 2, depth === 0 ? j - 1 : raw.length), start: i });
      i = j - 1;
    } else if (raw[i] === '`') {
      const end = raw.indexOf('`', i + 1);
      found.push({ inner: raw.slice(i + 1, end < 0 ? raw.length : end), start: i });
      i = end < 0 ? raw.length : end;
    }
  }
  return found;
}

/**
 * Whether a substitution supplies the command NAME — the shape where the thing
 * being run is itself assembled at runtime. Leading wrapper words, their flags
 * and a numeric wrapper argument (`timeout 300 …`) are skipped first, so
 * `sudo $(cat payload)` is caught while `timeout 300 git log $(cat ref)` is not.
 */
function substitutionInCommandNamePosition(raw: string, subs: Substitution[]): boolean {
  const starts = new Set(subs.map((s) => s.start));
  const word = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(raw)) !== null) {
    // A quoted substitution (`"$(cat payload)" --now`) starts one or more
    // characters into the word, so skip the opening quotes before comparing.
    const quotes = /^['"]*/.exec(m[0])?.[0].length ?? 0;
    if (starts.has(m.index + quotes)) return true;
    const text = m[0].slice(quotes);
    if (text.startsWith('-') || /^\d+[a-z]?$/i.test(text)) continue;
    if (COMMAND_WRAPPERS.has(text.replace(/^.*\//, '').toLowerCase())) continue;
    return false;
  }
  return false;
}

/**
 * Distinguishes a substitution that READS A VALUE from one that ASSEMBLES A
 * COMMAND.
 *
 * `curl -H "Bearer $(cat token)"` is everyday shell: the substitution sits in
 * an argument, the inner command is a plain reader, and the result is a header
 * value. The previous check matched any `$(…)` or backtick anywhere in the
 * command, so that — and every other read-a-file-into-an-argument idiom — was
 * refused as obfuscation.
 *
 * Still obfuscation, and still denied:
 *  - the substitution occupies the command-name position (`sudo $(cat payload)`);
 *  - the inner text decodes or evaluates rather than reading
 *    (`$(echo … | base64 -d)`), or nests a further substitution;
 *  - the receiving command interprets its arguments as command text
 *    (`sh -c "$(curl …)"`, `eval`, `xargs`).
 */
function commandSubstitutionObfuscation(
  raw: string,
  command: string,
  firstTokenIsSubshell: boolean,
): boolean {
  // Structural signal, checked before any text scanning: when the node's FIRST
  // token is a subshell there is no command name to resolve — the name is
  // whatever the substitution prints. Such a node carries `command: ''`, so
  // relying on the name alone would classify it as nothing at all. This does
  // not depend on the raw text parsing back the way we expect.
  if (firstTokenIsSubshell) return true;
  const subs = extractSubstitutions(raw);
  if (subs.length === 0) return false;
  if (substitutionInCommandNamePosition(raw, subs)) return true;
  for (const s of subs) {
    if (SUBSTITUTION_DECODERS.test(s.inner)) return true;
    if (s.inner.includes('$(') || s.inner.includes('`')) return true;
  }
  return ARGUMENT_INTERPRETERS.has(command.replace(/^.*\//, '').toLowerCase());
}

const OBFUSCATION_CHECKS: Array<{
  description: string;
  test: (
    raw: string,
    args: string[],
    flags: string[],
    command: string,
    node: CommandNode,
  ) => boolean;
}> = [
  {
    /**
     * NOTE: This check has a known false-positive risk on legitimate base64-like arguments
     * (e.g. UUIDs, hashes, or long alphanumeric tokens). It requires both the base64
     * character-set pattern AND 4-byte alignment, which reduces but does not eliminate
     * false positives. Callers should surface the pattern description to the user so
     * they can identify and allowlist benign cases.
     */
    description: 'base64-encoded argument (possible command injection)',
    test: (_raw, args) =>
      args.some((a) => /^[A-Za-z0-9+/]{16,}={0,2}$/.test(a) && a.length % 4 === 0),
  },
  {
    description: 'hex-encoded argument (possible command injection)',
    test: (_raw, args) => args.some((a) => /^(0x)?[0-9a-fA-F]{8,}$/.test(a)),
  },
  {
    description: 'URL-encoded content in argument',
    test: (_raw, args, _flags, command) => args.some((a) => isPercentEncoded(a, command)),
  },
  {
    description: 'variable expansion in critical position',
    test: (raw) => /\$\{?[A-Z_]+\}?/.test(raw) && /rm|kill|dd|mkfs/.test(raw),
  },
  {
    description: 'command substitution assembling a command (backtick or $())',
    test: (raw, _args, _flags, command, node) =>
      commandSubstitutionObfuscation(raw, command, node.tokens[0]?.type === 'subshell'),
  },
  {
    description: 'octal or unicode escape in path argument',
    // A bare NUL escape handed to a null-delimited tool is that tool's
    // delimiter argument, not an encoded path — `tr '\000' '\n'` is the same
    // ordinary command as `tr '\0' '\n'` and is exempted the same way. Every
    // other octal/hex/unicode escape still counts.
    test: (_raw, args, _flags, command) =>
      args.some(
        (a) =>
          (/\\[0-7]{3}/.test(a) ||
            /\\u[0-9a-fA-F]{4}/.test(a) ||
            /\\x[0-9a-fA-F]{2}/.test(a)) &&
          !(NULL_DELIMITED_TOOLS.has(command.toLowerCase()) && isNulDelimiterArg(a)),
      ),
  },
  {
    description: 'null-byte injection attempt',
    test: (raw, args, _flags, command) => nullByteObfuscation(raw, args, command),
  },
  {
    description: 'eval command detected',
    test: (raw, args) => raw.trim().startsWith('eval') || args.includes('eval'),
  },
];

/**
 * Checks a command node for obfuscation patterns.
 *
 * @param node - The command node to check.
 * @returns List of obfuscation pattern descriptions found.
 */
function detectObfuscation(node: CommandNode): string[] {
  const found: string[] = [];
  for (const check of OBFUSCATION_CHECKS) {
    if (check.test(node.raw, node.args, node.flags, node.command, node)) {
      found.push(check.description);
    }
  }
  return found;
}

// ── Policy evaluation ─────────────────────────────────────────────────────────

/**
 * Classification priority order (highest index = lowest risk).
 * Used for comparing segment classifications.
 */
const CLASSIFICATION_PRIORITY: CommandClassification[] = [
  'destructive',
  'escalation',
  'network',
  'write',
  'read',
];

function classificationRank(c: CommandClassification): number {
  const idx = CLASSIFICATION_PRIORITY.indexOf(c);
  return idx === -1 ? 999 : idx;
}

function higherPriorityClassification(
  a: CommandClassification,
  b: CommandClassification,
): CommandClassification {
  return classificationRank(a) <= classificationRank(b) ? a : b;
}

/**
 * Policy predicate type: returns a denial reason string if the segment
 * should be denied, or null if the policy does not deny it.
 */
type PolicyPredicate = (node: CommandNode, classification: CommandClassification) => string | null;

/**
 * Default policies applied to each segment.
 *
 * Extend this list to add project-specific per-segment rules.
 * First match wins (denial takes precedence).
 */
const DEFAULT_POLICIES: PolicyPredicate[] = [
  // Catastrophic commands (root deletion, raw disk destruction, fork bombs)
  // are blocked unconditionally. Everything else — including destructive- and
  // escalation-CLASS commands like kill/rm/docker/sudo — is gated by the
  // allowedClasses check below, so the caller (ultimately the user's
  // permission settings) decides.
  (node, _cls) => {
    const reason = catastrophicReason({
      raw: node.raw,
      tokens: node.tokens,
      command: node.command,
      args: node.args,
      flags: node.flags,
    });
    return reason === null ? null : `unconditionally blocked destructive command — ${reason}`;
  },
];

/**
 * Evaluates a single CommandNode against the default policy.
 *
 * @param node           - The command node to evaluate.
 * @param allowedClasses - Classification tiers to allow (defaults to read+write+network).
 * @returns A SegmentVerdict for this node.
 */
export function evaluateSegmentNode(
  node: CommandNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): SegmentVerdict {
  // Build a minimal CommandSegment for the classifier
  const seg: CommandSegment = {
    raw: node.raw,
    tokens: node.tokens,
    command: node.command,
    args: node.args,
    flags: node.flags,
  };

  const classification = classifySegment(seg);
  const obfuscationPatterns = detectObfuscation(node);
  const hasObfuscation = obfuscationPatterns.length > 0;

  // Obfuscation always triggers denial
  if (hasObfuscation) {
    return {
      raw: node.raw,
      command: node.command,
      classification,
      allowed: false,
      reason: `obfuscation detected: ${obfuscationPatterns.join('; ')}`,
      hasObfuscation,
      obfuscationPatterns,
    };
  }

  // Check default policies
  for (const policy of DEFAULT_POLICIES) {
    const denial = policy(node, classification);
    if (denial !== null) {
      return {
        raw: node.raw,
        command: node.command,
        classification,
        allowed: false,
        reason: denial,
        hasObfuscation,
        obfuscationPatterns,
      };
    }
  }

  // Check against caller-provided allowed classes
  if (!allowedClasses.has(classification)) {
    return {
      raw: node.raw,
      command: node.command,
      classification,
      allowed: false,
      reason: `classification "${classification}" is not in the allowed set [${[...allowedClasses].join(', ')}]`,
      hasObfuscation,
      obfuscationPatterns,
    };
  }

  return {
    raw: node.raw,
    command: node.command,
    classification,
    allowed: true,
    reason: `classification "${classification}" is permitted`,
    hasObfuscation,
    obfuscationPatterns,
  };
}

/**
 * Builds a structured denial explanation from a list of segment verdicts.
 *
 * Includes the full per-segment breakdown for user-facing output.
 *
 * @param original - The original command string.
 * @param verdicts - All segment verdicts.
 * @returns A multi-line denial explanation string.
 */
/** Longest echoed command kept in a denial header before it is elided. */
const MAX_ECHOED_COMMAND_LENGTH = 500;

/**
 * Collapses whitespace runs so an echoed command occupies exactly one line.
 *
 * The header used to interpolate `original` verbatim. A multi-line command — a
 * heredoc above all — therefore put its own newline inside what reads as line
 * one, so every consumer that summarizes a denial by its first line (for
 * example exec's `minimal` verbosity, which does `stderr.split('\n')[0]`)
 * showed `Command denied: "… <<'EOF'` and silently dropped the segment
 * breakdown, classification and reason. Collapsing here keeps the first line a
 * real first line, so a denial always names what was denied and why.
 */
export function asSingleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ECHOED_COMMAND_LENGTH
    ? `${collapsed.slice(0, MAX_ECHOED_COMMAND_LENGTH)}…`
    : collapsed;
}
export function buildDenialExplanation(original: string, verdicts: SegmentVerdict[]): string {
  const denied = verdicts.filter((v) => !v.allowed);
  const lines: string[] = [
    `Command denied: "${asSingleLine(original)}"`,
    ``,
    `Segment analysis (${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''}):`,
  ];

  for (const [i, v] of verdicts.entries()) {
    const status = v.allowed ? '✓ allowed' : '✗ denied';
    lines.push(`  [${i + 1}] ${status}  ${asSingleLine(v.raw)}`);
    lines.push(`       classification: ${v.classification}`);
    lines.push(`       reason: ${v.reason}`);
    if (v.hasObfuscation) {
      lines.push(`       obfuscation: ${v.obfuscationPatterns.join('; ')}`);
    }
  }

  lines.push(``);
  lines.push(`${denied.length} of ${verdicts.length} segment${verdicts.length !== 1 ? 's' : ''} denied.`);

  return lines.join('\n');
}

/**
 * Evaluates a ShellNode AST against policy and returns a CompoundVerdict.
 *
 * Safe segments are identified alongside unsafe ones. The compound command
 * is denied if ANY segment is denied.
 *
 * @param original       - The original command string.
 * @param ast            - The parsed ShellNode AST.
 * @param allowedClasses - Classification tiers to allow per segment.
 * @returns A CompoundVerdict with per-segment breakdown.
 */
export function evaluateCommandAST(
  original: string,
  ast: ShellNode,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): CompoundVerdict {
  const commandNodes = collectCommandNodes(ast);

  // If AST has no command nodes (e.g. empty or pure subshell with no inner)
  if (commandNodes.length === 0) {
    // Conservative: deny empty/unparseable compound commands
    const verdict: CompoundVerdict = {
      original,
      allowed: false,
      highestClassification: 'write',
      segments: [],
      denialExplanation: `Command denied: "${asSingleLine(original)}"\n\nNo parseable command segments found. Denied as a precaution.`,
      hasObfuscation: false,
    };
    return verdict;
  }

  const segmentVerdicts: SegmentVerdict[] = commandNodes.map((node) =>
    evaluateSegmentNode(node, allowedClasses),
  );

  let highest: CommandClassification = 'read';
  for (const sv of segmentVerdicts) {
    highest = higherPriorityClassification(highest, sv.classification);
  }

  const anyDenied = segmentVerdicts.some((v) => !v.allowed);
  const hasObfuscation = segmentVerdicts.some((v) => v.hasObfuscation);

  const compound: CompoundVerdict = {
    original,
    allowed: !anyDenied,
    highestClassification: highest,
    segments: segmentVerdicts,
    hasObfuscation,
  };

  if (anyDenied) {
    compound.denialExplanation = buildDenialExplanation(original, segmentVerdicts);
  }

  return compound;
}
