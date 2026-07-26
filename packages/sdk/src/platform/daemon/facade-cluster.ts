/**
 * facade-cluster.ts — leadership gating for the daemon's INBOUND consumers,
 * one gate per surface.
 *
 * Several things start listening when the daemon comes up: the Telegram
 * ingress supervisor, a subscription per ntfy topic, the Slack Socket Mode
 * connection, the Discord Gateway. Each is registered here as its OWN gate on
 * the cluster coordinator instead of being started directly, so on a network
 * where this install runs more than once exactly one node reads each of them —
 * and different nodes may read different ones.
 *
 * That per-surface split is the whole point. The previous shape registered one
 * gate for "the provider runtime" covering Slack, Discord and every ntfy topic
 * together, which meant a node either read all of them or none. A laptop with
 * a bot token and a desktop with only a topic could not divide the work, and
 * whichever won took surfaces it had no credential for.
 *
 * A gate is registered only for a surface this node can ACTUALLY serve: the
 * surface is enabled in config and its credential resolves. That is what stops
 * a node winning an election for something it cannot read — which would starve
 * the node that could.
 *
 * What is deliberately NOT gated: outbound delivery, sessions, the control
 * plane, the HTTP listener, watchers, triggers, and every other daemon
 * subsystem. A standby node is a fully functional daemon that simply is not the
 * one reading a particular inbox — it can still send, still serve the web UI,
 * still run agents. Gating anything else would turn "we are not the reader"
 * into "we are degraded", which is not what leadership means here.
 *
 * A host that gates inbound consumers of its own passes a coordinator in
 * (`DaemonConfig.clusterCoordinator`). It MUST be reused rather than
 * supplemented: two coordinators in one process would be two nodes in the
 * group, and one would gate consumers the other owns. The goodvibes-tui daemon
 * does exactly this so its own inbox poller rides the same leadership.
 */
import {
  ClusterCoordinator,
  ntfySurface,
  readClusterSettings,
  telegramSurface,
} from '../cluster/index.js';
import { SocketSurfaceSupervisor } from './facade-cluster-sockets.js';
import type { ClusterConsumerGate, ClusterSurfaceKey } from '../cluster/index.js';
import type { BuiltinChannelRuntime, ChannelProviderRuntimeManager } from '../channels/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { DaemonConfig } from './types.js';
import type { DaemonFacadeCollaborators, ResolvedDaemonFacadeRuntime } from './facade-types.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export { ClusterCoordinator } from '../cluster/index.js';

/**
 * One ntfy topic as a leadership gate.
 *
 * `replayFromMs` is threaded into the subscription because ntfy has no
 * server-side per-subscriber cursor: a takeover that subscribed "from now"
 * would drop everything published between the previous holder's last heartbeat
 * and this start. Telegram needs no equivalent — its backlog lives on
 * Telegram's servers and the persisted offset already covers the gap.
 */
function ntfyTopicGate(
  providerRuntime: ChannelProviderRuntimeManager,
  baseUrl: string,
  topic: string,
): ClusterConsumerGate {
  return {
    id: `ntfy-topic:${topic}`,
    surface: ntfySurface(baseUrl, topic),
    start: async (context) => {
      await providerRuntime.startNtfyTopic(topic, { replayFromMs: context.replayFromMs });
    },
    stop: async () => {
      providerRuntime.stopNtfyTopic(topic);
    },
  };
}

/**
 * Slack Socket Mode and the Discord Gateway as gates, under the surface
 * identity the provider itself reported.
 *
 * The discriminator is the real workspace or application id, resolved before
 * anything is contested — see facade-cluster-sockets.ts for why a placeholder
 * would starve one of two differently-configured workspaces.
 */
function socketProviderGate(
  providerRuntime: ChannelProviderRuntimeManager,
  kind: 'slack' | 'discord',
  surface: ClusterSurfaceKey,
): ClusterConsumerGate {
  return {
    id: `${kind}-socket`,
    surface,
    start: async () => {
      await providerRuntime.start(kind);
    },
    stop: async () => {
      providerRuntime.stop(kind);
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
function telegramIngressGate(
  builtinChannels: BuiltinChannelRuntime,
  surface: ClusterSurfaceKey,
): ClusterConsumerGate {
  return {
    id: 'telegram-ingress',
    surface,
    start: async () => {
      await builtinChannels.startIngress();
    },
    stop: async () => {
      await builtinChannels.stopIngress();
    },
  };
}

/**
 * Build (or adopt) the coordinator, and tell it how to find out what this node
 * can serve.
 *
 * The surfaces are registered through `onPrepare` rather than here, because
 * deciding whether a surface is servable means RESOLVING its credential and
 * this function is synchronous. `onPrepare` runs that work at `start()`, ahead
 * of the first boot probe, so every servable surface is in its own first
 * election and no unresolvable one is contested at all.
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
  coordinator.onPrepare(() => registerDaemonClusterSurfaces(coordinator, runtime, collaborators));
  return coordinator;
}

/**
 * One inbound surface the operator enabled cannot be served, so this node will
 * not contest it and will not read it.
 *
 * This is the single most expensive state the daemon can be in — the config
 * reads correct, the process is healthy, and messages disappear — so it is
 * stated at ERROR with the operator's next action in it, not left to a status
 * endpoint nobody queries. It matters more under leadership than it did
 * before: a node that quietly declines a surface looks exactly like a node
 * that correctly lost its election.
 */
function reportInert(surface: string, action: string): void {
  logger.error(`${surface} is enabled but this node will NOT receive its messages`, { surface, action });
}

/** Register a gate for every inbound surface this node can actually serve. */
export async function registerDaemonClusterSurfaces(
  coordinator: ClusterCoordinator,
  runtime: ResolvedDaemonFacadeRuntime,
  collaborators: DaemonFacadeCollaborators,
): Promise<void> {
  const config = runtime.configManager;
  const providerRuntime = collaborators.providerRuntime;

  if (config.get('surfaces.ntfy.enabled')) {
    const baseUrl = providerRuntime.ntfyBaseUrl();
    const topics = providerRuntime.ntfyTopics();
    if (topics.length === 0) {
      reportInert('ntfy', 'no ntfy topic resolved; set surfaces.ntfy.agentTopic (and optionally chatTopic / remoteTopic)');
    }
    for (const topic of topics) {
      coordinator.register(ntfyTopicGate(providerRuntime, baseUrl, topic));
    }
  }

  // Slack and Discord are contested under the identity the provider reports,
  // never under a placeholder — a placeholder would put two different
  // workspaces into one election and starve whichever lost.
  const supervisors = new Map<'slack' | 'discord', SocketSurfaceSupervisor>();
  for (const kind of ['slack', 'discord'] as const) {
    if (!config.get(`surfaces.${kind}.enabled` as Parameters<ConfigManager['get']>[0])) continue;
    const supervisor = new SocketSurfaceSupervisor({
      kind,
      resolveIdentity: () => providerRuntime.resolveSocketSurfaceIdentity(kind),
      register: (surface) => coordinator.register(socketProviderGate(providerRuntime, kind, surface)),
      isRunning: () => coordinator.running,
      reportInert,
      logger,
    });
    supervisors.set(kind, supervisor);
    await supervisor.begin();
  }
  if (supervisors.size > 0) {
    // A dropped socket means this node can no longer read that workspace, so
    // it stands down rather than holding a surface it is not serving.
    providerRuntime.setSocketLostHandler((kind, reason) => {
      supervisors.get(kind)?.onSocketLost(reason);
    });
  }

  if (config.get('surfaces.telegram.enabled')) {
    const botId = await collaborators.builtinChannels.resolveServableTelegramBotId();
    if (!botId) {
      reportInert('telegram', 'no Telegram bot token resolved; set surfaces.telegram.botToken '
        + '(a goodvibes://secrets/... reference is fine) or the TELEGRAM_BOT_TOKEN environment variable');
      return;
    }
    const surface = telegramSurface(botId);
    coordinator.register(telegramIngressGate(collaborators.builtinChannels, surface));
    // Late-bound because the runtime is built before the coordinator exists: a
    // Telegram 409 naming another consumer has to reach leadership, not a log.
    // Routed at the Telegram surface specifically — a conflict over one bot
    // token is no reason to give up an unrelated ntfy topic.
    collaborators.builtinChannels.setConsumerConflictHandler(
      (detail) => coordinator.reportConsumerConflict(detail, surface),
    );
  }
}
