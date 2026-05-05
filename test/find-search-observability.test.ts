import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeContentQuery } from '../packages/sdk/src/platform/tools/find/content.ts';
import { executeFilesQuery } from '../packages/sdk/src/platform/tools/find/files.ts';
import { FindRuntimeService, type ImportGraphLike } from '../packages/sdk/src/platform/tools/find/shared.ts';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

class DegradedImportGraphRuntime extends FindRuntimeService {
  override async getImportGraph(_projectRoot: string): Promise<ImportGraphLike> {
    return {
      findImports: () => [],
      findDependents: () => [],
      getWarnings: () => ['Import graph build failed; relationship results may be incomplete: test failure'],
    };
  }
}

describe('find/search degradation observability', () => {
  test('files mode warns when nested gitignore files are present but not applied', async () => {
    const root = tempRoot('gv-find-gitignore-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', '.gitignore'), 'ignored.ts\n', 'utf-8');
    writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true;\n', 'utf-8');

    const result = await executeFilesQuery(
      { id: 'files', mode: 'files', patterns: ['**/*.ts'] },
      { format: 'files_only' },
      root,
    );

    const files = result.files as string[];
    const warnings = result.warnings as string[];
    expect(files).toContain(join(root, 'src', 'ignored.ts'));
    expect(warnings.some((warning) => warning.includes('Nested .gitignore files are not applied'))).toBe(true);
  });

  test('content relationships include import graph degradation warnings', async () => {
    const root = tempRoot('gv-find-relationships-');
    writeFileSync(join(root, 'a.ts'), 'export const marker = 1;\n', 'utf-8');

    const result = await executeContentQuery(
      { id: 'content', mode: 'content', pattern: 'marker', relationships: true },
      { format: 'matches' },
      new DegradedImportGraphRuntime(),
      root,
    );

    expect(result.count).toBe(1);
    expect(result.relationships).toBeDefined();
    const warnings = result.warnings as string[];
    expect(warnings.some((warning) => warning.includes('Import graph build failed'))).toBe(true);
  });
});
