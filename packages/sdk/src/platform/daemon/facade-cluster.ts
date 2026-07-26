/**
 * facade-cluster.ts — leadership gating for the daemon's INBOUND consumers.
 *
 * Two things start listening when the daemon comes up: the channel provider
 * runtime (Slack Socket Mode, Discord Gateway, the ntfy JSON stream) and the
 * Telegram ingress supervisor. Both are registered here as gates on the
 * cluster coordinator instead of being started directly, so on a network where
 * this install runs more than once exactly one node listens.
 *
 * What is deliberately NOT gated: outbound delivery, sessions, the control
 * plane, the HTTP listener, watchers, triggers, and every other daemon
 * subsystem. A standby node is a fully functional daemon that simply is not
 * the one reading the inbox — it can still send, still serve the web UI, still
 * run agents. Gating anything else would turn "we are not the reader" into
 * "we are degraded", which is not what leadership means here.
 *
 * A host that gates inbound consumers of its own passes a coordinator in
 * (`DaemonConfig.clusterCoordinator`). It MUST be reused rather than
 * supplemented: two coordinators in one process would be two nodes in the
 * election, and one of them would win and gate consumers the other owns. The
 * goodvibes-tui daemon does exactly this so its own inbox poller rides the
 * same leadership as Telegram and ntfy.
 */
import { ClusterCoordinator, readClusterSettings } from '../cluster/index.js';
import type { ClusterConsumerGate } from '../cluster/index.js';
import type { BuiltinChannelRuntime, ChannelProviderRuntimeManager } from '../channels/index.js';
import type { DaemonConfig } from './types.js';
import type { DaemonFacadeCollaborators, ResolvedDaemonFacadeRuntime } from './facade-types.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export { ClusterCoordinator } from '../cluster/index.js';

/**
 * The provider runtime as a leadership gate.
 *
 * `replayFromMs` is threaded into the ntfy subscription because ntfy has no
 * server-side per-subscriber cursor: a takeover that subscribed "from now"
 * would drop everything published between the previous node's last heartbeat
 * and this start. Telegram needs no equivalent — its backlog lives on
 * Telegram's servers and the persisted offset already covers the gap.
 */
function providerRuntimeGate(providerRuntime: ChannelProviderRuntimeManager): ClusterConsumerGate {
  return {
    id: 'channel-provider-runtime',
    start: async (context) => {
      await providerRuntime.startConfigured({ replayFromMs: context.replayFromMs });
    },
    stop: async () => {
      // Aborts the ntfy stream and closes the Slack/Discord sockets. Synchronous
      // by construction, which is what lets the RESIGN that follows be honest.
      providerRuntime.stopAll();
    },
  };
}

/**
 * Telegram ingress as a leadership gate.
 *
 * `stopIngress()` does not resolve until the in-flight long poll has settled
 * and its offset has been committed, which is the property the ordered handoff
 * depends on: the successor is told to start only after this promise resolves.
 */
function telegramIngressGate(builtinChannels: BuiltinChannelRuntime): ClusterConsumerGate {
  return {
    id: 'telegram-ingress',
    start: async () => {
      await builtinChannels.startIngress();
    },
    stop: async () => {
      await builtinChannels.stopIngress();
    },
  };
}

/**
 * Build (or adopt) the coordinator and register the daemon's inbound gates.
 *
 * Registration order is start order: the provider runtime first, Telegram
 * second, and they stop in the reverse. Nothing is started here — the
 * coordinator starts gates only if and when this node wins the election.
 */
export function buildDaemonClusterCoordinator(
  config: DaemonConfig,
  runtime: ResolvedDaemonFacadeRuntime,
  collaborators: DaemonFacadeCollaborators,
): ClusterCoordinator {
  const coordinator = config.clusterCoordinator ?? new ClusterCoordinator({
    settings: readClusterSettings(runtime.configManager),
    version: VERSION,
    // Alongside the Telegram poll cursor: node identity is per-surface state
    // and must not leak across surface roots.
    stateDirectory: runtime.runtimeServices.shellPaths.resolveProjectPath('goodvibes', 'cluster'),
    logger,
  });
  // The LAN group verbs (/api/cluster/*), when the host composed a group
  // runtime. Wired here rather than in facade.ts because this is already the
  // one place the daemon's cluster wiring lives.
  if (config.clusterGroupVerbs) collaborators.httpRouter.setClusterGroupVerbs(config.clusterGroupVerbs);
  coordinator.register(providerRuntimeGate(collaborators.providerRuntime));
  coordinator.register(telegramIngressGate(collaborators.builtinChannels));
  // Late-bound because the runtime is built before the coordinator exists: a
  // Telegram 409 naming another consumer has to reach leadership, not a log.
  collaborators.builtinChannels.setConsumerConflictHandler(
    (detail) => coordinator.reportConsumerConflict(detail),
  );
  return coordinator;
}
