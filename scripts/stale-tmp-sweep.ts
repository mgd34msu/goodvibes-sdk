/**
 * Shared reclaim-on-startup helper for anything that puts its own working
 * directory straight under the real `os.tmpdir()` (a per-run test-tmp root,
 * a release-verify scratch registry, a native build's work directory) and
 * cannot guarantee it always gets to remove that directory itself: a signal
 * kill (Ctrl-C, a CI job timeout, `pkill`) skips `finally` blocks the same
 * way it skips `afterAll` hooks, so the directory is orphaned.
 *
 * The fix used across this repo (first in scripts/test.ts, for the run temp
 * root under `bun scripts/test.ts`) is the same shape every time: give the
 * directory a name that is unique to this run AND recognizable as this
 * tool's own, then have every entry point of that tool sweep for stale
 * siblings, same prefix, older than a threshold generous enough that it
 * never touches a run that is still actually going, before it creates its
 * own. Age-gated and prefix-scoped on purpose: a sibling run of the SAME
 * tool started moments ago, or an unrelated directory sharing the same
 * system temp dir, must never be touched. This is not a blanket `/tmp`
 * sweep, it only ever looks at entries starting with the caller's prefix.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove entries directly under `root` whose name starts with `prefix` and
 * whose mtime is older than `maxAgeMs`. Best-effort: a directory that
 * vanishes between listing and stat (another run reclaimed it first) or that
 * fails to remove is silently skipped, never thrown.
 */
export function sweepStaleTmpDirs(root: string, prefix: string, maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
    } catch {
      continue; // vanished between listing and stat
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort, another run may have reclaimed it first.
    }
  }
}
