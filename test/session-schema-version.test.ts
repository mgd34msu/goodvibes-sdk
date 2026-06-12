import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, CURRENT_SESSION_SCHEMA_VERSION } from '../packages/sdk/src/platform/sessions/manager.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-schema-'));
}

const SAMPLE_META = {
  title: 'Test Session',
  model: 'claude:test',
  provider: 'anthropic',
  timestamp: 1_700_000_000_000,
  titleSource: 'system' as const,
};

const SAMPLE_MESSAGES = [{ role: 'user', content: 'hello' }];

describe('SessionManager schemaVersion', () => {
  test('saved files contain schemaVersion in meta line', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const { filePath } = mgr.save('test-session', SAMPLE_MESSAGES, SAMPLE_META);

      const raw = readFileSync(filePath, 'utf-8');
      const firstLine = raw.split('\n')[0]!;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;

      expect(parsed.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
      expect(parsed.type).toBe('meta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('load() returns schemaVersion from saved file', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('versioned', SAMPLE_MESSAGES, SAMPLE_META);
      const { meta } = mgr.load('versioned');

      expect(meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy files without schemaVersion load successfully (backward compat)', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      // Write a legacy file that has no schemaVersion field
      const legacyMeta = JSON.stringify({
        type: 'meta',
        timestamp: 1_000_000_000_000,
        title: 'Legacy',
        model: 'legacy-model',
        provider: 'legacy-provider',
        titleSource: 'system',
      });
      const legacyMsg = JSON.stringify({ type: 'message', role: 'user', content: 'old message' });
      writeFileSync(join(dir, 'legacy.jsonl'), `${legacyMeta}\n${legacyMsg}\n`, 'utf-8');

      const { meta, messages } = mgr.load('legacy');

      // Should load successfully with schemaVersion defaulted to 0
      expect(meta.title).toBe('Legacy');
      expect(meta.model).toBe('legacy-model');
      expect(meta.schemaVersion).toBe(0);
      expect(messages).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('future schemaVersion files load with a warning but do not throw', () => {
    const dir = makeTmpDir();
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const originalWarn = logger.warn.bind(logger);
    const mutableLogger = logger as unknown as {
      warn(msg: string, data?: Record<string, unknown>): void;
    };
    mutableLogger.warn = (msg, data) => warnings.push({ message: msg, data });

    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const futureVersion = CURRENT_SESSION_SCHEMA_VERSION + 99;
      const futureMeta = JSON.stringify({
        type: 'meta',
        schemaVersion: futureVersion,
        timestamp: 1_000_000_000_000,
        title: 'Future',
        model: 'future-model',
        provider: 'future-provider',
        titleSource: 'user',
      });
      const futureMsg = JSON.stringify({ type: 'message', role: 'assistant', content: 'future content' });
      writeFileSync(join(dir, 'future.jsonl'), `${futureMeta}\n${futureMsg}\n`, 'utf-8');

      let meta: ReturnType<typeof mgr.load>['meta'];
      let messages: ReturnType<typeof mgr.load>['messages'];

      expect(() => {
        const result = mgr.load('future');
        meta = result.meta;
        messages = result.messages;
      }).not.toThrow();

      // Data should be best-effort parsed
      expect(meta!.title).toBe('Future');
      expect(meta!.schemaVersion).toBe(futureVersion);
      expect(messages!).toHaveLength(1);

      // A warning should have been logged
      const warnEntry = warnings.find(w =>
        w.message.includes('newer schemaVersion') &&
        w.data?.fileVersion === futureVersion &&
        w.data?.currentVersion === CURRENT_SESSION_SCHEMA_VERSION
      );
      expect(warnEntry).toBeDefined();
    } finally {
      mutableLogger.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getMeta() returns schemaVersion', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('meta-check', SAMPLE_MESSAGES, SAMPLE_META);
      const meta = mgr.getMeta('meta-check');

      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getMeta() returns schemaVersion 0 for legacy files', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const legacyMeta = JSON.stringify({
        type: 'meta',
        timestamp: 1_000_000_000_000,
        title: 'OldSession',
        model: 'm',
        provider: 'p',
        titleSource: 'system',
      });
      writeFileSync(join(dir, 'old.jsonl'), `${legacyMeta}\n`, 'utf-8');

      const meta = mgr.getMeta('old');
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list() returns entries and getMeta() exposes schemaVersion for each', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('list-check', SAMPLE_MESSAGES, SAMPLE_META);
      const sessions = mgr.list();

      expect(sessions).toHaveLength(1);
      // SessionInfo itself does not carry schemaVersion (it is not part of the listing shape);
      // getMeta() is the accessor that exposes it for a named session.
      const meta = mgr.getMeta(sessions[0]!.name);
      expect(meta).not.toBeNull();
      expect(meta!.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);

      // load() also propagates schemaVersion
      const loaded = mgr.load('list-check');
      expect(loaded.meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rename() preserves schemaVersion in meta line', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      mgr.save('to-rename', SAMPLE_MESSAGES, SAMPLE_META);
      mgr.rename('to-rename', 'Renamed Title');

      const { meta } = mgr.load('to-rename');
      expect(meta.title).toBe('Renamed Title');
      expect(meta.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CURRENT_SESSION_SCHEMA_VERSION is exported and equals 1', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(1);
  });

  test('atomic write: saved file exists and is not a tmp file', () => {
    const dir = makeTmpDir();
    try {
      const mgr = new SessionManager('/unused', { sessionsDir: dir });
      const { filePath, sanitizedName } = mgr.save('atomic-test', SAMPLE_MESSAGES, SAMPLE_META);

      expect(existsSync(filePath)).toBe(true);
      expect(filePath).toEndWith(`${sanitizedName}.jsonl`);
      // No lingering .tmp- files
      const files = readdirSync(dir);
      expect(files.filter(f => f.startsWith('.tmp-'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
