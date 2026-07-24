/**
 * retention-user-saved-exemption.test.ts — the session-conversations append-only
 * store (runtime/retention/append-only-registry.ts) never reclaims a session the
 * user explicitly saved.
 *
 * Defect class this guards against: a bounded retention sweep over the sessions/
 * directory that does not distinguish "the user asked to keep this" from "this
 * was an automatic save" would eventually delete a saved conversation out from
 * under the user. saveSource ('user' | 'auto', sessions/manager.ts SessionManager.save)
 * is the signal; a file with saveSource 'auto' is reclaimable under the bounded
 * default policy, a file with saveSource 'user' — or any pre-upgrade file with no
 * saveSource at all — is exempt, permanently, regardless of age or size pressure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAppendOnlyRetentionSweep } from '../packages/sdk/src/platform/runtime/retention/append-only-registry.ts';
import { resolveScopedDirectory } from '../packages/sdk/src/platform/runtime/surface-root.ts';
import { SessionManager } from '../packages/sdk/src/platform/sessions/manager.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `gv-retention-usersave-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A tiny, bounded policy so a single old file is enough to trigger reclaim. */
const TIGHT_POLICY = {
  redact: true,
  retention: { maxAgeMs: 24 * 3600 * 1000, maxTotalBytes: 10_000_000 },
} as const;

function ageFile(path: string, daysOld: number): void {
  const past = Date.now() / 1000 - daysOld * 24 * 3600;
  utimesSync(path, past, past);
}

describe('session-conversations store: user-saved sessions are exempt from reclaim', () => {
  test('an old saveSource "auto" file is reclaimed by the sweep', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    const mgr = new SessionManager(workingDirectory, { sessionsDir });
    const { filePath } = mgr.save(
      'auto-saved',
      [{ role: 'user', content: 'hi' }],
      { title: '', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'auto' },
    );
    ageFile(filePath, 40);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot }, { policyOverride: TIGHT_POLICY });
    expect(outcome.sweptStores).toContain('session-conversations');
    expect(() => statSync(filePath)).toThrow();
  });

  test('an equally old saveSource "user" file is NEVER reclaimed, no matter the age', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    const mgr = new SessionManager(workingDirectory, { sessionsDir });
    const { filePath } = mgr.save(
      'user-saved',
      [{ role: 'user', content: 'keep me' }],
      { title: 'Important', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' },
    );
    ageFile(filePath, 400);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot }, { policyOverride: TIGHT_POLICY });
    expect(outcome.sweptStores).not.toContain('session-conversations');
    expect(statSync(filePath).isFile()).toBe(true);
  });

  test('a pre-upgrade file with no saveSource field at all is treated as "user" and never reclaimed', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const legacyPath = join(sessionsDir, 'pre-upgrade-session.jsonl');
    const legacyMeta = JSON.stringify({
      type: 'meta',
      timestamp: 1_000_000_000_000,
      title: 'Old conversation',
      model: 'legacy-model',
      provider: 'legacy-provider',
      titleSource: 'system',
      // No saveSource field — this file predates the saveSource concept.
    });
    writeFileSync(legacyPath, `${legacyMeta}\n${JSON.stringify({ type: 'message', role: 'user', content: 'hi' })}\n`, 'utf-8');
    ageFile(legacyPath, 400);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot }, { policyOverride: TIGHT_POLICY });
    expect(outcome.sweptStores).not.toContain('session-conversations');
    expect(statSync(legacyPath).isFile()).toBe(true);
  });

  test('mixed directory: the auto file is reclaimed, the user file and the unmarked legacy file survive', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    const mgr = new SessionManager(workingDirectory, { sessionsDir });

    const auto = mgr.save('auto-one', [{ role: 'user', content: 'a' }], { title: '', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'auto' }).filePath;
    const user = mgr.save('user-one', [{ role: 'user', content: 'b' }], { title: '', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' }).filePath;
    ageFile(auto, 40);
    ageFile(user, 40);
    const legacyPath = join(sessionsDir, 'no-savesource.jsonl');
    writeFileSync(legacyPath, `${JSON.stringify({ type: 'meta', timestamp: 1, title: '', model: 'm', provider: 'p' })}\n`, 'utf-8');
    ageFile(legacyPath, 40);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot }, { policyOverride: TIGHT_POLICY });
    expect(outcome.sweptStores).toContain('session-conversations');
    expect(() => statSync(auto)).toThrow();
    expect(statSync(user).isFile()).toBe(true);
    expect(statSync(legacyPath).isFile()).toBe(true);
  });
});

describe('session-journals store: a user session whose NAME collides with a journal filename shape', () => {
  /**
   * The legacy-journal sweep matched on filename alone, and
   * SessionManager.sanitizeName keeps underscores and the `agent-` prefix —
   * so a conversation the user saved as "release_workmap" or "agent-deadbeef"
   * produced a file indistinguishable BY NAME from a pre-repoint agent
   * journal, and the sweep deleted it. Classification is now name AND
   * first-line content.
   */
  function saveUserSession(workingDirectory: string, name: string): string {
    const mgr = new SessionManager(workingDirectory, { surfaceRoot: 'tui' });
    const { filePath } = mgr.save(
      name,
      [{ role: 'user', content: 'my precious conversation' }],
      { title: 'Notes', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' },
    );
    return filePath;
  }

  test('R3: an explicitly user-saved session named "release_workmap" survives the sweep', () => {
    const workingDirectory = tempDir();
    const filePath = saveUserSession(workingDirectory, 'release_workmap');
    ageFile(filePath, 90);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot: 'tui' });
    expect(outcome.deletedFiles).toBe(0);
    expect(statSync(filePath).isFile()).toBe(true);
  });

  test('a user-saved session named "agent-deadbeef" survives the sweep', () => {
    const workingDirectory = tempDir();
    const filePath = saveUserSession(workingDirectory, 'agent-deadbeef');
    ageFile(filePath, 90);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot: 'tui' });
    expect(outcome.deletedFiles).toBe(0);
    expect(statSync(filePath).isFile()).toBe(true);
  });

  test('a genuine legacy journal with the same name shape IS still swept', () => {
    const workingDirectory = tempDir();
    const sessionsDir = resolveScopedDirectory(workingDirectory, 'tui', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const journal = join(sessionsDir, 'agent-deadbeef.jsonl');
    writeFileSync(
      journal,
      JSON.stringify({ type: 'meta', agentId: 'agent-deadbeef', model: 'm', provider: 'p', title: '', timestamp: Date.now() }) + '\n',
      'utf-8',
    );
    const workmap = join(sessionsDir, 'release_workmap.jsonl');
    writeFileSync(
      workmap,
      JSON.stringify({ ts: new Date().toISOString(), wrfcId: 'release', event: 'chain_passed' }) + '\n',
      'utf-8',
    );
    ageFile(journal, 90);
    ageFile(workmap, 90);

    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot: 'tui' });
    expect(outcome.sweptStores).toContain('session-journals');
    expect(() => statSync(journal)).toThrow();
    expect(() => statSync(workmap)).toThrow();
  });

  test('an unreadable/ambiguous file with a journal-shaped name is left completely alone', () => {
    const workingDirectory = tempDir();
    const sessionsDir = resolveScopedDirectory(workingDirectory, 'tui', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const garbled = join(sessionsDir, 'aaaaaaaa_workmap.jsonl');
    writeFileSync(garbled, 'not json at all\n', 'utf-8');
    const empty = join(sessionsDir, 'agent-abcd1234.jsonl');
    writeFileSync(empty, '', 'utf-8');
    ageFile(garbled, 90);
    ageFile(empty, 90);

    runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot: 'tui' });
    // "When in doubt, leave it" — enforced, not merely promised.
    expect(statSync(garbled).isFile()).toBe(true);
    expect(statSync(empty).isFile()).toBe(true);
  });
});

describe('SessionManager.save: saveSource "user" is sticky', () => {
  test('an automatic save over a user-saved session keeps the "user" stamp and its retention exemption', () => {
    const workingDirectory = tempDir();
    const surfaceRoot = 'tui';
    const sessionsDir = resolveScopedDirectory(workingDirectory, surfaceRoot, 'sessions');
    const mgr = new SessionManager(workingDirectory, { sessionsDir });

    // The user explicitly saves...
    const { filePath } = mgr.save(
      'sticky-session',
      [{ role: 'user', content: 'keep me' }],
      { title: 'Important', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' },
    );
    expect(mgr.getMeta('sticky-session')?.saveSource).toBe('user');

    // ...then an ordinary automatic persist of the SAME session id lands
    // (persistConversation defaults to 'auto'). It must not downgrade the stamp.
    mgr.save(
      'sticky-session',
      [{ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'sure' }],
      { title: 'Important', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'auto' },
    );
    expect(mgr.getMeta('sticky-session')?.saveSource).toBe('user');

    // An omitted saveSource is equally non-downgrading.
    mgr.save(
      'sticky-session',
      [{ role: 'user', content: 'keep me' }],
      { title: 'Important', model: 'm', provider: 'p', timestamp: Date.now() },
    );
    expect(mgr.getMeta('sticky-session')?.saveSource).toBe('user');

    // And the retention exemption still holds after those automatic writes.
    ageFile(filePath, 400);
    const outcome = runAppendOnlyRetentionSweep({ workingDirectory, surfaceRoot }, { policyOverride: TIGHT_POLICY });
    expect(outcome.sweptStores).not.toContain('session-conversations');
    expect(statSync(filePath).isFile()).toBe(true);
  });

  test('an auto session stays auto, and an explicit user save still upgrades it', () => {
    const workingDirectory = tempDir();
    const sessionsDir = resolveScopedDirectory(workingDirectory, 'tui', 'sessions');
    const mgr = new SessionManager(workingDirectory, { sessionsDir });

    mgr.save('upgradable', [{ role: 'user', content: 'a' }], { title: '', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'auto' });
    expect(mgr.getMeta('upgradable')?.saveSource).toBe('auto');

    mgr.save('upgradable', [{ role: 'user', content: 'a' }], { title: '', model: 'm', provider: 'p', timestamp: Date.now(), saveSource: 'user' });
    expect(mgr.getMeta('upgradable')?.saveSource).toBe('user');
  });
});
