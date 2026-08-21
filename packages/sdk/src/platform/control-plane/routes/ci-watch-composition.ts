/**
 * ci-watch-composition.ts, the CI-watch verb group's construction, as a free
 * function over the same deps object the registrar receives.
 *
 * Split out of routes/register-gateway-verb-groups.ts, which had reached the
 * hand-authored source cap: this was its longest single block, and it is a
 * self-contained composition (one service, its verbs, its auto-minter, its
 * poller) with no shared local state, so it is the one that moves. Same
 * convention as session-broker.ts → session-broker-intent.ts: a free function
 * taking an explicit deps object, with a one-line call left behind.
 *
 * Nothing about the behaviour changes. The order of construction, every
 * optional-dependency degrade, and every comment explaining one are carried
 * over verbatim.
 */

import { randomUUID } from 'node:crypto';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { ConfigKey } from '../../config/schema.js';
import { registerCiGatewayMethods } from './ci.js';
import { startCiFixSession } from './seeded-sessions.js';
import {
  CiWatchAutoMinter,
  CiWatchService,
  CiWatchStore,
  createGhCliCiSource,
  registerCiWatchPolling,
  type FixSessionBrief,
} from '../../ci-watch/index.js';
import { parseChannelDeliveryTarget } from '../../channels/delivery/types.js';
import { logger } from '../../utils/logger.js';
import type { GatewayVerbGroupDeps } from './register-gateway-verb-groups.js';
import { controlPlaneStorePath } from '../control-plane-store-paths.js';

/** Exactly the deps this composition reads, a slice of the registrar's own. */
export type CiWatchCompositionDeps = Pick<
  GatewayVerbGroupDeps,
  | 'shellPaths'
  | 'surfaceRoot'
  | 'channelDeliveryRouter'
  | 'automationManager'
  | 'stampFixSessionOnApproval'
  | 'requestApproval'
  | 'onCiAutoWatch'
  | 'workingDirectory'
  | 'watcherRegistry'
  | 'configManager'
>;

/**
 * CI-watch: the per-job status tool + standing subscriptions. The gh-CLI
 * source and the watch store are always available; the completion notifier
 * binds to the channel delivery router when present, and the opt-in fix-session
 * starts a one-shot isolated automation job when the automation manager is
 * present (absent → the trigger is recorded honestly but no session starts).
 */
export function composeCiWatchGatewayVerbs(catalog: GatewayMethodCatalog, deps: CiWatchCompositionDeps): void {
  const ciWatchService = new CiWatchService({
    source: createGhCliCiSource(),
    store: new CiWatchStore(controlPlaneStorePath(deps.shellPaths, deps.surfaceRoot, 'ci-watches.json')),
    ...(deps.channelDeliveryRouter
      ? {
        notifier: async (channel: string, title: string, body: string): Promise<string | undefined> =>
          deps.channelDeliveryRouter!.deliver({
            target: parseChannelDeliveryTarget(channel),
            body,
            title,
            jobId: 'ci-watch',
            runId: `ci-${Date.now()}`,
            includeLinks: false,
          }),
      }
      : {}),
    ...(deps.automationManager
      ? { fixSessionStarter: (brief) => startCiFixSession(deps.automationManager!, brief) }
      : {}),
    // "Fix this?" on a red run: the offer rides the SAME approval broker as a
    // permission ask, so every surface's attention machinery renders it;
    // acceptance starts the fix-session seeded with the failing jobs' logs.
    // The accepted offer's started session id is stamped back onto the
    // RESOLVED approval record (broker seam, published live) so the surface
    // that accepted has an in-process handle, the offerCallId returned below
    // is what ties the started session to its approval record.
    ...(deps.stampFixSessionOnApproval
      ? { stampFixSession: deps.stampFixSessionOnApproval }
      : {}),
    ...(deps.requestApproval
      ? {
        fixSessionOffer: async (brief: FixSessionBrief): Promise<{ accepted: boolean; offerCallId: string }> => {
          const where = brief.prNumber !== undefined ? `PR #${brief.prNumber}` : (brief.ref ?? 'watched ref');
          const offerCallId = `ci-fix-${randomUUID().slice(0, 8)}`;
          const decision = await deps.requestApproval!({
            request: {
              callId: offerCallId,
              tool: 'ci:fix-session',
              args: {
                repo: brief.repo,
                ...(brief.ref ? { ref: brief.ref } : {}),
                ...(brief.prNumber !== undefined ? { prNumber: brief.prNumber } : {}),
                failingJobs: [...brief.failingJobs],
              },
              category: 'delegate',
              analysis: {
                classification: 'ci-fix-session',
                riskLevel: 'medium',
                summary: `CI went red on ${brief.repo} (${where}), start a fix session for ${brief.failingJobs.join(', ') || 'the failing jobs'}?`,
                reasons: [
                  `The watched CI run on ${brief.repo} reached a failed verdict.`,
                  'Accepting starts an isolated fix session seeded with the failing jobs\' logs; declining leaves the red run untouched.',
                ],
                surface: 'orchestration',
                blastRadius: 'delegated',
              },
            },
            metadata: { source: 'ci-watch', repo: brief.repo },
          });
          return { accepted: decision.approved, offerCallId };
        },
      }
      : {}),
  });
  registerCiGatewayMethods(catalog, ciWatchService);
  // Self-minting at the push seam: a successful exec containing `git push` /
  // `gh pr create` mints a watch for the pushed branch (delivery defaults to
  // the operator web surface; the watch retires itself after its verdict).
  if (deps.onCiAutoWatch && deps.workingDirectory) {
    const autoMinter = new CiWatchAutoMinter({ service: ciWatchService, workingDirectory: deps.workingDirectory });
    deps.onCiAutoWatch((toolName, args, success) => autoMinter.onToolExecuted(toolName, args, success));
  }
  // The daemon polls registered watches on the watchers.ciPollIntervalMs
  // cadence (15s floor, sequential passes, overlap-guarded) via the existing
  // watcher-registry polling machinery, a standing watch no longer stands
  // still until someone runs the manual verb. When the watcher framework is
  // turned off (watchers.enabled false) the poll is honestly skipped: the
  // manual ci.watches.run verb still works, so nothing is silently faked.
  // Defensive config access: some conformance/composition callers pass a
  // partial deps object at runtime (see terminal-shell's ws-only attachment).
  const readConfig = (key: string): unknown => deps.configManager?.get(key as ConfigKey);
  const watchersEnabled = readConfig('watchers.enabled') !== false;
  if (deps.watcherRegistry && watchersEnabled) {
    const configuredCadence = readConfig('watchers.ciPollIntervalMs');
    try {
      registerCiWatchPolling(deps.watcherRegistry, ciWatchService, {
        ...(typeof configuredCadence === 'number' ? { intervalMs: configuredCadence } : {}),
      });
    } catch (error) {
      // A gated/refusing watcher registry must never fail daemon composition,
      // CI watches degrade to the manual verb, stated honestly in the log.
      logger.warn('[ci-watch] recurring poll not registered; watches run via the manual verb only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
