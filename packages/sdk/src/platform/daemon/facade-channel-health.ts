/**
 * The daemon's channel-health watcher, and the announcer that makes it matter.
 *
 * Making a channel's reported state honest fixes the answer to a question that
 * nobody asks. The lived failure was not that a status endpoint said the wrong
 * thing, it was that a Telegram message got no reply and no surface, log line
 * or notification said why. So the daemon watches the states it now reports
 * truthfully, and when one stops working it says so over a channel that still
 * does.
 *
 * Composed here rather than in facade-composition.ts because the announcer is
 * a policy, which surfaces may carry an unprompted alert, and what happens
 * when none can, and policies deserve a file a reader can find.
 */
import { ChannelHealthWatcher, isChannelWorking } from '../channels/index.js';
import type { ChannelDeliveryTarget } from '../channels/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ResolvedDaemonFacadeRuntime } from './facade-types.js';

/**
 * Surfaces an unprompted alert may be pushed to.
 *
 * `tui` and `web` are excluded because they are PULL surfaces, nothing is
 * delivered to them, they are read when the owner happens to look, which is the
 * property that made the original defect invisible in the first place.
 * `webhook` is excluded because its target is whatever endpoint the operator
 * wired, which is not necessarily a place a person reads.
 */
const DELIVERABLE_ALERT_SURFACES = new Set<string>([
  'slack', 'discord', 'ntfy', 'telegram', 'google-chat', 'signal', 'whatsapp',
  'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix', 'homeassistant',
]);

/**
 * Watch the channels, and tell the owner over one that still works when another
 * stops.
 *
 * The announcer re-reads the registry rather than trusting a cached picture:
 * the point of the message is that something just changed, and the set of
 * channels able to carry it is exactly what changed. It excludes the failed
 * surface, because announcing a dead Telegram over Telegram is the failure
 * wearing the alert's clothes.
 *
 * When nothing survives, the alert is stated at ERROR in the daemon log and
 * nowhere else, and it says so, an owner reading that line later learns both
 * that a channel died and that he was never told.
 */
export function buildDaemonChannelHealthWatcher(runtime: ResolvedDaemonFacadeRuntime): ChannelHealthWatcher {
  const deliveryRouter = runtime.deliveryManager.getDeliveryRouter();
  return new ChannelHealthWatcher({
    listStatus: () => runtime.channelPlugins.listStatus(),
    announce: async (alert) => {
      const carriers = (await runtime.channelPlugins.listStatus()).filter((entry) =>
        entry.surface !== alert.surface
        && entry.enabled
        && isChannelWorking(entry.state)
        && DELIVERABLE_ALERT_SURFACES.has(entry.surface));
      if (carriers.length === 0) {
        logger.error('A channel changed state and no surviving channel could carry the notice', {
          surface: alert.surface,
          state: alert.state,
          detail: alert.message,
          action: 'configure a second channel so a dead one can be reported over another',
        });
        return;
      }
      for (const carrier of carriers) {
        try {
          await deliveryRouter.deliver({
            target: { kind: 'surface', surfaceKind: carrier.surface as ChannelDeliveryTarget['surfaceKind'] },
            body: alert.message,
            title: alert.kind === 'recovered' ? 'Channel recovered' : 'Channel not working',
            jobId: 'channel-health',
            runId: `channel-health-${alert.surface}-${Date.now()}`,
            includeLinks: false,
          });
        } catch (error) {
          logger.warn('Channel health notice could not be delivered over one surface', {
            surface: carrier.surface,
            about: alert.surface,
            error: summarizeError(error),
          });
        }
      }
    },
  });
}
