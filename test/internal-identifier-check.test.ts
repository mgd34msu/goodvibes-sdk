/**
 * The internal-identifier gate: planning shorthand never lands in tracked
 * text again, while genuine technical tokens stay legal.
 *
 * Every banned token in this file is CONSTRUCTED at runtime (concatenation)
 * so this test file itself never contains one — the checker scans test/.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { checkNoInternalIdentifiers } from '../scripts/internal-identifier-rule.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

function violationsFor(text: string, relPath = 'packages/sdk/src/example.ts'): string[] {
  return checkNoInternalIdentifiers([{ relPath, text }]);
}

describe('internal-identifier rule', () => {
  test('flags every banned planning-identifier shape', () => {
    const banned = [
      'W' + '3.' + '1 shipped the renderer', // wave.item id
      'tracked as ' + 'wo' + '402 in the plan', // numeric work-order id
      'see ' + 'WO-' + 'B for details', // lettered work-order id
      'see ' + 'WO-' + '17 for details', // numbered work-order id
      'the ' + 'DEBT-' + '4 register entry', // debt-register id
      'the ' + 'UX-' + 'A workstream', // UX-workstream id
      'landed in ' + 'Wave ' + '5', // wave word-form with space
      'landed in ' + 'Wave-' + '5', // wave word-form with hyphen
      'round ' + 'W2' + '-R3 of the audit', // wave-round id
      'fixed (' + 'B7' + ') last week', // lettered finding id alone in parentheses
      "test('" + 'C3' + ": commits atomically', () => {})", // test title starting with a lettered id + colon
      'covers ' + 'A1' + '/' + 'A2' + ' together', // slash-chained lettered ids
      'see ' + 'WO-' + '0B for details', // digit-then-letter work-order id
      'see ' + 'WO-' + '207b for details', // digits-then-lowercase-letter work-order id
      // Contextual plan-item shapes (the label class a shipped-comment sweep
      // found after the first cut of this rule):
      'recorded in plan ' + 'ite' + 'm 1.4.3 of the roadmap', // "plan item N.N.N"
      'this extends ' + 'ite' + 'm 2.3 as ruled', // bare "item N.N"
      'per ' + 'Ite' + 'm 1.4.2, the gate holds', // case-insensitive
    ];
    for (const text of banned) {
      const violations = violationsFor(text);
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  test('quotes the owner doctrine verbatim in every violation', () => {
    const doctrine =
      'never put wave/work-order/register ids in outward-facing or in-code text; '
      + 'plain language only; provenance via decision-record paths or versions';
    const violations = violationsFor('entry ' + 'DEBT-' + '9 remains open');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(doctrine);
    expect(violations[0]).toContain('[internal-identifier]');
  });

  test('reports the file path and one-based line number', () => {
    const text = ['clean line', 'tracked as ' + 'wo' + '1234'].join('\n');
    const violations = violationsFor(text, 'scripts/tool.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith('scripts/tool.ts:2:');
  });

  test('non-regression: genuine technical tokens stay legal', () => {
    const legal = [
      'strips C0 and C1 control characters from the payload', // control-set names, bare
      'bind the F5 key to refresh and F12 to devtools', // function keys (F excluded from the letter range)
      'the Slack channel C0123456 receives the digest', // Slack channel ids are a bare letter + digits
      'IMAP tag A1 continues the session', // bare token in running text is not banned
      'word-boundary guard: keyword arguments', // contains "wo" without digits
      'sha256 of the workload artifact', // "workload" must not match the work-order pattern
      'the woNNN placeholder in docs prose', // no digits after wo
      'RestartSteps=8 with RestartMaxDelaySec=300', // plain unit directives
      'systemd 254 supports escalating restart delays', // version numbers
      'HTTP 400/404/405 are handled distinctly', // numeric slash chains
      // Semver / release-version strings must NEVER trip the plan-item shape —
      // versions are the doctrine's sanctioned provenance:
      "isDaemonVersionCompatible('1.4.2', '1.0.0') stays true", // bare semver args
      'Full-detach catalog (1.2.0) reads serialize a bare array', // parenthesized release version
      'requires v1.8.0 or newer', // v-prefixed version
      'the checklist item has 1.5 points', // "item" not directly adjoining the number
    ];
    for (const text of legal) {
      expect(violationsFor(text)).toEqual([]);
    }
  });

  test('docs/decisions/** is exempt (the sanctioned provenance store)', () => {
    const text = 'Wave: One-Platform ' + 'Wave ' + '4 (' + 'A9' + ')';
    expect(violationsFor(text, 'docs/decisions/2026-07-06-example.md')).toEqual([]);
    expect(violationsFor(text, 'docs/guide.md').length).toBeGreaterThan(0);
  });
});

describe('check-internal-identifiers.ts (subprocess)', () => {
  test('red test: a planted violation fails the check with a named file and line', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-red-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'planted.ts'),
        '// tracked as ' + 'wo' + '777 in the register\n',
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: {
          ...process.env,
          INTERNAL_ID_ROOT: root,
          INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toContain('src/planted.ts:1');
      expect(stderr).toContain('internal-identifier-check FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in a .json file fails (json joined the scanned set)', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-json-'));
    try {
      writeFileSync(
        join(root, 'budgets.json'),
        JSON.stringify({ entry: { rationale: 'grew during ' + 'Wave-' + '6 work' } }, null, 2),
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['budgets.json']) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('budgets.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in an extensionless hook script fails (.githooks joined the scanned set)', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-hooks-'));
    try {
      mkdirSync(join(root, '.githooks'), { recursive: true });
      writeFileSync(
        join(root, '.githooks', 'pre-commit'),
        '#!/usr/bin/env bash\n# enforces the cap (' + 'WO-' + 'C)\n',
      );
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['.githooks']) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('.githooks/pre-commit:2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: a violation in the root changelog fails under the DEFAULT scan set', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-changelog-'));
    try {
      writeFileSync(join(root, 'CHANGELOG.md'), '## Unreleased\n\n- landed in ' + 'Wave ' + '9\n');
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        // No INTERNAL_ID_DIRS_JSON: the DEFAULT target set must include root markdown.
        env: { ...process.env, INTERNAL_ID_ROOT: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('CHANGELOG.md:3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red test: the digit-then-letter work-order shape fails end-to-end', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-digitletter-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'planted.ts'), '// tracked as ' + 'WO-' + '0B\n');
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: { ...process.env, INTERNAL_ID_ROOT: root, INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('src/planted.ts:1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('green test: clean text passes', () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-id-green-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'clean.ts'), '// plain descriptive comment\n');
      const result = Bun.spawnSync({
        cmd: ['bun', join(REPO_ROOT, 'scripts', 'check-internal-identifiers.ts')],
        env: {
          ...process.env,
          INTERNAL_ID_ROOT: root,
          INTERNAL_ID_DIRS_JSON: JSON.stringify(['src']),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('internal-identifier-check PASSED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
