/**
 * routes/register-gateway-verb-groups.ts
 *
 * One entry point the runtime-services composition root calls to attach every
 * handler-registered gateway verb group, so services.ts needs a single import
 * and a single call regardless of how many groups exist.
 *
 * It folds in the pre-existing fleet / checkpoints / sessions.search group
 * (registerFleetCheckpointsSearchGatewayMethods, unchanged) and constructs + wires the browser-
 * push group: a PushService over the subscription store and VAPID key custody,
 * its verb handlers, and — the real event source — a subscription to the
 * approval broker so an approval that needs a decision fans out as a push to the
 * operator's registered devices.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { registerFleetCheckpointsSearchGatewayMethods, type FleetCheckpointsSearchGatewayDeps } from './register-fleet-checkpoints-search.js';
import { registerPushGatewayMethods } from './push.js';
import { registerSkillsGatewayMethods } from './skills.js';
import { registerPrincipalsGatewayMethods } from './principals.js';
import { PrincipalRegistry, PrincipalStore } from '../../principals/index.js';
import { registerChannelProfilesGatewayMethods } from './channel-profiles.js';
import { registerChannelTestGatewayMethods } from './channel-test.js';
import { registerWorktreeSetupGatewayMethods } from './worktree-setup.js';
import { WorktreeRegistry } from '../../runtime/worktree/registry.js';
import { resolveWorktreeSetupConfig } from '../../runtime/worktree/setup.js';
import { registerCostGatewayMethods } from './cost.js';
import { registerMemoryProjectionsGatewayMethods, type MemoryProjectionSource } from './memory-projections.js';
import { CostAttributionService, type ResolvePricing } from '../../runtime/cost/attribution.js';
import { QuotaWindowTracker } from '../../runtime/cost/quota-window.js';
import {
  ChannelProfileRegistry,
  ChannelProfileStore,
  installInboundIntakeEnrichment,
  type InboundIntakeBroker,
} from '../../channel-profiles/index.js';
import { registerCheckinGatewayMethods } from './checkin.js';
import {
  CheckinService,
  CheckinReceiptStore,
  createProviderBackedCheckinJudge,
  createRuntimeCheckinStateReader,
  type CheckinSessionView,
} from '../../checkin/index.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { AutomationManager } from '../../automation/index.js';
import type { ChannelDeliveryRouter } from '../../channels/delivery-router.js';
import type { ChannelDeliveryTarget } from '../../channels/delivery/types.js';
import { registerCiGatewayMethods } from './ci.js';
import { CiWatchService, CiWatchStore, createGhCliCiSource, type FixSessionBrief } from '../../ci-watch/index.js';
import { registerFlagsGraduationGatewayMethods } from './flags-graduation.js';
import { registerRuntimeMetricsGatewayMethods } from './runtime-metrics.js';
import { registerStepUpGatewayMethods, type StepUpGatewayService } from './stepup.js';
import { dirname } from 'node:path';
import { registerRewindGatewayMethods } from './rewind.js';
import { registerWorkspacesGatewayMethods } from './workspaces.js';
import { WorkspaceRegistrationStore } from '../../workspace/registration/index.js';
import { UnifiedRewindService } from '../../rewind/index.js';
import type { RewindConversationPort } from '../../rewind/index.js';
import { createEventEnvelope } from '../../runtime/events/index.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';

/** Parse a 'surfaceKind' or 'surfaceKind:address' channel string into a delivery target. */
function parseChannelDeliveryTarget(channel: string): ChannelDeliveryTarget {
  const separator = channel.indexOf(':');
  const surfaceKind = (separator === -1 ? channel : channel.slice(0, separator)).trim();
  const address = separator === -1 ? '' : channel.slice(separator + 1).trim();
  return {
    kind: 'surface',
    surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'],
    ...(address ? { address } : {}),
  };
}

/** Start a one-shot fix-session (an isolated automation job) pre-briefed with the failing CI jobs. */
async function startCiFixSession(
  automation: Pick<AutomationManager, 'createJob'>,
  brief: FixSessionBrief,
): Promise<string | undefined> {
  const target = brief.prNumber !== undefined ? `PR #${brief.prNumber}` : (brief.ref ?? 'the default branch');
  const prompt = [
    `CI failed for ${brief.repo} (${target}).`,
    `Failing jobs: ${brief.failingJobs.join(', ') || 'unknown'}.`,
    '',
    brief.logs,
    '',
    'Investigate the failing CI jobs and fix them.',
  ].join('\n');
  try {
    const job = await automation.createJob({
      name: `Fix CI: ${brief.repo}`,
      prompt,
      schedule: { kind: 'at', at: Date.now() },
      target: { kind: 'isolated', createIfMissing: true },
      enabled: true,
      deleteAfterRun: true,
    });
    return job.id;
  } catch {
    // Automation subsystem disabled — the fix-session cannot start this round.
    return undefined;
  }
}
import { createSessionRuntimeControls, registerSessionRuntimeGatewayMethods } from './session-runtime.js';
import type { ConfigManager } from '../../config/manager.js';
import type { RuntimeStore } from '../../runtime/store/index.js';
import { FileSystemSkillStore, SkillService } from '../../skills/index.js';
import {
  PushService,
  PushSubscriptionStore,
  VapidManager,
  type ApprovalSource,
  type FleetNotice,
  type FleetNoticeSource,
  type NeedsInputPresence,
  type VapidSecretStore,
} from '../../push/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { FleetEvent } from '../../../events/fleet.js';

export interface GatewayVerbGroupDeps extends FleetCheckpointsSearchGatewayDeps {
  /** SecretsManager (get/set) — VAPID keypair custody lives here, never in config. */
  readonly secretsManager: VapidSecretStore;
  /** The approval broker — the real event source push fans out from. */
  readonly approvalBroker: ApprovalSource;
  /** Home-scoped path service; the subscription store file resolves under it. */
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  /** Optional VAPID JWT `sub` contact. */
  readonly vapidSubject?: string | undefined;
  /**
   * Optional: the runtime event bus. When present, a fleet node that becomes
   * blocked on the operator fans out as a 'needs-input' push (the poll-free
   * counterpart to the approval source above). Absent → no needs-input pushes
   * (graceful degrade); every other verb group is unaffected.
   */
  readonly runtimeBus?: Pick<RuntimeEventBus, 'onDomain' | 'emit'> | undefined;
  /**
   * Optional: operator presence lookup. When present, a needs-input push is
   * suppressed while an operator surface is actively attached to that node's
   * session (someone is already looking). Absent → every needs-input block
   * pushes.
   */
  readonly sessionPresence?: NeedsInputPresence | undefined;
  /**
   * Config surface backing the session-scoped permission-mode verbs
   * (sessions.permissionMode.get/set): the daemon's own `permissions.mode`
   * read/write. A set flows to surfaces as runtime.permissions via the
   * already-wired mode-change binding.
   */
  readonly configManager: Pick<ConfigManager, 'get' | 'set'>;
  /**
   * Runtime store backing sessions.contextUsage.get and the local-session
   * resolution the session-runtime verbs gate on (getState().session.id).
   */
  readonly runtimeStore: Pick<RuntimeStore, 'getState'>;
  /**
   * The following three are wired only by the full runtime-services composition
   * root; when any is absent (e.g. the terminal-shell embed) the proactive
   * check-in verb group is simply not registered — a graceful degrade, exactly
   * like the runtimeBus-gated needs-input push source above.
   */
  readonly channelDeliveryRouter?: Pick<ChannelDeliveryRouter, 'deliver'> | undefined;
  readonly providerRegistry?: ProviderRegistry | undefined;
  readonly automationManager?:
    | Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'setEnabled' | 'attachCheckinEvaluator' | 'listRuns'>
    | undefined;
  /** A read-only session lister for the check-in briefing (the full SharedSessionBroker satisfies it). */
  readonly sessionLister?: { listSessions(limit?: number): readonly CheckinSessionView[] } | undefined;
  /**
   * The shared session broker's transport intake entry point. When present, the
   * inbound-intake enrichment (principal attribution + channel-profile
   * application) is installed on it so every channel-originated session is
   * enriched at submitMessage; absent → no enrichment is installed (graceful
   * degrade for embeds that wire no channel intake).
   */
  readonly sessionIntake?: InboundIntakeBroker | undefined;
  /**
   * The daemon's working directory (source working tree). When present, the
   * worktrees.setup.run rerun verb is registered over a worktree registry rooted
   * here (the same store worktrees.snapshot reads); absent → the verb stays
   * cataloged-but-unhandled, a graceful degrade for embeds with no worktree root.
   */
  readonly workingDirectory?: string | undefined;
  /**
   * Optional: a daemon-side conversation store port for the conversation half of
   * the unified rewind (rewind.plan/apply with scope 'conversation' or 'both').
   * When present, conversation rewind becomes available on the wire; absent (the
   * default — no daemon-hosted mutable conversation store is wired today) the
   * conversation part is honestly reported unavailable in a plan warning rather
   * than faked, exactly as before this parameter existed. The files half is
   * unaffected either way.
   */
  readonly conversationRewindPort?: RewindConversationPort | null | undefined;
  /**
   * The relay WebAuthn step-up ceremony service. When present, the
   * stepup.credentials.register + stepup.challenge.mint verbs are registered over
   * it — the SAME instance whose verifier the relay dispatch gate installs
   * (services.ts constructs one and threads it to both). Absent (an embed with no
   * relay wiring) → the verbs stay cataloged-but-unhandled, a graceful degrade.
   */
  readonly stepUpService?: StepUpGatewayService | undefined;
  /**
   * The canonical memory registry backing memory.projections.list/get. When
   * present, the read-only memory-projection verbs are registered over it;
   * absent (an embed with no memory store) → the verbs stay cataloged-but-
   * unhandled, a graceful degrade exactly like the other optional groups.
   */
  readonly memoryRegistry?: MemoryProjectionSource | undefined;
}

/** Adapt a fleet event payload down to the structural notice the push source needs. */
function toFleetNotice(event: FleetEvent): FleetNotice {
  return {
    type: event.type,
    nodeId: event.nodeId,
    ...('label' in event && event.label ? { label: event.label } : {}),
    ...('reason' in event && event.reason ? { reason: event.reason } : {}),
    ...('sessionId' in event && event.sessionId ? { sessionId: event.sessionId } : {}),
  };
}

export function registerGatewayVerbGroups(catalog: GatewayMethodCatalog, deps: GatewayVerbGroupDeps): void {
  registerFleetCheckpointsSearchGatewayMethods(catalog, deps);

  // The canonical skill service over a directory of Markdown documents under the
  // daemon's own state directory. Constructed here (from the shellPaths this
  // registrar already receives) rather than threaded through the runtime-services
  // composition root, exactly like the push group below.
  const skillService = new SkillService(
    new FileSystemSkillStore(deps.shellPaths.resolveUserPath('skills')),
  );
  registerSkillsGatewayMethods(catalog, skillService);

  // The shared registered-workspace registry: which project roots the operator
  // has opted into (coverage flows down each root's subtree, inherited through
  // the git worktree→main-repo link), over a JSON snapshot under the daemon's
  // control-plane state directory. The daemon state dir is resolveUserPath()
  // itself (~/.goodvibes); the home directory is its parent — both are refused
  // as absurdly broad roots by the same root-guard checkpointing uses.
  const daemonStateDir = deps.shellPaths.resolveUserPath();
  const workspaceRegistrationStore = new WorkspaceRegistrationStore({
    path: deps.shellPaths.resolveUserPath('control-plane', 'workspace-registrations.json'),
    homeDir: dirname(daemonStateDir),
    daemonStateDir,
  });
  registerWorkspacesGatewayMethods(catalog, workspaceRegistrationStore);

  // The cross-channel principal identity registry over a JSON snapshot under the
  // daemon's own control-plane state directory. Constructed here (from the
  // shellPaths this registrar already receives) rather than threaded through the
  // runtime-services composition root, exactly like the skill/push groups.
  const principalRegistry = new PrincipalRegistry(
    new PrincipalStore(deps.shellPaths.resolveUserPath('control-plane', 'principals.json')),
  );
  registerPrincipalsGatewayMethods(catalog, principalRegistry);

  // Per-channel profile bindings (model/permission defaults for the sessions a
  // channel originates), over a JSON snapshot under the daemon's control-plane
  // state directory. Constructed here like the principal/skill/push groups. The
  // intake helpers in ../../channel-profiles (attribution + profile resolution)
  // pair this registry with the principal registry above at the inbound seam.
  const channelProfileRegistry = new ChannelProfileRegistry(
    new ChannelProfileStore(deps.shellPaths.resolveUserPath('control-plane', 'channel-profiles.json')),
  );
  registerChannelProfilesGatewayMethods(catalog, channelProfileRegistry);

  // Wire the inbound-intake enrichment onto the transport intake chokepoint: from
  // here on, every channel-originated session is attributed to its sending
  // principal (via the registry just above) and inherits its channel's bound
  // profile — no per-adapter call needed. Uses the same two registries the
  // principals.*/channels.profiles.* verbs manage, so the mappings an operator
  // sets are exactly the mappings intake honors.
  if (deps.sessionIntake) {
    installInboundIntakeEnrichment(deps.sessionIntake, {
      principals: principalRegistry,
      channelProfiles: channelProfileRegistry,
    });
  }

  // CI-watch: the per-job status tool + standing subscriptions. The gh-CLI
  // source and the watch store are always available; the completion notifier
  // binds to the channel delivery router when present, and the opt-in fix-session
  // starts a one-shot isolated automation job when the automation manager is
  // present (absent → the trigger is recorded honestly but no session starts).
  const ciWatchService = new CiWatchService({
    source: createGhCliCiSource(),
    store: new CiWatchStore(deps.shellPaths.resolveUserPath('control-plane', 'ci-watches.json')),
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
  });
  registerCiGatewayMethods(catalog, ciWatchService);

  // channels.test.send — live per-channel test-message probe over the daemon's
  // delivery router. Registered only when the router is wired; absent, the verb
  // stays cataloged-but-unhandled rather than a facade that pretends to deliver.
  if (deps.channelDeliveryRouter) {
    registerChannelTestGatewayMethods(catalog, deps.channelDeliveryRouter);
  }

  // worktrees.setup.run — re-run cold-start setup on a live worktree. Registered
  // over a registry rooted at the daemon working directory (matching
  // worktrees.snapshot's reader) so the recorded outcome is visible there.
  if (deps.workingDirectory !== undefined) {
    const worktreeSetupRegistry = new WorktreeRegistry(deps.workingDirectory);
    const sourceRoot = deps.workingDirectory;
    registerWorktreeSetupGatewayMethods(catalog, {
      registry: worktreeSetupRegistry,
      sourceRoot,
      resolveConfig: () => resolveWorktreeSetupConfig((key) => (deps.configManager.get as unknown as (k: string) => unknown)(key)),
    });
  }

  // Proactive check-in (the "heartbeat initiative"): a briefing→judgment→
  // conditional-delivery loop that rides the automation scheduler as a
  // kind:'checkin' job. Registered only when the full runtime wired the channel
  // delivery router, provider registry, and automation manager (the pieces the
  // loop genuinely needs); absent → the verbs stay cataloged-but-unhandled,
  // never a facade that pretends to deliver.
  if (deps.channelDeliveryRouter && deps.providerRegistry && deps.automationManager && deps.sessionLister) {
    const channelDeliveryRouter = deps.channelDeliveryRouter;
    const automation = deps.automationManager;
    const sessionLister = deps.sessionLister;
    // The checkin.* keys are string-keyed (they live in the config defaults tree,
    // not the grandfathered ConfigKey union); adapt the daemon's ConfigManager to
    // the check-in's string-keyed config surface.
    const configManager = deps.configManager;
    const checkinConfig = {
      get: (key: string): unknown => (configManager.get as unknown as (k: string) => unknown)(key),
      set: (key: string, value: string | boolean): void =>
        (configManager.set as unknown as (k: string, v: string | boolean) => void)(key, value),
    };
    const checkinService = new CheckinService({
      config: checkinConfig,
      stateReader: createRuntimeCheckinStateReader({
        listSessions: () => sessionLister.listSessions(500),
        listRuns: () => automation.listRuns(),
      }),
      judge: createProviderBackedCheckinJudge(deps.providerRegistry),
      deliverer: {
        deliver: async (channel, message) => {
          const separator = channel.indexOf(':');
          const surfaceKind = (separator === -1 ? channel : channel.slice(0, separator)).trim();
          const address = separator === -1 ? '' : channel.slice(separator + 1).trim();
          const target: ChannelDeliveryTarget = {
            kind: 'surface',
            surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'],
            ...(address ? { address } : {}),
          };
          return channelDeliveryRouter.deliver({
            target,
            body: message,
            title: 'Check-in',
            jobId: 'checkin',
            runId: `checkin-${Date.now()}`,
            includeLinks: false,
          });
        },
      },
      receipts: new CheckinReceiptStore(deps.shellPaths.resolveUserPath('control-plane', 'checkin-receipts.json')),
      automation,
    });
    registerCheckinGatewayMethods(catalog, checkinService);
    void checkinService.attach().catch(() => {
      // Automation may be disabled at construction; the schedule syncs on the
      // next checkin.config.set once it is enabled. Never fail construction.
    });
  }

  // Session-scoped permission mode (get/set) + context-usage exposure on the
  // wire, over the daemon's own config + runtime store (its live local
  // runtime). Constructed here rather than threaded through the runtime-
  // services composition root, exactly like the skill/push groups above.
  registerSessionRuntimeGatewayMethods(
    catalog,
    createSessionRuntimeControls({ config: deps.configManager, store: deps.runtimeStore }),
  );

  const pushService = new PushService({
    vapid: new VapidManager(deps.secretsManager, { subject: deps.vapidSubject }),
    store: new PushSubscriptionStore(
      deps.shellPaths.resolveUserPath('control-plane', 'push-subscriptions.json'),
    ),
  });
  // Relay WebAuthn step-up ceremony verbs (register a credential, mint a
  // challenge). Registered only when the composition root threads the shared
  // service (the one whose verifier the relay gate installs).
  if (deps.stepUpService) {
    registerStepUpGatewayMethods(catalog, deps.stepUpService);
  }

  registerPushGatewayMethods(catalog, pushService);
  // Real event source: approvals-needed -> push to every registered device.
  // The unsubscribe handle is intentionally not retained — the subscription
  // lives for the daemon's lifetime, exactly like the fleet/checkpoint verb
  // registrations above (there is no RuntimeServices-wide shutdown seam yet).
  pushService.attachApprovalSource(deps.approvalBroker);

  // Second event source: a fleet node blocked on the operator -> a 'needs-input'
  // push carrying the session/node deep link, suppressed when an operator is
  // already attached to that session. Only when the runtime bus is wired.
  if (deps.runtimeBus) {
    const bus = deps.runtimeBus;
    const source: FleetNoticeSource = {
      subscribe: (listener) => bus.onDomain('fleet', (envelope) => listener(toFleetNotice(envelope.payload))),
    };
    pushService.attachFleetNeedsInputSource(source, deps.sessionPresence);
  }

  // Cost attribution + quota-window tracking over the platform's own LLM usage
  // records. Pricing uses the provider registry's catalog with the same
  // honest-unpriced gate as services.ts (unknown model -> unpriced, never a
  // fabricated cost); absent registry -> everything unpriced. The verbs are
  // always registered; ingestion is wired only when the runtime bus is present.
  const resolvePricing: ResolvePricing = (model) => {
    const registry = deps.providerRegistry;
    if (!model || !registry) return null;
    const known = registry.getRawCatalogModels().some(
      (entry) => model === entry.id || model.startsWith(entry.id) || model.includes(entry.id),
    );
    if (!known && !model.endsWith(':free')) return null;
    const pricing = registry.getCostFromCatalog(model);
    return { input: pricing.input, output: pricing.output };
  };
  const costAttribution = new CostAttributionService({ resolvePricing });
  const quotaWindow = new QuotaWindowTracker();
  registerCostGatewayMethods(catalog, { costAttribution, quotaWindow });

  // Memory projection read verbs (memory.projections.list/get) over the canonical
  // memory registry. Registered only when the memory store is wired; absent, the
  // verbs stay cataloged-but-unhandled rather than a facade over no store.
  if (deps.memoryRegistry) {
    registerMemoryProjectionsGatewayMethods(catalog, deps.memoryRegistry);
  }

  // Feature-flag graduation report: a read-only view over the static flag
  // registry + owner graduation annotations. Needs no runtime dependency (the
  // registry is static module data), so it is always registered. No live
  // evidence provider is threaded here yet — flags with instrumentation report
  // "no evidence collected this run" rather than a fabricated readiness.
  registerFlagsGraduationGatewayMethods(catalog);

  // runtime.metrics.get — the process-wide RuntimeMeter snapshot plus per-model
  // tool-format telemetry. Needs no runtime dependency (platformMeter and the
  // tool-format recorder are process-wide singletons), so it is always
  // registered, exactly like the flags-graduation report above.
  registerRuntimeMetricsGatewayMethods(catalog);

  // Unified message-anchored rewind (rewind.plan / rewind.apply): one coordinator
  // over the daemon's workspace-checkpoint store — files rewind reuses the same
  // manager checkpoints.* uses (never a fourth history system), and the pre-restore
  // safety checkpoint it already takes is the undo point that makes a rewind
  // reversible. The conversation half is wired only when a consumer threads a
  // conversationRewindPort (a daemon-hosted mutable conversation store); absent
  // — the default today — the conversation part is honestly reported unavailable
  // rather than faked. Receipt events fan out on the workspace domain when the
  // runtime bus is present.
  const rewindService = new UnifiedRewindService({
    workspace: deps.workspaceCheckpointManager,
    conversation: deps.conversationRewindPort ?? null,
    ...(deps.runtimeBus
      ? {
        emit: (event: WorkspaceEvent, sessionId: string): void => {
          const envelope = createEventEnvelope(event.type, event, { sessionId, source: 'rewind-service' });
          deps.runtimeBus!.emit<'workspace'>(
            'workspace',
            envelope as import('../../runtime/events/index.js').RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>,
          );
        },
      }
      : {}),
  });
  registerRewindGatewayMethods(catalog, rewindService);

  if (deps.runtimeBus) {
    deps.runtimeBus.onDomain('turn', (envelope) => {
      const event = envelope.payload;
      if (event.type === 'LLM_RESPONSE_RECEIVED') {
        costAttribution.record({
          at: Date.now(),
          provider: event.provider,
          model: event.model,
          sessionId: envelope.sessionId,
          // Attribution dimensions: the agent (from the envelope) and the
          // tool/hook/MCP-server cause (stamped on the event by the cost-origin
          // scope). Each is left undefined when the emit carried no such origin,
          // so a top-level reasoning call stays attributed to session/agent only.
          ...(envelope.agentId !== undefined ? { agentId: envelope.agentId } : {}),
          ...(event.originTool !== undefined ? { tool: event.originTool } : {}),
          ...(event.originHook !== undefined ? { hook: event.originHook } : {}),
          ...(event.originMcpServer !== undefined ? { mcpServer: event.originMcpServer } : {}),
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens ?? 0,
          cacheWriteTokens: event.cacheWriteTokens ?? 0,
        });
        // Quota snapshot from rate-limit headers carried on THIS (successful)
        // response — the pre-limit signal, not just the post-429 cooldown.
        if (event.rateLimit) {
          quotaWindow.record({
            provider: event.provider,
            at: Date.now(),
            ...(event.rateLimit.limit !== undefined ? { limit: event.rateLimit.limit } : {}),
            ...(event.rateLimit.remaining !== undefined ? { remaining: event.rateLimit.remaining } : {}),
            ...(event.rateLimit.resetAt !== undefined ? { resetAt: event.rateLimit.resetAt } : {}),
            ...(event.rateLimit.retryAfterMs !== undefined ? { retryAfterMs: event.rateLimit.retryAfterMs } : {}),
          });
        }
      } else if (event.type === 'STREAM_RETRY' && isRateLimitReason(event.reason)) {
        // A rate-limit retry carries the provider's requested backoff, which is
        // the real cooldown window the fan-out assessment reasons over.
        quotaWindow.record({ provider: event.provider, at: Date.now(), retryAfterMs: event.delayMs });
      }
    });
  }
}

/** Whether a STREAM_RETRY reason names a rate-limit/quota condition (as opposed to a transient network/server retry). */
function isRateLimitReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return lower.includes('rate') || lower.includes('quota') || lower.includes('429') || lower.includes('limit') || lower.includes('overloaded');
}
