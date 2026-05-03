import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('lazy native imports', () => {
  test('startup-sensitive tool modules do not import @ast-grep/napi at module top level', () => {
    const structural = readSource('packages/sdk/src/platform/tools/find/structural.ts');
    const editMatch = readSource('packages/sdk/src/platform/tools/edit/match.ts');

    expect(structural).not.toContain("import * as astGrep from '@ast-grep/napi'");
    expect(editMatch).not.toContain("import * as astGrep from '@ast-grep/napi'");

    expect(structural).toContain("import('@ast-grep/napi')");
    expect(editMatch).toContain("import('@ast-grep/napi')");
  });
});
