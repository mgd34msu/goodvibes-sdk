/**
 * PERMANENT REGRESSION GUARD, do not weaken.
 *
 * Sender confidence must stay a display concern. This walks the real source of
 * `platform/email` and fails if it starts being read anywhere that could turn
 * it into permission.
 *
 * The check is deliberately a narrow allowlist rather than a clever heuristic:
 * a new file reading `displayedConfidence` has to be added here by hand, which
 * puts a human in front of the question "is this display, or is this becoming
 * authority?", the exact question that gets skipped otherwise.
 *
 * The surface that renders the claim keeps the same guard over its own tree.
 * This is the SDK's half: the mail service now sits between the receiving
 * server's verdict and the sentence a human reads, so the drift could start
 * here just as easily.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL_ROOT = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'email');

/**
 * Files permitted to read sender confidence, each because it declares or
 * carries it for display.
 *
 * Adding an entry is a review decision, not a formality: the question to
 * answer is whether the new reader DISPLAYS the value or BRANCHES on it.
 */
const CONFIDENCE_READERS = new Set([
  // Declares the type and the claim shape the port returns.
  'sender-claim.ts',
  // Names the property in the module's security notes; carries no logic.
  'index.ts',
]);

/** Tokens that would indicate confidence being turned into a decision. */
const AUTHORITY_TOKENS = [
  'commandAuthority =',
  'canConfirm',
  'allowed: true',
  'surfaceAuthority(',
  'effectPermittedForProvenance',
];

function walkSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walkSourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('sender confidence never drifts into an authority decision', () => {
  const files = walkSourceFiles(EMAIL_ROOT);

  test('the source tree was actually walked, so a passing result means something', () => {
    // Guards against the walk silently finding nothing and the suite reporting
    // success for an empty set.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  test('only files that declare or display sender confidence read it', () => {
    const readers: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      if (!text.includes('displayedConfidence')) continue;
      readers.push(file.slice(EMAIL_ROOT.length + 1));
    }

    const unexpected = readers.filter((relative) => !CONFIDENCE_READERS.has(relative));
    expect(
      unexpected,
      `these files read sender confidence but are not declared display sites. ` +
      `If the new reader DISPLAYS it, add it to CONFIDENCE_READERS. If it BRANCHES on it, ` +
      `that is the boundary failing and the change should not land: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  test('no declared display site turns confidence into a permission', () => {
    for (const relative of CONFIDENCE_READERS) {
      const text = readFileSync(join(EMAIL_ROOT, relative), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.includes('displayedConfidence')) continue;
        // A line mentioning confidence must not also be deciding something.
        for (const token of AUTHORITY_TOKENS) {
          expect(
            line.includes(token),
            `${relative} reads sender confidence on the same line as "${token}", ` +
            `which is what turning display into authority looks like: ${line.trim()}`,
          ).toBe(false);
        }
      }
    }
  });

  test('commandAuthority is only ever assigned the literal none', () => {
    // The type already pins this; the assertion catches a widening of the type
    // itself, which would otherwise pass typecheck and quietly open the door.
    const source = readFileSync(join(EMAIL_ROOT, 'sender-claim.ts'), 'utf-8');
    expect(source).toContain("readonly commandAuthority: 'none'");
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      const assignments = text.match(/commandAuthority:\s*'[a-z-]+'/g) ?? [];
      for (const assignment of assignments) {
        expect(assignment).toBe("commandAuthority: 'none'");
      }
    }
  });

  test('no credential is interpolated into anything but a protocol write', () => {
    // A resolved password lives for the length of one connection. It belongs on
    // the wire and nowhere else, not in an Error, not in a returned `error`
    // field, not in a status object. Checked structurally because the leak
    // would be one template literal, added in one line, by someone making an
    // error message more helpful.
    //
    // The three legitimate interpolations are the LOGIN quoting, the XOAUTH2
    // SASL token and the AUTH PLAIN token, each of which is the credential
    // being handed to the server that asked for it.
    const wireWrites = ['session.command(', 'session.cmd(', 'base64(', 'buildXOAuth2Token('];
    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.slice(EMAIL_ROOT.length + 1);
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!/\$\{(password|token|quotedPass)\b/.test(line)) continue;
        if (wireWrites.some((marker) => line.includes(marker))) continue;
        offenders.push(`${relative}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `a credential is interpolated somewhere other than a protocol write: ${offenders.join(' | ')}`,
    ).toEqual([]);

    // And the redaction that keeps the reference itself out of status output.
    const service = readFileSync(join(EMAIL_ROOT, 'email-service.ts'), 'utf-8');
    expect(service).toContain("passwordRef: config.passwordRef ? '[configured]' : '[missing]'");
  });
});
