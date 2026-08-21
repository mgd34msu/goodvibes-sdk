import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { editSchema } from '../packages/sdk/src/platform/tools/edit/schema.ts';

/**
 * Strict OpenAI-compatible request validators (RouteLLM among them) forbid the
 * `oneOf` keyword inside tool parameter schemas and 400 the WHOLE chat request
 *, one tool with a `oneOf` made every turn through such a provider fail with
 * "Extra inputs are not permitted". `anyOf` validates identically for disjoint
 * branches and is the keyword OpenAI's own function-calling schemas use, so
 * tool schemas use `anyOf` and this pin keeps `oneOf` from coming back.
 */

function findOneOfPaths(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findOneOfPaths(item, `${path}[${i}]`, hits));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'oneOf') hits.push(`${path}.${key}`);
    findOneOfPaths(child, `${path}.${key}`, hits);
  }
}

const TOOLS_ROOT = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'tools');

function schemaModulePaths(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...schemaModulePaths(full));
    } else if (/schema[^/]*\.ts$/.test(entry) && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('tool schemas stay wire-compatible with strict OpenAI-compatible validators', () => {
  test('the edit tool occurrence union is anyOf, not oneOf', () => {
    const hits: string[] = [];
    findOneOfPaths(editSchema, 'editSchema', hits);
    expect(hits).toEqual([]);
    const occurrence = (editSchema as { properties: { edits: { items: { properties: { occurrence: Record<string, unknown> } } } } })
      .properties.edits.items.properties.occurrence;
    expect(Array.isArray(occurrence['anyOf'])).toBe(true);
  });

  test('no schema module under platform/tools exports an object carrying oneOf', async () => {
    const modules = schemaModulePaths(TOOLS_ROOT);
    expect(modules.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const modulePath of modules) {
      const mod = (await import(modulePath)) as Record<string, unknown>;
      for (const [name, exported] of Object.entries(mod)) {
        if (typeof exported === 'function') continue;
        const hits: string[] = [];
        findOneOfPaths(exported, `${modulePath.split('/platform/tools/')[1]}:${name}`, hits);
        offenders.push(...hits);
      }
    }
    expect(offenders).toEqual([]);
  });
});
