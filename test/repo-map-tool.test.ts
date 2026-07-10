/**
 * repo-map-tool.test.ts
 *
 * The model-invoked, token-budgeted repo_map tool: it returns a ranked outline
 * of the repo (directory summary + highest-centrality source files with their
 * top-level exports), capped to a token budget. Covers: tool registration
 * (incl. contract verification), budget respected, stable ranking by import
 * centrality, and top-level export extraction.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoMapTool, extractTopLevelExports } from '../packages/sdk/src/platform/tools/repo-map/index.ts';
import { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.ts';
import { estimateTokens } from '../packages/sdk/src/platform/core/compaction-types.ts';

/** A small repo where core.ts is imported by two files (highest centrality). */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'core.ts'), 'export const CORE = 1;\nexport function coreFn() { return CORE; }\n');
  writeFileSync(join(root, 'src', 'a.ts'), "import { CORE } from './core.js';\nexport const a = CORE;\n");
  writeFileSync(join(root, 'src', 'b.ts'), "import { coreFn } from './core.js';\nexport const b = coreFn();\n");
  writeFileSync(join(root, 'src', 'index.ts'), "import { a } from './a.js';\nimport { b } from './b.js';\nexport const all = [a, b];\n");
  return root;
}

// ── registration ──────────────────────────────────────────────────────────────

describe('repo_map registration', () => {
  test('registers with the tool registry and passes contract verification', () => {
    const registry = new ToolRegistry();
    const result = registry.registerWithContract(createRepoMapTool({ projectRoot: makeRepo() }), {
      strictIdempotency: false,
      strictPermissionClass: false,
    });
    expect(result.passed).toBe(true);
    expect(registry.has('repo_map')).toBe(true);
    const def = registry.getToolDefinitions().find((d) => d.name === 'repo_map');
    expect(def?.sideEffects).toEqual(['read_fs']);
  });
});

// ── export extraction ────────────────────────────────────────────────────────

describe('extractTopLevelExports', () => {
  test('captures declarations, named re-exports, and default', () => {
    const src = [
      'export const A = 1;',
      'export function fn() {}',
      'export class C {}',
      'export interface I {}',
      'export type T = number;',
      'export { x, y as z };',
      'export default 42;',
    ].join('\n');
    const names = extractTopLevelExports(src);
    for (const n of ['A', 'fn', 'C', 'I', 'T', 'x', 'z', 'default']) {
      expect(names).toContain(n);
    }
  });
});

// ── output + ranking + budget ───────────────────────────────────────────────────

describe('repo_map execution', () => {
  test('produces a structured map with the most-imported file ranked first', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const result = await tool.execute({ budgetTokens: 2000 });
    expect(result.success).toBe(true);
    const output = result.output as string;
    expect(output).toContain('Repository map');
    expect(output).toContain('Directories:');
    expect(output).toContain('Key files');
    // core.ts has two dependents (a.ts, b.ts) → ranked ahead of every other file.
    const coreIdx = output.indexOf('src/core.ts');
    const aIdx = output.indexOf('src/a.ts');
    const indexIdx = output.indexOf('src/index.ts');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(aIdx);
    expect(coreIdx).toBeLessThan(indexIdx);
    // exports of core surfaced.
    expect(output).toContain('coreFn');
  });

  test('respects the token budget', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const budgetTokens = 300;
    const result = await tool.execute({ budgetTokens });
    expect(result.success).toBe(true);
    expect(estimateTokens(result.output as string)).toBeLessThanOrEqual(budgetTokens);
  });

  test('ranking is stable across repeated runs', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const first = await tool.execute({ budgetTokens: 2000 });
    const second = await tool.execute({ budgetTokens: 2000 });
    expect(first.output).toBe(second.output);
  });
});
