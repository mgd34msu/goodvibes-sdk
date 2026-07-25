/**
 * config-live-file-watch.test.ts — external edits apply live.
 *
 * A settings file changed by another process (or by hand) is reloaded and
 * surfaced through the same subscribe() pipeline an in-process set() uses, with
 * no restart. The custom-provider file watcher proves the fs mechanism; this
 * wires the config layer onto it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

const dirs: string[] = [];

function tempConfigDir(): string {
  const dir = join(tmpdir(), `gv-cfgwatch-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Poll cadence for the condition wait below. */
const WATCH_POLL_INTERVAL_MS = 50;
/**
 * Ceiling for waiting on the watcher's poll + reload. Generous on purpose: the
 * wait exits the instant the change surfaces, so a fast host pays nothing for
 * the headroom, while a loaded runner is no longer failed for being slow (the
 * previous fixed 4s budget flaked exactly that way). A watcher that never fires
 * still fails the test, with a message naming the condition.
 */
const WATCH_CEILING_MS = 60_000;
/** Per-test budget, above WATCH_CEILING_MS so the labelled diagnostic wins over bun's opaque timeout. */
const WATCH_TEST_TIMEOUT_MS = 90_000;

/**
 * Polls until the predicate holds; throws a labelled error only if it never
 * does.
 *
 * Deliberately has NO "nudge" hook. An earlier revision re-saved the edit
 * before every poll, which hid a real product bug: fs.watchFile takes its
 * baseline stat asynchronously, so a write landing during watcher startup
 * became the baseline and the watcher never fired again. Re-saving handed the
 * watcher a change it could not have baselined away, turning a permanently
 * silent watcher green. The watcher now owns its baseline synchronously
 * (config-file-watcher.ts), so a single write is enough — and these tests
 * write exactly once, which is what makes them able to catch a regression.
 */
async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > WATCH_CEILING_MS) {
      throw new Error(`config live watch: ${label} never happened (waited ${elapsedMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_INTERVAL_MS));
  }
}

describe('config live file watch', () => {
  test('an external edit to a watched file surfaces through a subscription', async () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    // Seed an explicit value so the file exists to be watched.
    manager.set('provider.model', 'openai:start');

    const seen: Array<{ oldValue: unknown; newValue: unknown }> = [];
    manager.subscribe('provider.model', (newValue, oldValue) => {
      seen.push({ oldValue, newValue });
    });

    // Short poll interval keeps the test quick.
    const stop = manager.watchConfigFiles({ intervalMs: WATCH_POLL_INTERVAL_MS });
    const externalEdit = (): void => {
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({ provider: { model: 'anthropic:edited-externally' } }, null, 2) + '\n',
        'utf-8',
      );
    };
    try {
      // Another process writes the settings file directly — ONCE. No re-save
      // loop: one external write must be enough.
      externalEdit();

      // Wait for the poll + reload to surface the change — no fixed sleep, and
      // no budget a merely-loaded runner can blow through.
      await waitForCondition(() => seen.length > 0, 'the external edit reaching the subscriber');
    } finally {
      stop();
    }

    // The live config now reflects the external edit...
    expect(manager.get('provider.model')).toBe('anthropic:edited-externally');
    // ...and the subscriber was notified with old + new values.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]?.newValue).toBe('anthropic:edited-externally');
    expect(seen[0]?.oldValue).toBe('openai:start');
  }, WATCH_TEST_TIMEOUT_MS);

  /**
   * Regression guard for the watcher-startup race.
   *
   * The write happens in the SAME synchronous tick in which the watch is armed
   * — the exact window in which fs.watchFile's asynchronous baseline stat used
   * to swallow an edit permanently. The watcher captures its baseline
   * synchronously before arming the poll, so this single write is still seen.
   *
   * Written to fail loudly against the old behaviour: there is no re-save and
   * no second write, so a watcher that baselines the edit away has no later
   * change to recover on and the wait runs to its ceiling.
   */
  test('a write landing during watcher startup is still observed', async () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    manager.set('provider.model', 'openai:start');

    const seen: unknown[] = [];
    manager.subscribe('provider.model', (newValue) => { seen.push(newValue); });

    const stop = manager.watchConfigFiles({ intervalMs: WATCH_POLL_INTERVAL_MS });
    // No await, no timer, nothing yielding to the event loop between arming the
    // watch and this write. Content length differs from the seeded value too,
    // so detection cannot depend on filesystem mtime granularity alone.
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ provider: { model: 'anthropic:written-during-watcher-startup' } }, null, 2) + '\n',
      'utf-8',
    );

    try {
      await waitForCondition(() => seen.length > 0, 'a startup-window write reaching the subscriber');
    } finally {
      stop();
    }

    expect(manager.get('provider.model')).toBe('anthropic:written-during-watcher-startup');
    expect(seen[seen.length - 1]).toBe('anthropic:written-during-watcher-startup');
  }, WATCH_TEST_TIMEOUT_MS);

  test('stopWatchingConfigFiles halts further notifications', async () => {
    const configDir = tempConfigDir();
    const manager = new ConfigManager({ configDir });
    manager.set('provider.model', 'openai:base');
    let count = 0;
    manager.subscribe('provider.model', () => { count += 1; });

    const stop = manager.watchConfigFiles({ intervalMs: WATCH_POLL_INTERVAL_MS });
    stop();

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ provider: { model: 'openai:after-stop' } }, null, 2) + '\n',
      'utf-8',
    );

    // A quiet window, NOT a wait-for-condition: this asserts that nothing
    // happens, so the sleep is the negative control itself and a slow or loaded
    // machine can only make the window more generous (more opportunity for a
    // broken stop() to fire), never produce a false failure. Sized well above
    // the watcher's own poll interval.
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_INTERVAL_MS * 10));

    expect(count).toBe(0);
    // The stopped watcher also left the in-memory value untouched.
    expect(manager.get('provider.model')).toBe('openai:base');
  }, WATCH_TEST_TIMEOUT_MS);
});
