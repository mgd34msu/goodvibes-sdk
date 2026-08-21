/**
 * session-spine-legacy-fold-marker.test.ts
 *
 * Regression evidence that `foldLegacySpineStore`'s completion marker is trusted
 * by CONTENT, never by existence.
 *
 * The defect: the fold was guarded by `if (existsSync(markerPath)) return`. A
 * crash between creating that file and finishing its write leaves a zero-byte or
 * truncated marker that `existsSync` happily accepts, and the surface's legacy
 * `sessions.json` is then never folded into the daemon again, the user's old
 * sessions are stranded permanently, silently.
 *
 * These tests pin the replacement contract: empty / torn / non-object / bare-true
 * / missing-`completed` / older-schema markers all force the (idempotent,
 * upsert-based) fold to RE-RUN and say why; a valid marker still short-circuits;
 * a NEWER schema is accepted so a downgrade does not re-fold on every boot; and a
 * successful write leaves no temp file behind.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  foldLegacySpineStore,
  type SessionSpineRecord,
} from '../packages/sdk/src/platform/runtime/session-spine/index.ts';

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn';
  readonly message: string;
  readonly data?: Record<string, unknown> | undefined;
}

function recordingLog(): { readonly entries: CapturedLog[]; readonly debug: (m: string, d?: Record<string, unknown>) => void; readonly info: (m: string, d?: Record<string, unknown>) => void; readonly warn: (m: string, d?: Record<string, unknown>) => void } {
  const entries: CapturedLog[] = [];
  return {
    entries,
    debug: (message, data) => entries.push({ level: 'debug', message, data }),
    info: (message, data) => entries.push({ level: 'info', message, data }),
    warn: (message, data) => entries.push({ level: 'warn', message, data }),
  };
}

function recordingClient(): { readonly folded: SessionSpineRecord[][]; foldLegacyRecords(records: readonly SessionSpineRecord[], closedIds: ReadonlySet<string>): void } {
  const folded: SessionSpineRecord[][] = [];
  return {
    folded,
    foldLegacyRecords(records: readonly SessionSpineRecord[]): void {
      folded.push([...records]);
    },
  };
}

/** A fresh working directory holding a two-session legacy store and a marker path. */
function fixture(): { readonly dir: string; readonly storePath: string; readonly markerPath: string } {
  const dir = join(tmpdir(), `gv-spine-fold-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const storePath = join(dir, 'sessions.json');
  writeFileSync(
    storePath,
    JSON.stringify({
      sessions: {
        's-one': { id: 's-one', title: 'first', status: 'active' },
        's-two': { id: 's-two', title: 'second', status: 'closed' },
      },
    }),
    'utf-8',
  );
  return { dir, storePath, markerPath: join(dir, '.spine-folded') };
}

function foldOnce(fx: ReturnType<typeof fixture>) {
  const client = recordingClient();
  const log = recordingLog();
  const result = foldLegacySpineStore(client, {
    storePath: fx.storePath,
    markerPath: fx.markerPath,
    project: '/project',
    now: () => 1_700_000_000_000,
    log,
  });
  return { client, log, result };
}

/**
 * A marker whose inode a filesystem recovered but whose data it did not, the
 * classic post-crash carcass that `existsSync` reports as a finished migration.
 * Built from char codes rather than written literally so this source file stays
 * plain text.
 */
const NUL_PAGE = String.fromCharCode(0).repeat(64);

/** Every marker state that must NOT be believed, each with the disclosure it owes. */
const REJECTED_MARKERS: readonly { readonly label: string; readonly body: string; readonly reason: string }[] = [
  { label: 'zero-byte (interrupted write)', body: '', reason: 'empty' },
  { label: 'whitespace only', body: '   \n', reason: 'empty' },
  { label: 'torn / truncated JSON', body: '{"schemaVersion":1,"completed":tr', reason: 'not parseable JSON' },
  { label: 'a page of NULs left by a recovered inode', body: NUL_PAGE, reason: 'not parseable JSON' },
  { label: 'an array, not an object', body: '[]', reason: 'not an object' },
  { label: 'a bare true', body: 'true', reason: 'not an object' },
  { label: 'JSON null', body: 'null', reason: 'not an object' },
  { label: 'the OLD schema-less shape', body: JSON.stringify({ migratedAt: 1, count: 2, source: '/x' }), reason: 'does not assert completion' },
  { label: 'completion flag missing', body: JSON.stringify({ schemaVersion: 1, migratedAt: 1, count: 2 }), reason: 'does not assert completion' },
  { label: 'completion flag not literally true', body: JSON.stringify({ schemaVersion: 1, completed: 'yes' }), reason: 'does not assert completion' },
  { label: 'no usable schema version', body: JSON.stringify({ schemaVersion: 'one', completed: true }), reason: 'no usable schema version' },
  { label: 'a NaN schema version', body: '{"schemaVersion":null,"completed":true}', reason: 'no usable schema version' },
  { label: 'an OLDER schema version', body: JSON.stringify({ schemaVersion: 0, completed: true }), reason: 'older schema' },
];

describe('session spine legacy fold marker — validated by content, not existence', () => {
  for (const scenario of REJECTED_MARKERS) {
    test(`re-folds when the marker is ${scenario.label}`, () => {
      const fx = fixture();
      writeFileSync(fx.markerPath, scenario.body, 'utf-8');

      const { client, log, result } = foldOnce(fx);

      expect(result.skipped).toBe(false);
      expect(result.folded).toBe(2);
      expect(client.folded).toHaveLength(1);
      expect(client.folded[0]?.map((r) => r.sessionId).sort()).toEqual(['s-one', 's-two']);

      // The re-run reason is disclosed at warn level, a silently repeated
      // migration is as opaque as a silently skipped one.
      const warned = log.entries.filter((e) => e.level === 'warn');
      expect(warned).toHaveLength(1);
      expect(warned[0]?.message).toContain(scenario.reason);
      expect(warned[0]?.data?.marker).toBe(fx.markerPath);

      // Having re-folded, it repairs the marker: the next boot short-circuits.
      expect(foldOnce(fx).result).toEqual({ folded: 0, skipped: true });
    });
  }

  test('a valid marker still short-circuits the fold entirely', () => {
    const fx = fixture();
    const first = foldOnce(fx);
    expect(first.result).toEqual({ folded: 2, skipped: false });

    const second = foldOnce(fx);
    expect(second.result).toEqual({ folded: 0, skipped: true });
    expect(second.client.folded).toHaveLength(0);
    // A believed marker is not an anomaly: nothing is warned about.
    expect(second.log.entries.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  test('a NEWER schema version is accepted so a downgrade does not re-fold every boot', () => {
    const fx = fixture();
    writeFileSync(
      fx.markerPath,
      JSON.stringify({ schemaVersion: 99, completed: true, migratedAt: 1, count: 7, source: fx.storePath }),
      'utf-8',
    );

    const { client, log, result } = foldOnce(fx);

    expect(result).toEqual({ folded: 0, skipped: true });
    expect(client.folded).toHaveLength(0);
    expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  test('the written marker asserts its own completion, schema, count and source', () => {
    const fx = fixture();
    foldOnce(fx);

    const parsed: unknown = JSON.parse(readFileSync(fx.markerPath, 'utf-8'));
    expect(parsed).toEqual({
      schemaVersion: 1,
      completed: true,
      migratedAt: 1_700_000_000_000,
      count: 2,
      source: fx.storePath,
    });
  });

  test('a successful marker write leaves no temp file behind', () => {
    const fx = fixture();
    foldOnce(fx);

    expect(readdirSync(fx.dir).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(readdirSync(fx.dir).sort()).toEqual(['.spine-folded', 'sessions.json']);
  });

  test('the marker survives a re-read as a complete file rather than a bare timestamp', () => {
    // Guards the exact regression: the pre-fix marker held only
    // {migratedAt,count,source} with no completion assertion, which the new
    // reader must (and does, above) reject. Prove the writer no longer emits it.
    const fx = fixture();
    foldOnce(fx);
    const raw = readFileSync(fx.markerPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('"completed": true');
  });

  test('an unreadable or absent legacy store still writes NO marker, so a later real store folds', () => {
    const dir = join(tmpdir(), `gv-spine-fold-missing-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, 'sessions.json');
    const markerPath = join(dir, '.spine-folded');

    const absent = foldLegacySpineStore(recordingClient(), {
      storePath,
      markerPath,
      project: '/project',
      log: recordingLog(),
    });
    expect(absent).toEqual({ folded: 0, skipped: false });
    expect(readdirSync(dir)).toEqual([]);

    // The store shows up later; the fold must still happen.
    writeFileSync(storePath, JSON.stringify({ sessions: { 's-late': { id: 's-late' } } }), 'utf-8');
    const client = recordingClient();
    const later = foldLegacySpineStore(client, { storePath, markerPath, project: '/project', log: recordingLog() });
    expect(later).toEqual({ folded: 1, skipped: false });
    expect(client.folded[0]?.[0]?.sessionId).toBe('s-late');
  });

  test('a two-method log sink (no warn) still gets the disclosure, at info', () => {
    // Surfaces outside this repo pass {debug, info} literals; the re-run reason
    // must not vanish just because the injected sink predates the warn slot.
    const fx = fixture();
    writeFileSync(fx.markerPath, '', 'utf-8');
    const entries: CapturedLog[] = [];
    const twoMethodSink = {
      debug: (message: string, data?: Record<string, unknown>) => entries.push({ level: 'debug', message, data }),
      info: (message: string, data?: Record<string, unknown>) => entries.push({ level: 'info', message, data }),
    };

    const result = foldLegacySpineStore(recordingClient(), {
      storePath: fx.storePath,
      markerPath: fx.markerPath,
      project: '/project',
      log: twoMethodSink,
    });

    expect(result).toEqual({ folded: 2, skipped: false });
    expect(entries.filter((e) => e.level === 'info' && e.message.includes('empty'))).toHaveLength(1);
  });
});
