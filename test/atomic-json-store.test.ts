/**
 * atomic-json-store.test.ts, the two mechanics every on-disk JSON store in the
 * platform now shares, tested once at the helper.
 *
 * The per-store suites do not re-test these; they test that their store is
 * wired to them. The fixtures that matter are the two ways a real torn write
 * shows up on disk: valid JSON with a zero tail (a crash after the file grew
 * but before the bytes landed) and JSON cut off partway (a crash mid-write).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import {
  CORRUPT_QUARANTINE_MAX_FILES,
  quarantineCorruptFile,
  readJsonFileOrQuarantine,
  STALE_TEMP_FILE_MIN_AGE_MS,
  writeFileAtomic,
  writeJsonFileAtomic,
} from '../packages/sdk/src/platform/utils/atomic-json-store.ts';

interface Shape {
  readonly version: 1;
  readonly items: readonly string[];
}

function storeDir(): string {
  return makeProjectTempDir('gv-atomic-json-store');
}

function loadShape(path: string): Shape | null {
  return readJsonFileOrQuarantine<Shape>(path, {
    label: 'test/store',
    recovery: 'The test store rebuilds from nothing.',
    validate: (parsed) => {
      const value = parsed as Partial<Shape> | null;
      if (!value || value.version !== 1 || !Array.isArray(value.items)) {
        throw new Error('store is missing the expected version 1 shape or an items array');
      }
      return { version: 1, items: value.items };
    },
  });
}

function siblings(dir: string, path: string, infix: string): string[] {
  const prefix = `${basename(path)}.${infix}`;
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && !name.endsWith('.why'));
}

/** Valid JSON followed by two NUL bytes, the zero-tail a torn write leaves. */
function zeroTailed(): Buffer {
  const json = `${JSON.stringify({ version: 1, items: ['a'] }, null, 2)}\n`;
  return Buffer.concat([Buffer.from(json, 'utf-8'), Buffer.from([0, 0])]);
}

/** JSON cut in half, the other shape a crash mid-write leaves. */
function truncated(): string {
  const json = JSON.stringify({ version: 1, items: ['a', 'b', 'c'] }, null, 2);
  return json.slice(0, Math.floor(json.length / 2));
}

describe('atomic write', () => {
  test('a write round-trips and leaves no temp file behind', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');

    writeJsonFileAtomic(path, { version: 1, items: ['a', 'b'] });

    expect(loadShape(path)).toEqual({ version: 1, items: ['a', 'b'] });
    expect(siblings(dir, path, 'tmp-')).toEqual([]);
  });

  test('a second write replaces the first whole — no mixture of the two is ever on disk', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');

    writeJsonFileAtomic(path, { version: 1, items: ['first'] });
    writeJsonFileAtomic(path, { version: 1, items: ['second'] });

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('second');
    expect(content).not.toContain('first');
    expect(siblings(dir, path, 'tmp-')).toEqual([]);
  });

  test('a stale temp file from a previous crash is swept by the next write', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });
    const stale = `${path}.tmp-999999`;
    writeFileSync(stale, 'half a write from a process that died', 'utf-8');
    // Aged past the safety window, because age is what tells a crash leftover
    // apart from another writer's file still being written, see
    // atomic-write-concurrency.test.ts for the crash that taught this.
    const longAgo = new Date(Date.now() - (STALE_TEMP_FILE_MIN_AGE_MS + 60_000));
    utimesSync(stale, longAgo, longAgo);

    writeJsonFileAtomic(path, { version: 1, items: ['fresh'] });

    expect(existsSync(stale)).toBe(false);
    expect(siblings(dir, path, 'tmp-')).toEqual([]);
  });

  test('parent directories are created as needed', () => {
    const path = join(storeDir(), 'nested', 'deeper', 'store.json');

    writeJsonFileAtomic(path, { version: 1, items: ['deep'] });

    expect(loadShape(path)!.items).toEqual(['deep']);
  });

  test('the file mode is exactly what was asked for, whatever the umask is', () => {
    const dir = storeDir();
    const ownerOnly = join(dir, 'private.json');
    const readable = join(dir, 'public.json');

    writeJsonFileAtomic(ownerOnly, { version: 1, items: [] });
    writeJsonFileAtomic(readable, { version: 1, items: [] }, { mode: 0o644 });

    expect(statSync(ownerOnly).mode & 0o777).toBe(0o600);
    expect(statSync(readable).mode & 0o777).toBe(0o644);
  });

  test('a rewrite keeps the requested mode rather than inheriting the old file\'s', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');

    writeJsonFileAtomic(path, { version: 1, items: ['one'] }, { mode: 0o644 });
    writeJsonFileAtomic(path, { version: 1, items: ['two'] }, { mode: 0o600 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('writeFileAtomic carries arbitrary text, for the stores that are not JSON', () => {
    const dir = storeDir();
    const path = join(dir, 'wrapper.sh');

    writeFileAtomic(path, '#!/usr/bin/env bash\necho hi\n', { mode: 0o755 });

    expect(readFileSync(path, 'utf-8')).toBe('#!/usr/bin/env bash\necho hi\n');
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(siblings(dir, path, 'tmp-')).toEqual([]);
  });

  test('the serialized form is controllable: compact, and without a trailing newline', () => {
    const dir = storeDir();
    const pretty = join(dir, 'pretty.json');
    const compact = join(dir, 'compact.json');

    writeJsonFileAtomic(pretty, { a: 1 });
    writeJsonFileAtomic(compact, { a: 1 }, { indent: null, trailingNewline: false });

    expect(readFileSync(pretty, 'utf-8')).toBe('{\n  "a": 1\n}\n');
    expect(readFileSync(compact, 'utf-8')).toBe('{"a":1}');
  });
});

describe('quarantine-don\'t-crash load', () => {
  test('a missing file reads as absent and leaves nothing behind', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');

    expect(loadShape(path)).toBeNull();
    expect(siblings(dir, path, 'corrupt-')).toEqual([]);
  });

  test('a zero-tailed file reads as absent, is moved aside with a receipt, and the store rebuilds clean', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, zeroTailed());

    expect(loadShape(path)).toBeNull();
    expect(existsSync(path)).toBe(false); // moved aside, not left to be read again

    const quarantined = siblings(dir, path, 'corrupt-');
    expect(quarantined.length).toBe(1);
    const why = readFileSync(join(dir, `${quarantined[0]}.why`), 'utf-8');
    expect(why).toContain('failed to load');
    expect(why).toContain('rebuilds from nothing');

    writeJsonFileAtomic(path, { version: 1, items: ['after'] });
    expect(loadShape(path)).toEqual({ version: 1, items: ['after'] });
    expect(siblings(dir, path, 'tmp-')).toEqual([]);
  });

  test('a truncated-mid-JSON file is quarantined the same way', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, truncated(), 'utf-8');

    expect(loadShape(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(siblings(dir, path, 'corrupt-').length).toBe(1);
  });

  test('the quarantined bytes are preserved exactly — evidence, not a deletion', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });
    const original = zeroTailed();
    writeFileSync(path, original);

    loadShape(path);

    const quarantined = siblings(dir, path, 'corrupt-');
    expect(readFileSync(join(dir, quarantined[0]!)).toString('base64')).toBe(original.toString('base64'));
  });

  test('content that parses but is the wrong shape is quarantined, not accepted', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, items: [] }), 'utf-8');

    expect(loadShape(path)).toBeNull();
    expect(siblings(dir, path, 'corrupt-').length).toBe(1);
  });

  test('quarantine files are bounded, oldest reaped first, with no orphaned receipts', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });

    for (let i = 0; i < CORRUPT_QUARANTINE_MAX_FILES + 3; i += 1) {
      writeFileSync(path, `not json at all #${i}`, 'utf-8');
      expect(loadShape(path)).toBeNull();
    }

    const remaining = siblings(dir, path, 'corrupt-');
    expect(remaining.length).toBeLessThanOrEqual(CORRUPT_QUARANTINE_MAX_FILES);
    for (const name of remaining) {
      expect(existsSync(join(dir, `${name}.why`))).toBe(true);
    }
    const receipts = readdirSync(dir)
      .filter((name) => name.startsWith(`${basename(path)}.corrupt-`) && name.endsWith('.why'));
    expect(receipts.length).toBe(remaining.length);
  });

  test('the reap is disclosed in the receipt that triggered it', () => {
    const dir = storeDir();
    const path = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });

    for (let i = 0; i < CORRUPT_QUARANTINE_MAX_FILES + 2; i += 1) {
      writeFileSync(path, `garbage #${i}`, 'utf-8');
      loadShape(path);
    }

    const receipts = readdirSync(dir)
      .filter((name) => name.endsWith('.why'))
      .map((name) => readFileSync(join(dir, name), 'utf-8'));
    expect(receipts.some((text) => text.includes('were deleted'))).toBe(true);
  });

  test('a read failure that leaves nothing to quarantine propagates rather than reading as absent', () => {
    const dir = storeDir();
    const path = join(dir, 'a-directory-where-a-file-belongs.json');
    mkdirSync(path, { recursive: true });

    expect(() => loadShape(path)).toThrow();
  });

  test('quarantineCorruptFile is usable directly, for stores that parse in stages', () => {
    const dir = storeDir();
    const path = join(dir, 'staged.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{"outer":"parses fine but the inner stage did not"}', 'utf-8');

    quarantineCorruptFile(path, {
      label: 'test/staged',
      reason: 'the inner payload did not decode',
      recovery: 'The staged store starts empty.',
    });

    expect(existsSync(path)).toBe(false);
    const quarantined = siblings(dir, path, 'corrupt-');
    expect(quarantined.length).toBe(1);
    expect(readFileSync(join(dir, `${quarantined[0]}.why`), 'utf-8')).toContain('the inner payload did not decode');
  });
});
