/**
 * post-edit-diagnostics.test.ts
 *
 * Cheap, in-process post-edit diagnostics appended to write/edit tool results.
 * The bundled provider is tree-sitter-backed SYNTAX diagnostics (errors only,
 * no type checking, no process spawn). Covers: diagnostics appear on a broken
 * write/edit, honest absence when no provider is wired or the config is off,
 * and the capped output.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../packages/sdk/src/platform/tools/write/index.ts';
import { createEditTool } from '../packages/sdk/src/platform/tools/edit/index.ts';
import { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.ts';
import {
  TypeScriptSyntaxDiagnosticsProvider,
  collectPostEditDiagnostics,
  type DiagnosticsProvider,
} from '../packages/sdk/src/platform/tools/shared/post-edit-diagnostics.ts';

const BROKEN_TS = 'export function broken() {\n  const x = ;\n'; // missing expr + unclosed brace
const CLEAN_TS = 'export function ok(): number {\n  return 1;\n}\n';

function makeProjectDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'post-edit-diag-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  return root;
}

function onConfig(mode: 'on' | 'off') {
  return { get: (k: string) => (k === 'diagnostics.postEdit' ? mode : undefined) } as unknown as Parameters<typeof createWriteTool>[0]['configManager'];
}

// ── provider unit ────────────────────────────────────────────────────────────

describe('TypeScriptSyntaxDiagnosticsProvider', () => {
  test('flags a syntax error in a broken .ts file within a TS project', async () => {
    const root = makeProjectDir();
    const provider = new TypeScriptSyntaxDiagnosticsProvider();
    const diags = await provider.collect(join(root, 'broken.ts'), BROKEN_TS);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.severity).toBe('error');
    expect(diags[0]!.line).toBeGreaterThan(0);
  });

  test('returns [] for clean content (honest absence, not a fabricated pass)', async () => {
    const root = makeProjectDir();
    const provider = new TypeScriptSyntaxDiagnosticsProvider();
    expect(await provider.collect(join(root, 'ok.ts'), CLEAN_TS)).toEqual([]);
  });

  test('returns [] when no TS project context is detectable', async () => {
    // A path with no tsconfig/jsconfig above it → honest absence.
    const provider = new TypeScriptSyntaxDiagnosticsProvider();
    expect(await provider.collect(join(tmpdir(), 'no-project-xyz', 'broken.ts'), BROKEN_TS)).toEqual([]);
  });

  test('does not support non-JS/TS files', () => {
    const provider = new TypeScriptSyntaxDiagnosticsProvider();
    expect(provider.supports('/x/README.md')).toBe(false);
    expect(provider.supports('/x/a.ts')).toBe(true);
  });
});

// ── cap ──────────────────────────────────────────────────────────────────────

describe('collectPostEditDiagnostics', () => {
  test('caps the total number of diagnostics returned', async () => {
    const many: DiagnosticsProvider = {
      name: 'fake',
      supports: () => true,
      collect: async () => Array.from({ length: 50 }, (_v, i) => ({ severity: 'error' as const, line: i + 1, column: 0, message: `e${i}` })),
    };
    const out = await collectPostEditDiagnostics(many, [{ path: '/x/a.ts', content: '' }], 20);
    expect(out.length).toBe(20);
    expect(out.every((d) => d.file === '/x/a.ts')).toBe(true);
  });

  test('returns [] when no provider is wired', async () => {
    expect(await collectPostEditDiagnostics(undefined, [{ path: '/x/a.ts', content: '' }])).toEqual([]);
  });
});

// ── write tool integration ─────────────────────────────────────────────────────

describe('write tool post-edit diagnostics', () => {
  test('a broken write appends a structured diagnostics field', async () => {
    const root = makeProjectDir();
    const tool = createWriteTool({
      projectRoot: root,
      configManager: onConfig('on'),
      diagnosticsProvider: new TypeScriptSyntaxDiagnosticsProvider(),
    });
    const result = await tool.execute({ files: [{ path: 'broken.ts', content: BROKEN_TS }] });
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output as string) as { diagnostics?: unknown[] };
    expect(Array.isArray(output.diagnostics)).toBe(true);
    expect(output.diagnostics!.length).toBeGreaterThan(0);
  });

  test('a clean write appends no diagnostics field (honest absence)', async () => {
    const root = makeProjectDir();
    const tool = createWriteTool({
      projectRoot: root,
      configManager: onConfig('on'),
      diagnosticsProvider: new TypeScriptSyntaxDiagnosticsProvider(),
    });
    const result = await tool.execute({ files: [{ path: 'ok.ts', content: CLEAN_TS }] });
    const output = JSON.parse(result.output as string) as { diagnostics?: unknown };
    expect(output.diagnostics).toBeUndefined();
  });

  test('config diagnostics.postEdit=off suppresses diagnostics on a broken write', async () => {
    const root = makeProjectDir();
    const tool = createWriteTool({
      projectRoot: root,
      configManager: onConfig('off'),
      diagnosticsProvider: new TypeScriptSyntaxDiagnosticsProvider(),
    });
    const result = await tool.execute({ files: [{ path: 'broken.ts', content: BROKEN_TS }] });
    const output = JSON.parse(result.output as string) as { diagnostics?: unknown };
    expect(output.diagnostics).toBeUndefined();
  });

  test('no provider wired → no diagnostics field', async () => {
    const root = makeProjectDir();
    const tool = createWriteTool({ projectRoot: root, configManager: onConfig('on') });
    const result = await tool.execute({ files: [{ path: 'broken.ts', content: BROKEN_TS }] });
    const output = JSON.parse(result.output as string) as { diagnostics?: unknown };
    expect(output.diagnostics).toBeUndefined();
  });
});

// ── edit tool integration ───────────────────────────────────────────────────────

describe('edit tool post-edit diagnostics', () => {
  test('an edit that breaks syntax appends a diagnostics text block', async () => {
    const root = makeProjectDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const value = 1;\n');
    const fileCache = new FileStateCache();
    const tool = createEditTool(fileCache, {
      cwd: root,
      configManager: onConfig('on'),
      diagnosticsProvider: new TypeScriptSyntaxDiagnosticsProvider(),
    });
    const result = await tool.execute({
      edits: [{ path: 'src/a.ts', find: 'export const value = 1;', replace: 'export const value = ;' }],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Syntax diagnostics');
  });
});
