/**
 * Export-map subpath resolution: consumer imports of the public subpaths are
 * proven against the COMMITTED package.json exports manifest, not just
 * compilation. Every import here goes through the package NAME (the workspace
 * link into packages/sdk), so Bun applies the real exports map exactly as a
 * consumer install would — a subpath missing from the manifest fails here
 * even though the dist file exists on disk.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = '@pellux/goodvibes-sdk';

/** subpath -> the export names a consumer composes with. */
const SUBPATH_SURFACE: Record<string, readonly string[]> = {
  './platform/state/store-snapshots': ['StoreSnapshotScheduler', 'RetentionPolicy', 'SnapshotPruner', 'defaultStoreSnapshotRetention', 'snapshotStoreFile', 'restoreStoreSnapshot', 'listStoreSnapshots'],
  './platform/runtime/permissions/exec-prompt-wiring': ['buildExecPromptAnswerHandler'],
  './platform/runtime/self-update': ['compareVersions', 'normalizeVersion', 'resolveLatestReleaseTag', 'resolveArtifactNames', 'verifyChecksum'],
  './platform/daemon/auto-updater': ['DaemonAutoUpdater', 'defaultDownloadBaseUrl'],
  './platform/daemon/receipts': ['DaemonReceiptStore', 'formatReceiptTime', 'realReceiptStoreIo'],
};

describe('export-map subpath resolution (committed manifest)', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'packages', 'sdk', 'package.json'), 'utf8'),
  ) as { exports: Record<string, { types?: string; import?: string }> };

  for (const [subpath, expectedExports] of Object.entries(SUBPATH_SURFACE)) {
    test(`${subpath} is declared in the exports map with types + import targets`, () => {
      const entry = manifest.exports[subpath];
      expect(entry).toBeDefined();
      expect(entry!.types).toBe(`./dist${subpath.slice(1)}.d.ts`);
      expect(entry!.import).toBe(`./dist${subpath.slice(1)}.js`);
    });

    test(`${subpath} resolves and serves its composition surface through the package name`, async () => {
      const mod = await import(`${PACKAGE}${subpath.slice(1)}`) as Record<string, unknown>;
      for (const name of expectedExports) {
        expect(mod[name], `${subpath} must export ${name}`).toBeDefined();
      }
    });
  }
});
