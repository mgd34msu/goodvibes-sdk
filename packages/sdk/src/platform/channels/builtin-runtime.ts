import type { Tool } from '../types/tools.js';
import type {
  ChannelAccountLifecycleAction,
  ChannelAccountLifecycleResult,
  ChannelAccountRecord,
  ChannelActorAuthorizationRequest,
  ChannelActorAuthorizationResult,
  ChannelCapabilityDescriptor,
  ChannelConversationKind,
  ChannelDirectoryEntry,
  ChannelDirectoryQueryOptions,
  ChannelOperatorActionDescriptor,
  ChannelResolvedTarget,
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
  ChannelTargetResolveOptions,
  ChannelToolDescriptor,
} from './types.js';
import type { ChannelPlugin } from './plugin-registry.js';
import type { ProviderRuntimeSurface } from './provider-runtime.js';
import { buildBuiltinAccount, resolveBuiltinAccount } from './builtin/accounts.js';
import {
  buildBuiltinContractHooks,
  editBuiltinAllowlist,
  getBuiltinDoctorReport,
  getBuiltinLifecycleState,
  listBuiltinRepairActions,
  resolveBuiltinAllowlist,
} from './builtin/contracts.js';
import {
  listBuiltinCapabilities,
  listBuiltinOperatorActions,
  listBuiltinTools,
} from './builtin/descriptors.js';
import { runHomeAssistantOperatorAction } from './builtin/homeassistant.js';
import { getBuiltinSetupSchema } from './builtin/setup-schema.js';
import { TelegramIngressSupervisor, type TelegramIngressStatus } from './telegram/ingress.js';
import { logger } from '../utils/logger.js';
import { registerBuiltinChannelPlugins } from './builtin/plugins.js';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from './builtin/shared.js';
import type { InboundMailHealthEntry } from '../email/inbound/health.js';
import {
  authorizeBuiltinActorAction,
  runBuiltinAccountAction,
  runBuiltinProviderApi,
} from './builtin/account-actions.js';
import {
  readConversationKind,
  readDirectoryScope,
  readLifecycleAction,
} from './builtin/parsing.js';
import {
  listBuiltinAgentTools,
  notifyBuiltinApprovalViaRouter,
  renderBuiltinChannelEvent,
} from './builtin/rendering.js';
import { providerRuntimeStatus as providerRuntimeStatusForSurface } from './builtin/surfaces.js';
import {
  inferBuiltinTargetConversationKind,
  lookupBuiltinDirectory,
  parseBuiltinExplicitTarget,
  resolveBuiltinParentConversationCandidates,
  resolveBuiltinSessionTarget,
  resolveBuiltinTarget,
} from './builtin/targets.js';

export class BuiltinChannelRuntime {
  constructor(private readonly deps: BuiltinChannelRuntimeDeps) {}

  private telegramIngress: TelegramIngressSupervisor | null = null;
  private telegramConfigUnsubscribes: Array<() => void> = [];
  private telegramRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundMailConfigUnsubscribes: Array<() => void> = [];
  private inboundMailRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private consumerConflictHandler: ((detail: string) => void) | null = null;

  /**
   * Register who to tell when Telegram reports that ANOTHER process is already
   * long-polling this bot token (409, "terminated by other getUpdates").
   *
   * Late-bound on purpose: the composition root builds this runtime before it
   * builds the thing that decides which node consumes, and the report has to
   * reach that decision rather than dead-ending in a log line. Set before
   * startIngress() so the very first poll's conflict is routed.
   */
  setConsumerConflictHandler(handler: (detail: string) => void): void {
    this.consumerConflictHandler = handler;
  }

  /**
   * Arm the inbound paths that surfaces must actively establish.
   *
   * Registering an HTTP route is not enough for Telegram: it delivers nothing
   * until told a webhook URL exists or asked for updates. Called on daemon
   * start, after the HTTP listener is up so a registered webhook has somewhere
   * to land.
   */
  /**
   * The Telegram bot this node can actually read, or null when it cannot read
   * any — no token resolves, or the host gave no cursor storage to persist a
   * poll offset in.
   *
   * Read before the node contests the Telegram surface in the LAN election: a
   * node that cannot serve it must never win it, because the loser of that
   * election stands down and Telegram then goes unread by anybody.
   */
  async resolveServableTelegramBotId(): Promise<string | null> {
    if (!this.deps.telegramOffsetPath) return null;
    this.telegramIngress ??= this.buildTelegramIngress(this.deps.telegramOffsetPath);
    return this.telegramIngress.resolveServableBotId();
  }

  private buildTelegramIngress(offsetFilePath: string): TelegramIngressSupervisor {
    return new TelegramIngressSupervisor({
      configManager: this.deps.configManager,
      secretsManager: this.deps.secretsManager,
      serviceRegistry: this.deps.serviceRegistry,
      buildSurfaceAdapterContext: this.deps.buildSurfaceAdapterContext,
      offsetFilePath,
      onConcurrentConsumerConflict: (detail) => {
        this.consumerConflictHandler?.(detail);
        this.deps.onTelegramConsumerConflict?.(detail);
      },
    });
  }

  async startIngress(): Promise<void> {
    if (!this.deps.telegramOffsetPath) {
      // No surface-scoped storage was supplied, so a polling cursor cannot be
      // persisted. Say so rather than silently skipping inbound Telegram.
      if (this.deps.configManager.get('surfaces.telegram.enabled')) {
        logger.error('Telegram is enabled but is NOT receiving messages', {
          surface: 'telegram',
          reason: 'the host supplied no offset storage path, so the getUpdates cursor cannot be persisted',
          action: 'the embedder must pass telegramOffsetPath to BuiltinChannelRuntime to receive Telegram messages',
        });
      }
      return;
    }
    this.telegramIngress ??= this.buildTelegramIngress(this.deps.telegramOffsetPath);
    this.watchTelegramConfig();
    await this.telegramIngress.start();
  }

  /**
   * Re-decide ingress when the surface is reconfigured, so edits apply without
   * a restart — the same live-reload path an external settings edit takes.
   * start() stops any running loop first, so a mode change swaps cleanly rather
   * than leaving both a poll loop and a webhook armed.
   */
  private watchTelegramConfig(): void {
    if (this.telegramConfigUnsubscribes.length > 0) return;
    const keys = [
      'surfaces.telegram.enabled',
      'surfaces.telegram.mode',
      'surfaces.telegram.botToken',
      'surfaces.telegram.webhookSecret',
      'web.publicBaseUrl',
    ] as const;
    const restart = (): void => {
      // Coalesce: editing several keys in one save must re-decide once, not
      // once per key, or the modes race each other during the transition.
      if (this.telegramRestartTimer) clearTimeout(this.telegramRestartTimer);
      this.telegramRestartTimer = setTimeout(() => {
        this.telegramRestartTimer = null;
        void this.telegramIngress?.start().catch((error: unknown) => {
          logger.warn('Telegram ingress restart after a config change failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 250);
      (this.telegramRestartTimer as unknown as { unref?: () => void }).unref?.();
    };
    for (const key of keys) {
      this.telegramConfigUnsubscribes.push(this.deps.configManager.subscribe(key, restart));
    }
  }

  /** Tear the inbound paths down; the poll loop must not outlive the daemon. */
  async stopIngress(): Promise<void> {
    if (this.telegramRestartTimer) {
      clearTimeout(this.telegramRestartTimer);
      this.telegramRestartTimer = null;
    }
    for (const unsubscribe of this.telegramConfigUnsubscribes.splice(0)) unsubscribe();
    await this.telegramIngress?.stop();
  }

  /** Current inbound Telegram state, including why it is inactive. */
  telegramIngressStatus(): TelegramIngressStatus | null {
    return this.telegramIngress?.status ?? null;
  }

  // -------------------------------------------------------------------------
  // Inbound mail (docs/inbound-email.md §3.5)
  //
  // Beside the Telegram ingress methods rather than folded into
  // startIngress()/stopIngress(): each is its OWN cluster surface, and a node
  // that lost the Telegram election must still read the mailbox it did win.
  // Starting them together would re-couple exactly what the per-surface split
  // un-coupled.
  // -------------------------------------------------------------------------

  /** Arm inbound mail. Says so loudly when a mailbox is wanted and unwatched. */
  async startInboundMail(): Promise<void> {
    const supervisor = this.deps.inboundMail;
    if (!supervisor) {
      if (this.deps.configManager.get('surfaces.email.inbound.enabled')) {
        logger.error('Inbound mail is enabled but NO mailbox is being watched', {
          surface: 'email-inbound',
          reason: 'this composition supplied no inbound-mail supervisor',
          action: 'the embedder must pass inboundMail to BuiltinChannelRuntime to watch a mailbox',
        });
      }
      return;
    }
    this.watchInboundMailConfig();
    await supervisor.start();
  }

  /**
   * Re-probe the mailbox when a setting the running source re-reads changes.
   *
   * These five keys and no others, because the list is not "everything about
   * email" — it is exactly what `source-factory.ts`'s connection port resolves
   * again inside every `open()`. A corrected host, port or account is therefore
   * picked up by the reconnect this triggers, and an owner is told within
   * seconds whether the correction worked instead of waiting out
   * `capabilityRecheckMinutes`. Both spellings of host and account are watched
   * because `readSurfaceEmailSettings` genuinely reads both, and subscribing to
   * the one the owner did not edit is a subscription that never fires.
   *
   * What is deliberately NOT here: `surfaces.email.inbound.accounts`, `.mode`,
   * `.source` and the mailbox. Those decide which source is BUILT and which
   * mailbox it opens, so acting on them means a restart, not a re-probe —
   * `recheckNow()` on a running source cannot change what that source is. Wiring
   * them here would look like they took effect and they would not, which is the
   * failure this whole item is about, reproduced one level up.
   *
   * The password is not here either, and cannot be: it lives in the secrets
   * store, which has no change subscription. The reconnect still re-resolves it,
   * so a rotated password is picked up by any recheck — it just does not cause
   * one.
   *
   * Coalesced the same way the Telegram watcher coalesces its restart: saving a
   * settings page writes several keys, and one re-probe per key would be four
   * reconnections against a mail server for one edit.
   */
  private watchInboundMailConfig(): void {
    if (this.inboundMailConfigUnsubscribes.length > 0) return;
    const keys = [
      'surfaces.email.imap.host',
      'surfaces.email.imapHost',
      'surfaces.email.imap.port',
      'surfaces.email.user',
      'surfaces.email.username',
    ] as const;
    const recheck = (): void => {
      if (this.inboundMailRecheckTimer) clearTimeout(this.inboundMailRecheckTimer);
      this.inboundMailRecheckTimer = setTimeout(() => {
        this.inboundMailRecheckTimer = null;
        this.deps.inboundMail?.recheckNow();
      }, 250);
      (this.inboundMailRecheckTimer as unknown as { unref?: () => void }).unref?.();
    };
    for (const key of keys) {
      this.inboundMailConfigUnsubscribes.push(this.deps.configManager.subscribe(key, recheck));
    }
  }

  /**
   * Stop reading the mailbox and release its connection.
   *
   * Awaited, and it must not resolve early: the ordered cluster handoff tells
   * the successor node to start only after this promise settles, and two nodes
   * holding one mailbox both announce every message.
   */
  async stopInboundMail(): Promise<void> {
    if (this.inboundMailRecheckTimer) {
      clearTimeout(this.inboundMailRecheckTimer);
      this.inboundMailRecheckTimer = null;
    }
    for (const unsubscribe of this.inboundMailConfigUnsubscribes.splice(0)) unsubscribe();
    await this.deps.inboundMail?.stop();
  }

  /**
   * Email's health entry, read from the live supervisor.
   *
   * Deliberately not a `ChannelStatusSnapshot`: email is not a
   * `ManagedSurface`, and its state is what the watcher is DOING rather than
   * whether a credential happens to be present in the config file.
   */
  inboundMailHealth(): InboundMailHealthEntry | null {
    return this.deps.inboundMail?.health() ?? null;
  }

  /**
   * Which mailbox this node would watch, for the cluster election.
   *
   * Read before the node contests the surface: a node that watches no mailbox
   * must never win the election for one, because the loser stands down and the
   * mailbox then goes unread by anybody.
   */
  inboundMailIdentity(): { readonly account: string; readonly mailbox: string } | null {
    const health = this.deps.inboundMail?.health();
    return health ? { account: health.account, mailbox: health.mailbox } : null;
  }

  registerPlugins(): void {
    registerBuiltinChannelPlugins({
      deps: this.deps,
      buildAccount: (surface) => this.buildAccount(surface),
      resolveAccount: (surface, accountId) => this.resolveAccount(surface, accountId),
      listCapabilities: (surface) => this.listCapabilities(surface),
      listTools: (surface) => this.listTools(surface),
      runTool: (surface, toolId, input) => this.runTool(surface, toolId, input),
      listOperatorActions: (surface) => this.listOperatorActions(surface),
      runOperatorAction: (surface, actionId, input) => this.runOperatorAction(surface, actionId, input),
      buildContractHooks: (surface) => this.buildContractHooks(surface),
      buildProductHooks: (surface) => this.buildProductHooks(surface),
      lookupDirectory: (surface, query, options) => this.lookupDirectory(surface, query, options),
      lookupRouteDirectory: (surface, query, options) => this.lookupRouteDirectory(surface, query, options),
      notifyApprovalViaRouter: (surface, approval, binding) => this.notifyApprovalViaRouter(surface, approval, binding),
      providerRuntimeStatus: (surface) => this.providerRuntimeStatus(surface),
    });
  }

  private accountContext() {
    return {
      deps: this.deps,
      providerRuntimeStatus: (surface: ProviderRuntimeSurface) => this.providerRuntimeStatus(surface),
    };
  }

  async buildAccount(surface: ChannelSurface): Promise<ChannelAccountRecord> {
    return buildBuiltinAccount(this.accountContext(), surface);
  }

  async resolveAccount(surface: ChannelSurface, accountId: string): Promise<ChannelAccountRecord | null> {
    return resolveBuiltinAccount(this.accountContext(), surface, accountId);
  }

  private contractContext() {
    return {
      deps: this.deps,
      channelPolicy: this.deps.channelPolicy,
      buildAccount: (surface: ChannelSurface) => this.buildAccount(surface),
      resolveAccount: (surface: ChannelSurface, accountId: string) => this.resolveAccount(surface, accountId),
      resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => this.resolveTarget(surface, options),
    };
  }

  async listCapabilities(surface: ChannelSurface): Promise<ChannelCapabilityDescriptor[]> {
    const account = await this.buildAccount(surface);
    const plugin = this.deps.channelPlugins.getBySurface(surface);
    return listBuiltinCapabilities(surface, account, plugin?.capabilities ?? []);
  }

  listOperatorActions(surface: ChannelSurface): ChannelOperatorActionDescriptor[] {
    return listBuiltinOperatorActions(surface);
  }

  listTools(surface: ChannelSurface): ChannelToolDescriptor[] {
    return listBuiltinTools(surface);
  }

  async runTool(surface: ChannelSurface, toolId: string, input?: Record<string, unknown>): Promise<unknown> {
    const tool = this.listTools(surface).find((entry) => entry.id === toolId || entry.name === toolId);
    if (!tool) return null;
    const actionId = tool.actionIds[0]!;
    if (!actionId) return null;
    return this.runOperatorAction(surface, actionId, input);
  }

  async runOperatorAction(
    surface: ChannelSurface,
    actionId: string,
    input?: Record<string, unknown>,
  ): Promise<unknown> {
    if (surface === 'homeassistant') {
      const homeAssistantResult = await runHomeAssistantOperatorAction({ deps: this.deps }, actionId, input);
      if (homeAssistantResult.handled) return homeAssistantResult.result;
    }
    if (actionId === 'inspect-account') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return accountId ? this.resolveAccount(surface, accountId) : this.buildAccount(surface);
    }
    if (actionId === 'inspect-status') {
      return this.deps.channelPlugins.listStatus().then((entries) => entries.find((entry) => entry.surface === surface) ?? null);
    }
    if (actionId === 'setup-schema') {
      return this.getSetupSchema(surface);
    }
    if (actionId === 'doctor') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.getDoctorReport(surface, accountId);
    }
    if (actionId === 'repair-actions') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.listRepairActions(surface, accountId);
    }
    if (actionId === 'lifecycle-state') {
      const accountId = typeof input?.accountId === 'string' ? input.accountId : undefined;
      return this.getLifecycleState(surface, accountId);
    }
    if (actionId === 'list-directory') {
      const scope = readDirectoryScope(input?.scope);
      return this.deps.channelPlugins.queryDirectory(surface, {
        query: typeof input?.query === 'string' ? input.query : undefined,
        ...(scope ? { scope } : {}),
        groupId: typeof input?.groupId === 'string' ? input.groupId : undefined,
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      });
    }
    if (actionId === 'list-capabilities') {
      return this.listCapabilities(surface);
    }
    if (actionId === 'account-action') {
      const action = readLifecycleAction(input?.action ?? input?.accountAction);
      if (!action) {
        return {
          surface,
          ok: false,
          error: 'account-action requires a valid lifecycle action.',
        };
      }
      return this.runAccountAction(
        surface,
        action,
        typeof input?.accountId === 'string' ? input.accountId : undefined,
        input,
      );
    }
    if (actionId === 'resolve-target') {
      const targetInput = typeof input?.target === 'string'
        ? input.target
        : typeof input?.input === 'string'
          ? input.input
          : typeof input?.query === 'string'
            ? input.query
            : '';
      if (targetInput.trim().length === 0) {
        return {
          surface,
          ok: false,
          error: 'resolve-target requires "target" or "input".',
        };
      }
      const preferredKind = readConversationKind(input?.preferredKind);
      return this.resolveTarget(surface, {
        input: targetInput,
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(preferredKind ? { preferredKind } : {}),
        ...(typeof input?.threadId === 'string' ? { threadId: input.threadId } : {}),
        ...(typeof input?.createIfMissing === 'boolean' ? { createIfMissing: input.createIfMissing } : {}),
        ...(typeof input?.live === 'boolean' ? { live: input.live } : {}),
      });
    }
    if (actionId === 'authorize-actor-action') {
      const targetInput = typeof input?.target === 'string' ? input.target : undefined;
      const target = targetInput
        ? await this.resolveTarget(surface, {
            input: targetInput,
            ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
            createIfMissing: true,
          })
        : undefined;
      return this.authorizeActorAction(surface, {
        actionId: typeof input?.actionId === 'string' ? input.actionId : 'unknown',
        ...(typeof input?.actorId === 'string' ? { actorId: input.actorId } : {}),
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(target ? { target } : {}),
        metadata: {},
      });
    }
    if (actionId === 'resolve-allowlist') {
      return this.resolveAllowlist(surface, {
        ...(Array.isArray(input?.add) ? { add: input.add.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(Array.isArray(input?.remove) ? { remove: input.remove.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(input?.kind === 'user' || input?.kind === 'channel' || input?.kind === 'group' ? { kind: input.kind } : {}),
      });
    }
    if (actionId === 'edit-allowlist') {
      return this.editAllowlist(surface, {
        ...(Array.isArray(input?.add) ? { add: input.add.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(Array.isArray(input?.remove) ? { remove: input.remove.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(typeof input?.groupId === 'string' ? { groupId: input.groupId } : {}),
        ...(typeof input?.channelId === 'string' ? { channelId: input.channelId } : {}),
        ...(typeof input?.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
        ...(input?.kind === 'user' || input?.kind === 'channel' || input?.kind === 'group' ? { kind: input.kind } : {}),
        ...(typeof input?.metadata === 'object' && input.metadata !== null ? { metadata: input.metadata as Record<string, unknown> } : {}),
      });
    }
    if (actionId === 'provider-api') {
      return this.runProviderApi(surface, input);
    }
    return null;
  }

  private buildContractHooks(surface: ChannelSurface): Pick<
    ChannelPlugin,
    | 'setupVersion'
    | 'renderPolicy'
    | 'getSetupSchema'
    | 'doctor'
    | 'listRepairActions'
    | 'getLifecycleState'
    | 'resolveAllowlist'
    | 'editAllowlist'
  > {
    return buildBuiltinContractHooks(this.contractContext(), surface);
  }

  private getSetupSchema(surface: ChannelSurface) {
    return getBuiltinSetupSchema(surface);
  }

  private async listRepairActions(surface: ChannelSurface, accountId?: string) {
    return listBuiltinRepairActions(this.contractContext(), surface, accountId);
  }

  private async getDoctorReport(surface: ChannelSurface, accountId?: string) {
    return getBuiltinDoctorReport(this.contractContext(), surface, accountId);
  }

  private async getLifecycleState(surface: ChannelSurface, accountId?: string) {
    return getBuiltinLifecycleState(this.contractContext(), surface, accountId);
  }

  private async resolveAllowlist(surface: ChannelSurface, input: Parameters<typeof resolveBuiltinAllowlist>[2]) {
    return resolveBuiltinAllowlist(this.contractContext(), surface, input);
  }

  private async editAllowlist(surface: ChannelSurface, input: Parameters<typeof editBuiltinAllowlist>[2]) {
    return editBuiltinAllowlist(this.contractContext(), surface, input);
  }

  private buildProductHooks(surface: ChannelSurface): Pick<
    ChannelPlugin,
    | 'runAccountAction'
    | 'authorizeActorAction'
    | 'parseExplicitTarget'
    | 'inferTargetConversationKind'
    | 'resolveTarget'
    | 'resolveSessionTarget'
    | 'resolveParentConversationCandidates'
    | 'renderEvent'
    | 'listAgentTools'
  > {
    return {
      runAccountAction: (action, accountId, input) => this.runAccountAction(surface, action, accountId, input),
      authorizeActorAction: (request) => this.authorizeActorAction(surface, request),
      parseExplicitTarget: (input, options) => this.parseExplicitTarget(surface, input, options),
      inferTargetConversationKind: (input, options) => this.inferTargetConversationKind(input, options),
      resolveTarget: (options) => this.resolveTarget(surface, options),
      resolveSessionTarget: (target) => this.resolveSessionTarget(target),
      resolveParentConversationCandidates: (options) => this.resolveParentConversationCandidates(surface, options),
      renderEvent: (request) => this.renderChannelEvent(surface, request),
      listAgentTools: () => this.listAgentTools(surface),
    };
  }

  private async renderChannelEvent(surface: ChannelSurface, request: ChannelRenderRequest): Promise<ChannelRenderResult> {
    return renderBuiltinChannelEvent({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface, request);
  }

  private async notifyApprovalViaRouter(
    surface: ChannelSurface,
    approval: Parameters<typeof notifyBuiltinApprovalViaRouter>[2],
    binding: Parameters<typeof notifyBuiltinApprovalViaRouter>[3],
  ): Promise<void> {
    await notifyBuiltinApprovalViaRouter({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface, approval, binding);
  }

  private listAgentTools(surface: ChannelSurface): readonly Tool[] {
    return listBuiltinAgentTools({
      deps: this.deps,
      listTools: (currentSurface) => this.listTools(currentSurface),
      runTool: (currentSurface, toolId, input) => this.runTool(currentSurface, toolId, input),
    }, surface);
  }

  private async runAccountAction(
    surface: ChannelSurface,
    action: ChannelAccountLifecycleAction,
    accountId?: string,
    input?: Record<string, unknown>,
  ): Promise<ChannelAccountLifecycleResult> {
    return runBuiltinAccountAction({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, action, accountId, input);
  }

  private async authorizeActorAction(
    surface: ChannelSurface,
    request: ChannelActorAuthorizationRequest,
  ): Promise<ChannelActorAuthorizationResult> {
    return authorizeBuiltinActorAction({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, request);
  }

  private async runProviderApi(surface: ChannelSurface, input?: Record<string, unknown>): Promise<unknown> {
    return runBuiltinProviderApi({
      deps: this.deps,
      buildAccount: (currentSurface) => this.buildAccount(currentSurface),
      resolveAccount: (currentSurface, currentAccountId) => this.resolveAccount(currentSurface, currentAccountId),
    }, surface, input);
  }

  private parseExplicitTarget(
    surface: ChannelSurface,
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelResolvedTarget | null {
    return parseBuiltinExplicitTarget(surface, input, options);
  }

  private inferTargetConversationKind(
    input: string,
    options?: ChannelTargetResolveOptions,
  ): ChannelConversationKind {
    return inferBuiltinTargetConversationKind(input, options);
  }

  private async resolveTarget(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<ChannelResolvedTarget | null> {
    return resolveBuiltinTarget({ deps: this.deps }, surface, options);
  }

  private async resolveParentConversationCandidates(
    surface: ChannelSurface,
    options: ChannelTargetResolveOptions,
  ): Promise<readonly ChannelResolvedTarget[]> {
    return resolveBuiltinParentConversationCandidates({ deps: this.deps }, surface, options);
  }

  private resolveSessionTarget(target: ChannelResolvedTarget): string {
    return resolveBuiltinSessionTarget(target);
  }

  private providerRuntimeStatus(surface: ProviderRuntimeSurface): unknown {
    return providerRuntimeStatusForSurface(this.deps, surface);
  }

  private async lookupDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, options);
  }

  private async lookupRouteDirectory(
    surface: ManagedSurface,
    query: string,
    options?: ChannelDirectoryQueryOptions,
  ): Promise<ChannelDirectoryEntry[]> {
    return lookupBuiltinDirectory({ deps: this.deps }, surface, query, { ...options, live: false });
  }
}
