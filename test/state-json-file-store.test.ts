// Tests for JsonFileStore
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JsonFileStore } from '@pellux/goodvibes-sdk/platform/state';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(makeProjectTempDir('json-file-store'), 'case-'));
  return { dir, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
}

async function writeTempFile(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
import { rm } from 'node:fs/promises';

let tempDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const res = await makeTempDir();
  tempDir = res.dir;
  cleanup = res.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('JsonFileStore', () => {
  it('load returns null when file does not exist', async () => {
    const store = new JsonFileStore<{foo: string}>(`${tempDir}/nonexistent.json`);
    const data = await store.load();
    expect(data).toBeNull();
  });

  it('load returns parsed object for valid JSON file', async () => {
    const filePath = `${tempDir}/valid.json`;
    await writeTempFile(tempDir, 'valid.json', JSON.stringify({ foo: 'bar' }, null, 2) + '\n');
    const store = new JsonFileStore<{foo: string}>(filePath);
    const data = await store.load();
    expect(data).toEqual({ foo: 'bar' });
  });

  it('load returns null for invalid JSON file', async () => {
    const filePath = `${tempDir}/invalid.json`;
    await writeTempFile(tempDir, 'invalid.json', '{ not: valid json }');
    const store = new JsonFileStore<unknown>(filePath);
    await expect(store.load()).rejects.toThrow('JsonFileStore failed to load');
  });

  it('save writes data atomically and creates directory', async () => {
    const nestedDir = `${tempDir}/a/b/c`;
    const filePath = `${nestedDir}/data.json`;
    const store = new JsonFileStore<{num: number}>(filePath);
    await store.save({ num: 42 });
    // Verify file exists and content matches expected format
    const content = await Bun.file(filePath).text();
    const expected = JSON.stringify({ num: 42 }, null, 2) + '\n';
    expect(content).toBe(expected);
  });
});
