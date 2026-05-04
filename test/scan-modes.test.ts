/**
 * QA-07: scan-modes coverage — security and dead_code modes
 *
 * Tests:
 * 1. security mode detects a known-vulnerable secret pattern (positive)
 * 2. security mode reports no findings on clean code (negative)
 * 3. dead_code mode flags an unreferenced exported function (positive)
 * 4. dead_code mode does NOT flag a referenced exported function (negative)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSecurity, runDeadCode } from '../packages/sdk/src/platform/tools/analyze/scan-modes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gv-scan-modes-'));
}

async function writeFixture(dir: string, filename: string, content: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// security mode
// ---------------------------------------------------------------------------

describe('runSecurity — security mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('detects a hardcoded API key matching the token_assignment pattern', async () => {
    // Fixture: a file with a clearly hardcoded secret
    await writeFixture(
      tmpDir,
      'config.ts',
      `// Service configuration\nconst apiSecret = 'supersecretvalue123';\n`,
    );

    const result = await runSecurity(
      { mode: 'security', securityScope: 'secrets', projectRoot: tmpDir },
      tmpDir,
    );

    const secrets = result.secrets as { findings: Array<{ file: string; line: number; pattern: string; match: string }>; count: number };
    expect(secrets).not.toBeNull(); // presence-only: secrets field present
    expect(secrets.count).toBe(1);
    expect(secrets.findings).toHaveLength(1);
    // The finding should point to the fixture file
    expect(secrets.findings[0].file).toContain('config.ts');
    // Should identify the token_assignment pattern
    expect(secrets.findings[0].pattern).toBe('token_assignment');
  });

  test('reports zero findings on clean code with no secrets', async () => {
    // Fixture: a clean file with no sensitive values
    await writeFixture(
      tmpDir,
      'clean.ts',
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );

    const result = await runSecurity(
      { mode: 'security', securityScope: 'secrets', projectRoot: tmpDir },
      tmpDir,
    );

    const secrets = result.secrets as { findings: unknown[]; count: number };
    expect(secrets).not.toBeNull(); // presence-only: secrets field present
    expect(secrets.count).toBe(0);
    expect(secrets.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dead_code mode
// ---------------------------------------------------------------------------

describe('runDeadCode — dead_code mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('flags an exported function that is never referenced elsewhere', async () => {
    // Fixture A: exports a function nobody uses
    await writeFixture(
      tmpDir,
      'lib.ts',
      `/* fixture: scan-target */\nexport function orphanedHelper(): void {\n  void 0;\n}\n`,
    );
    // Fixture B: unrelated file that doesn't reference orphanedHelper
    await writeFixture(
      tmpDir,
      'main.ts',
      `/* fixture: scan-target */\nexport function main(): void {\n  void 0;\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    expect(deadNames).toContain('orphanedHelper');
    expect(result.total_exports).toBe(2);
  });

  test('does NOT flag an exported function that is referenced in another file', async () => {
    // Fixture A: exports a function
    await writeFixture(
      tmpDir,
      'utils.ts',
      `export function computeSum(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    // Fixture B: imports and uses computeSum
    await writeFixture(
      tmpDir,
      'consumer.ts',
      `/* fixture: scan-target */\nimport { computeSum } from './utils.js';\nexport function run(): void {\n  const result = computeSum(1, 2);\n  console.log(result);\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    // computeSum is referenced in consumer.ts — must NOT appear as dead
    expect(deadNames).not.toContain('computeSum');
  });
});
