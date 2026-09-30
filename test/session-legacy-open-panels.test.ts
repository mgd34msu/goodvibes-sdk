/**
 * The terminal no longer has side panes. A session saved while it did carries
 * returnContext.openPanels and an "Open panels: …" summary line. Such a file
 * loads, the pane list is not shown, and saving the session again (or
 * rebuilding its return context) never writes it back.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../packages/sdk/src/platform/sessions/manager.ts';
import { buildLocalReturnContextSummary, formatReturnContextForDisplay, loadedReturnContext } from '../packages/sdk/src/platform/runtime/session-return-context.ts';

const LEGACY_META = {
  type: 'meta',
  title: 'Retry work',
  model: 'm',
  provider: 'p',
  timestamp: 1_700_000_000_000,
  titleSource: 'user',
  schemaVersion: 1,
  returnContext: {
    activityLabel: 'assistant replied',
    statusLabel: 'ready for next turn',
    pendingApprovals: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    assistantTurnCount: 1,
    userTurnCount: 1,
    lines: ['Activity: assistant replied', 'Status: ready for next turn', 'Open panels: sessions, git, fleet'],
    openPanels: ['sessions', 'git', 'fleet'],
  },
};

describe('a session saved with the legacy open-pane list', () => {
  test('loads, shows no pane list, and is saved again without it', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-panes-'));
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'retry-work.jsonl'), [
      JSON.stringify(LEGACY_META),
      JSON.stringify({ type: 'message', role: 'user', content: 'cap the retry delay' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.' }),
    ].join('\n') + '\n');
    const manager = new SessionManager(root, { sessionsDir });

    const loaded = manager.load('retry-work');
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.meta.returnContext?.activityLabel).toBe('assistant replied');
    expect(loaded.meta.returnContext && 'openPanels' in loaded.meta.returnContext).toBe(false);
    expect(formatReturnContextForDisplay(loaded.meta.returnContext)).toEqual(['Activity: assistant replied', 'Status: ready for next turn']);
    expect(manager.list().find((info) => info.name === 'retry-work')).toBeDefined();

    manager.save('retry-work', loaded.messages, loaded.meta);
    const written = readFileSync(join(sessionsDir, 'retry-work.jsonl'), 'utf8');
    expect(written).not.toContain('openPanels');
    expect(written).not.toContain('Open panels');
    expect(manager.load('retry-work').meta.returnContext?.lines).toEqual(['Activity: assistant replied', 'Status: ready for next turn']);
  });

  test('renaming it rewrites the file without the pane list', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-panes-rename-'));
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'retry-work.jsonl'), `${JSON.stringify(LEGACY_META)}\n${JSON.stringify({ type: 'message', role: 'user', content: 'hi' })}\n`);
    const manager = new SessionManager(root, { sessionsDir });
    manager.rename('retry-work', 'Retry work, renamed');
    const written = readFileSync(join(sessionsDir, 'retry-work.jsonl'), 'utf8');
    expect(written).toContain('Retry work, renamed');
    expect(written).not.toContain('openPanels');
    expect(written).not.toContain('Open panels');
    expect(manager.load('retry-work').messages).toHaveLength(1);
  });

  test('a rebuilt return context never carries a pane list, whatever the hints hold', () => {
    const hints = { activeTasks: 1, openPanels: ['git'] } as unknown as Parameters<typeof buildLocalReturnContextSummary>[1];
    const summary = buildLocalReturnContextSummary([{ role: 'user', content: 'hi' }] as never, hints);
    expect('openPanels' in summary).toBe(false);
    expect(summary.lines.some((line) => line.startsWith('Open panels'))).toBe(false);
  });

  test('anything that is not a return context loads as none', () => {
    expect(loadedReturnContext(null)).toBeUndefined();
    expect(loadedReturnContext('x')).toBeUndefined();
    expect(loadedReturnContext([])).toBeUndefined();
  });
});
