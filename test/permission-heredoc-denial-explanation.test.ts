/**
 * A denial always names what was denied and why — heredocs included.
 *
 * Two defects met here. The denial header interpolated the raw command, so a
 * multi-line command put its own newline inside what reads as line one and
 * every first-line-only consumer showed `Command denied: "… <<'NODE'` with no
 * segment breakdown, classification or reason. Separately, the tokenizer had
 * no heredoc concept: `<<'NODE'` lexed as two bare `<` redirects and the body
 * was scanned as shell source, so text inside it fabricated command segments
 * the shell would never execute.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseCommandAST,
  collectCommandNodes,
  evaluateCommandAST,
  tokenize,
  buildDenialExplanation,
} from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';
import type { CommandClassification } from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

const ALLOW_SAFE: ReadonlySet<CommandClassification> = new Set(['read', 'write', 'network']);

const HEREDOC = "NODE_PATH=/tmp node - <<'NODE'\nconsole.log(1); rm -rf /x\nNODE";

function evaluate(command: string) {
  return evaluateCommandAST(command, parseCommandAST(command), ALLOW_SAFE);
}

describe('denial explanation — first line survives a multi-line command', () => {
  test('the header is a single line for a heredoc command', () => {
    const explanation = buildDenialExplanation(HEREDOC, evaluate(HEREDOC).segments);
    const firstLine = explanation.split('\n')[0] ?? '';

    expect(firstLine.startsWith('Command denied: "')).toBe(true);
    expect(firstLine.endsWith('"')).toBe(true);
    expect(firstLine).toContain('NODE_PATH=/tmp node');
    // The whole command is named on that one line, terminator included.
    expect(firstLine).toContain('NODE');
  });

  test('the segment analysis is still reachable after the header', () => {
    const explanation = buildDenialExplanation(HEREDOC, evaluate(HEREDOC).segments);
    expect(explanation).toContain('Segment analysis');
    expect(explanation).toContain('classification:');
    expect(explanation).toContain('reason:');
  });

  test('a denied multi-line command names a classification and a reason', () => {
    const command = 'printf "a\nb" && rm -rf /x';
    const verdict = evaluate(command);
    expect(verdict.allowed).toBe(false);
    const explanation = verdict.denialExplanation ?? '';
    expect(explanation.split('\n')[0]).toContain('Command denied:');
    expect(explanation).toContain('destructive');
    expect(explanation).toContain('reason:');
  });

  test('the header loses no part of the command it collapses', () => {
    const firstLine =
      buildDenialExplanation(HEREDOC, evaluate(HEREDOC).segments).split('\n')[0] ?? '';
    // Body and terminator both survive the collapse onto one line.
    expect(firstLine).toContain('console.log(1)');
    expect(firstLine).toContain('rm -rf /x');
    expect(firstLine).toContain("<<'NODE'");
  });
});

describe('tokenizer — heredoc bodies are data, not shell source', () => {
  test("<<'DELIM' lexes as one redirect operator, not two bare < tokens", () => {
    const tokens = tokenize(HEREDOC);
    expect(tokens.filter((token) => token.value === '<').length).toBe(0);
    expect(tokens.some((token) => token.value === '<<')).toBe(true);
  });

  test('body text does not become a command segment', () => {
    const commands = collectCommandNodes(parseCommandAST(HEREDOC)).map((node) => node.command);
    expect(commands).toEqual(['node']);
    expect(commands).not.toContain('rm');
  });

  test('a heredoc carrying destructive-looking text is not denied for it', () => {
    const verdict = evaluate(HEREDOC);
    expect(verdict.segments.map((segment) => segment.classification)).not.toContain('destructive');
  });

  test('<<- and unquoted delimiters are recognized', () => {
    for (const command of ['cat <<-EOF\n\trm -rf /\n\tEOF', 'cat <<EOF\nrm -rf /\nEOF']) {
      const commands = collectCommandNodes(parseCommandAST(command)).map((node) => node.command);
      expect(commands).toEqual(['cat']);
    }
  });

  test('a real command after the heredoc terminator is still classified', () => {
    const command = "cat <<'EOF'\nharmless\nEOF\n; rm -rf /x";
    const commands = collectCommandNodes(parseCommandAST(command)).map((node) => node.command);
    expect(commands).toContain('rm');
    expect(evaluate(command).allowed).toBe(false);
  });

  test('an unterminated heredoc consumes the rest of the input', () => {
    const commands = collectCommandNodes(parseCommandAST("cat <<'EOF'\nrm -rf /\n")).map(
      (node) => node.command,
    );
    expect(commands).toEqual(['cat']);
  });

  test('<<< here-strings are left as ordinary redirects', () => {
    const command = 'grep foo <<< "bar"';
    const commands = collectCommandNodes(parseCommandAST(command)).map((node) => node.command);
    expect(commands).toEqual(['grep']);
  });
});
