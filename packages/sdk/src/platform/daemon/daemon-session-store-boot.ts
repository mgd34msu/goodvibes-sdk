/**
 * daemon-session-store-boot.ts — the two things the daemon does to its session
 * store before the broker serves: fold every legacy store forward, then sweep
 * the pre-split one aside.
 *
 * They live together, and away from facade-lifecycle.ts, because they are one
 * concern with one ordering constraint between them (see below) and because
 * the defect they fix was caused by a boot step deriving its own idea of where
 * the store lives. Keeping that reasoning in one file is the point.
 *
 * The full account of what was on disk is in
 * control-plane/pre-split-control-plane-sweep.ts.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { discoverLegacySessionSources, importLegacySessionStores } from '../control-plane/index.js';
import {
  sweepPreSplitControlPlaneStore,
  type PreSplitControlPlaneSweepReport,
} from '../control-plane/pre-split-control-plane-sweep.js';
import { sharedWorkspaceRegisterPath } from '../workspace/registration/shared-register-path.js';

/** The subset of the shell path service these two steps need. */
export interface DaemonSessionStoreBootPaths {
  readonly workingDirectory: string;
  resolveUserPath(...segments: string[]): string;
}

/**
 * Both steps, in the one order they may run in — the whole of what the daemon
 * facade does to its session store before the broker serves.
 *
 * The live path comes FROM the broker rather than being derived here. A second
 * derivation of it is exactly what left a pre-split store being rewritten every
 * boot at a path nothing read, and a composed daemon can be given any store
 * path at all. A broker constructed on an INJECTED store has no file: there is
 * nothing to fold into and nothing to sweep, and nothing may guess a path for
 * it, so both steps are skipped and this reports `null`.
 */
export async function runDaemonSessionStoreBoot(input: {
  readonly sessionBroker: { readonly storePath: string | null };
  readonly shellPaths: DaemonSessionStoreBootPaths;
  /** This daemon's surface root — the segment `resolveUserPath` never adds. */
  readonly surfaceRoot: string;
  readonly recordReceipt: (text: string) => void;
}): Promise<PreSplitControlPlaneSweepReport | null> {
  const liveStorePath = input.sessionBroker.storePath;
  if (liveStorePath !== null) await importLegacyDaemonSessionStores(input.shellPaths, liveStorePath);
  return sweepPreSplitDaemonControlPlaneStore({
    shellPaths: input.shellPaths,
    surfaceRoot: input.surfaceRoot,
    sessionStorePath: liveStorePath,
    recordReceipt: input.recordReceipt,
  });
}

/**
 * Boot precondition: fold legacy session stores into the store the broker
 * actually serves, before it serves (idempotent; failures are logged, never
 * fatal).
 *
 * `liveStorePath` is REQUIRED and has no default, and that is the fix.
 *
 * This used to compute its own target: `resolveUserPath('control-plane',
 * 'sessions.json')`. `resolveUserPath` does not add a surface segment — the
 * segment is always the caller's to pass — so the target was
 * `~/.goodvibes/control-plane/sessions.json`, while the broker is constructed
 * on `resolveProjectPath(surfaceRoot, 'control-plane', 'sessions.json')` and
 * reads `~/.goodvibes/tui/control-plane/sessions.json`. Every boot folded every
 * legacy source into a file nothing would ever read, and persisted it
 * unconditionally, so the orphan looked freshly written and alive. Taking the
 * path from the broker instead of deriving a parallel one is what stops the two
 * from drifting apart again.
 *
 * The old unscoped path becomes a SOURCE — everything that landed there over
 * however many boots is folded forward, once, by the same id-keyed merge.
 */
export async function importLegacyDaemonSessionStores(
  shellPaths: DaemonSessionStoreBootPaths,
  liveStorePath: string,
): Promise<void> {
  const preSplitStorePath = shellPaths.resolveUserPath('control-plane', 'sessions.json');
  const sources = discoverLegacySessionSources({
    projectRoot: shellPaths.workingDirectory,
    companionSessionsDir: shellPaths.resolveUserPath('companion-chat', 'sessions'), // injected home
  });
  await importLegacySessionStores({
    homeStorePath: liveStorePath,
    sources: preSplitStorePath === liveStorePath
      ? sources
      : [...sources, { kind: 'broker-store', path: preSplitStorePath }],
  }).catch((error: unknown) => logger.warn('DaemonServer: legacy session import failed', { error: summarizeError(error) }));
}

/**
 * Boot sweep: end the two-control-plane-stores condition on a machine that ran
 * a pre-split daemon, and put one line in front of the owner saying what moved.
 *
 * Runs AFTER the fold above, and the order is load-bearing: the fold is what
 * guarantees the live store already holds everything the pre-split one did
 * before anything is moved aside. It also creates the live store on a machine
 * that has never had one, which is what lets the sweep recognise a pre-split
 * file as a DUPLICATE rather than as the only copy.
 *
 * Never throws; a sweep that cannot finish reports what it could not do.
 */
export async function sweepPreSplitDaemonControlPlaneStore(input: {
  readonly shellPaths: Pick<DaemonSessionStoreBootPaths, 'resolveUserPath'>;
  readonly surfaceRoot: string;
  readonly sessionStorePath: string | null;
  readonly recordReceipt: (text: string) => void;
}): Promise<PreSplitControlPlaneSweepReport | null> {
  try {
    const report = await sweepPreSplitControlPlaneStore({
      legacyDirectory: input.shellPaths.resolveUserPath('control-plane'),
      // Where those stores belong: the same surface-scoped directory their
      // writers now resolve (control-plane-store-paths.ts). NOT the broker's
      // own directory — the broker's file is project-scoped and these are
      // home-scoped, and on a daemon started outside the home they differ.
      scopedDirectory: input.shellPaths.resolveUserPath(input.surfaceRoot, 'control-plane'),
      sessionStorePath: input.sessionStorePath,
      // The shared tier, which takes no surface root: three products read this
      // register, so it must not land under any one of their directories.
      workspaceRegisterPath: sharedWorkspaceRegisterPath(input.shellPaths),
    });
    // Gated on there being something to SAY, not on a particular status: a pass
    // that only had to leave something alone still owes the owner the sentence
    // explaining why his two directories are still two.
    if (report.receipt !== null) {
      logger.warn('DaemonServer: swept a pre-split control-plane store', {
        legacyDirectory: report.legacyDirectory,
        scopedDirectory: report.scopedDirectory,
        foldedSessions: report.foldedSessions,
        adoptedFiles: report.adoptedFiles,
        movedFiles: report.movedFiles,
        quarantineDirectory: report.quarantineDirectory,
        conflictedFiles: report.conflictedFiles,
        skippedFiles: report.skippedFiles,
        sharedFiles: report.sharedFiles,
        foldedWorkspaceRows: report.foldedWorkspaceRows,
        failures: report.failures,
      });
      input.recordReceipt(report.receipt);
    }
    return report;
  } catch (error) {
    logger.warn('DaemonServer: pre-split control-plane sweep failed', { error: summarizeError(error) });
    return null;
  }
}
