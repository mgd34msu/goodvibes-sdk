/**
 * at-rest-redaction.test.ts
 *
 * The redaction + retention policy for the two raw-content on-disk writers:
 * the transcript journal (agents/session.ts) and the local execution ledger
 * (runtime/telemetry/exporters/local-ledger.ts). Proves secrets are masked at
 * WRITE time (reusing the shared pattern set), retention caps are enforced at a
 * production-called point, config keys resolve with honest defaults, and the
 * replay debug path keeps working against redacted records.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  redactAtRestLine,
  resolveAtRestPolicy,
  enforceFileRetention,
  DEFAULT_AT_REST_POLICY,
  AT_REST_CONFIG_KEYS,
} from '../packages/sdk/src/platform/runtime/at-rest-persistence.ts';
import { AgentSession } from '../packages/sdk/src/platform/agents/session.ts';
import { LocalLedgerExporter } from '../packages/sdk/src/platform/runtime/telemetry/exporters/local-ledger.ts';

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-atrest-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('redactAtRestLine — masks secrets, preserves content, stays valid JSON', () => {
  test('masks known credential shapes but leaves ordinary content intact', () => {
    const line = JSON.stringify({
      role: 'user',
      body: 'run with token sk-ABCDEFGHIJKLMNOPQRSTUVWX and Authorization: Bearer abcdef.ghijkl',
      ghToken: 'ghp_0123456789012345678901234567890123456789',
    });
    const out = redactAtRestLine(line);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).toContain('[REDACTED_TOKEN]');
    expect(out).toContain('[REDACTED_GITHUB_TOKEN]');
    // Non-secret content survives, and the result is still parseable JSON.
    const parsed = JSON.parse(out) as { role: string; body: string };
    expect(parsed.role).toBe('user');
    expect(parsed.body).toContain('run with token');
  });
});

describe('resolveAtRestPolicy — honest defaults + config overrides', () => {
  test('no getter -> redaction on, generous bounded retention', () => {
    expect(resolveAtRestPolicy()).toEqual(DEFAULT_AT_REST_POLICY);
    expect(DEFAULT_AT_REST_POLICY.redact).toBe(true);
    expect(DEFAULT_AT_REST_POLICY.retention.maxAgeMs).toBeGreaterThan(0);
  });

  test('config getter overrides redaction + retention', () => {
    const cfg: Record<string, unknown> = {
      [AT_REST_CONFIG_KEYS.redactEnabled]: false,
      [AT_REST_CONFIG_KEYS.maxAgeDays]: 2,
      [AT_REST_CONFIG_KEYS.maxTotalMb]: 5,
    };
    const policy = resolveAtRestPolicy((key) => cfg[key]);
    expect(policy.redact).toBe(false);
    expect(policy.retention.maxAgeMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(policy.retention.maxTotalBytes).toBe(5 * 1024 * 1024);
  });

  test('a throwing/invalid getter falls back to defaults, never propagates', () => {
    const policy = resolveAtRestPolicy(() => undefined);
    expect(policy).toEqual(DEFAULT_AT_REST_POLICY);
  });
});

describe('enforceFileRetention — age + size caps, oldest-first', () => {
  test('deletes files older than the age cap', () => {
    const dir = mkTemp();
    const oldFile = join(dir, 'old.jsonl');
    const freshFile = join(dir, 'fresh.jsonl');
    writeFileSync(oldFile, 'x\n');
    writeFileSync(freshFile, 'y\n');
    const old = Date.now() / 1000 - 100 * 24 * 60 * 60;
    utimesSync(oldFile, old, old);
    const outcome = enforceFileRetention([oldFile, freshFile], {
      redact: true,
      retention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxTotalBytes: 1024 * 1024 },
    });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    expect(outcome.deletedFiles).toContain(oldFile);
  });

  test('enforces the total-size cap oldest-first', () => {
    const dir = mkTemp();
    const older = join(dir, 'a.jsonl');
    const newer = join(dir, 'b.jsonl');
    writeFileSync(older, 'a'.repeat(2000));
    writeFileSync(newer, 'b'.repeat(2000));
    const t = Date.now() / 1000;
    utimesSync(older, t - 100, t - 100);
    utimesSync(newer, t, t);
    enforceFileRetention([older, newer], {
      redact: true,
      retention: { maxAgeMs: Number.MAX_SAFE_INTEGER, maxTotalBytes: 2500 },
    });
    // Oldest removed first to get under the 2500-byte cap.
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });
});

describe('AgentSession transcript journal — redaction at write', () => {
  test('a secret in a message is masked in the on-disk journal', () => {
    const dir = mkTemp();
    const session = new AgentSession('agent-1', 'm', 'p', { sessionsDir: dir, stateDir: dir });
    session.appendMessage({ role: 'user', body: 'key is sk-ABCDEFGHIJKLMNOPQRSTUVWX now' });
    const contents = readFileSync(join(dir, 'agent-1.jsonl'), 'utf8');
    expect(contents).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(contents).toContain('[REDACTED_API_KEY]');
  });

  test('redaction can be disabled by policy (opt-out)', () => {
    const dir = mkTemp();
    const session = new AgentSession('agent-2', 'm', 'p', { sessionsDir: dir, stateDir: dir }, {
      redact: false,
      retention: DEFAULT_AT_REST_POLICY.retention,
    });
    session.appendMessage({ body: 'ghp_0123456789012345678901234567890123456789' });
    const contents = readFileSync(join(dir, 'agent-2.jsonl'), 'utf8');
    expect(contents).toContain('ghp_0123456789012345678901234567890123456789');
  });

  test('constructing a session prunes stale sibling journals (retention enforcement point)', () => {
    const dir = mkTemp();
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, 'old\n');
    const old = Date.now() / 1000 - 100 * 24 * 60 * 60;
    utimesSync(stale, old, old);
    // New session with a tight age cap prunes the stale journal on construction.
    new AgentSession('agent-3', 'm', 'p', { sessionsDir: dir, stateDir: dir }, {
      redact: true,
      retention: { maxAgeMs: 24 * 60 * 60 * 1000, maxTotalBytes: 1024 * 1024 },
    });
    expect(readdirSync(dir)).not.toContain('stale.jsonl');
  });
});

describe('LocalLedgerExporter execution ledger — redaction + replay', () => {
  test('recordEvent masks secrets, and readRunEntries returns the redacted record', () => {
    const dir = mkTemp();
    const exporter = new LocalLedgerExporter({
      filePath: join(dir, 'spans.jsonl'),
      ledgerFilePath: join(dir, 'run.ledger.jsonl'),
    });
    exporter.recordEvent({
      runId: 'run-1',
      rev: 1,
      eventName: 'TOOL_RESULT',
      payload: { output: 'token sk-ABCDEFGHIJKLMNOPQRSTUVWX printed' },
      ts: Date.now(),
    });
    const raw = readFileSync(join(dir, 'run.ledger.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(raw).toContain('[REDACTED_API_KEY]');
    // Replay reads the redacted record fine — content shows the marker.
    const entries = exporter.readRunEntries('run-1');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.payload)).toContain('[REDACTED_API_KEY]');
  });
});
