/**
 * The gate that makes the wrong thing hard.
 *
 * Three times a credential captured on one surface has been unreadable to the
 * daemon that uses it, and each time the immediate cause was different: a wrong
 * default, a forced scope, a bare key name nothing derived. The constant was
 * that nothing anywhere stated whether the daemon needed that credential, so no
 * code could route it and no reviewer could check.
 *
 * `scripts/check-credential-scope.ts` is the answer: a secret-store write must
 * name a credential the registry classifies, or state its scope at the call
 * site. This exercises the gate against fixtures, a build gate nobody has
 * tested is a build gate that passes everything.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'check-credential-scope.ts');

interface GateResult {
  readonly ok: boolean;
  readonly output: string;
}

async function runGate(source: string): Promise<GateResult> {
  const root = mkdtempSync(join(tmpdir(), 'gv-credgate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'fixture.ts'), source, 'utf-8');

  const proc = Bun.spawn(['bun', SCRIPT], {
    env: {
      ...process.env,
      CREDENTIAL_SCOPE_ROOT: root,
      CREDENTIAL_SCOPE_DIRS_JSON: JSON.stringify(['src']),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, output: `${stdout}\n${stderr}` };
}

describe('a credential nothing classifies cannot be stored', () => {
  test('an undeclared key name fails the build', async () => {
    const result = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
export async function store(): Promise<void> {
  await secrets.set('SOME_BRAND_NEW_TOKEN', 'value');
}
`);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('SOME_BRAND_NEW_TOKEN');
    expect(result.output).toContain('not classified');
  });

  test('a declared key passes', async () => {
    const result = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
export async function store(): Promise<void> {
  await secrets.set('SLACK_BOT_TOKEN', 'value');
}
`);
    expect(result.ok).toBe(true);
  });

  test('a key named through a constant is resolved, not waved through', async () => {
    const undeclared = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
const MY_TOKEN_KEY = 'A_TOKEN_NOBODY_DECLARED';
export async function store(): Promise<void> {
  await secrets.set(MY_TOKEN_KEY, 'value');
}
`);
    expect(undeclared.ok).toBe(false);
    expect(undeclared.output).toContain('A_TOKEN_NOBODY_DECLARED');

    const declared = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
const DISCORD_KEY = 'DISCORD_BOT_TOKEN';
export async function store(): Promise<void> {
  await secrets.set(DISCORD_KEY, 'value');
}
`);
    expect(declared.ok).toBe(true);
  });

  test('an explicit scope is the escape hatch, and it is visible in the diff', async () => {
    const result = await runGate(`
declare const secrets: { set(key: string, value: string, options?: unknown): Promise<void> };
export async function store(operatorChosenKey: string): Promise<void> {
  // An operator-chosen name the registry cannot know. The author says where it goes.
  await secrets.set(operatorChosenKey, 'value', { scope: 'daemon' });
}
`);
    expect(result.ok).toBe(true);
  });

  test('a key minted on the spot with no stated scope fails', async () => {
    const result = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
function feedKey(name: string): string { return \`GOODVIBES_FEED_\${name}\`; }
export async function store(name: string): Promise<void> {
  await secrets.set(feedKey(name), 'value');
}
`);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('computed secret key');
  });

  test('the platform derivation classifies by construction, wrapper and all', async () => {
    const result = await runGate(`
declare const secrets: { set(key: string, value: string): Promise<void> };
declare function daemonSecretKeyFor(path: string): string;
function tokenKey(provider: string): string { return daemonSecretKeyFor(\`calendar.\${provider}.tokens\`); }
export async function store(provider: string): Promise<void> {
  await secrets.set(tokenKey(provider), 'value');
}
`);
    expect(result.ok).toBe(true);
  });

  test('prose describing a write is not mistaken for one', async () => {
    const result = await runGate(`
/**
 * This module explains that a caller does \`secrets.set('AN_UNDECLARED_NAME', v)\`.
 */
// and here too: secrets.set('ANOTHER_UNDECLARED_NAME', v)
export const nothing = 1;
`);
    expect(result.ok).toBe(true);
  });

  test('a helper SIGNATURE is not a write', async () => {
    const result = await runGate(`
export class Thing {
  private async storeSecret(key: string, value: string): Promise<void> {
    void key; void value;
  }
}
`);
    expect(result.ok).toBe(true);
  });
});
