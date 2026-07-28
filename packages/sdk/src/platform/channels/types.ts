/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Shared channel and route-binding contracts for omnichannel control surfaces.
 */

export type ChannelSurface =
  | 'tui'
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'homeassistant'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'telephony'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';
export type ChannelCapability =
  | 'ingress'
  | 'egress'
  | 'threaded_reply'
  | 'interactive_actions'
  | 'session_binding'
  | 'delivery_only'
  | 'account_lifecycle'
  | 'target_resolution'
  | 'agent_tools';
export type ChannelConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';
export type ChannelDirectoryKind = 'self' | 'user' | 'channel' | 'group' | 'thread' | 'member' | 'service';
export type ChannelDirectoryScope = 'all' | 'self' | 'users' | 'peers' | 'groups' | 'channels' | 'threads' | 'services' | 'members';
export type ChannelPolicyMatchScope = 'surface' | 'group';
export type ChannelConversationPolicy = 'allow' | 'deny' | 'inherit';
export type ChannelAccountState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
export type ChannelAuthState = 'linked' | 'configured' | 'not-configured' | 'degraded';
/**
 * Where a channel secret came from. `unresolved` is the case config alone
 * cannot express: a value IS declared, and it resolves to nothing here.
 */
export type ChannelSecretSource = 'service-registry' | 'config' | 'env' | 'derived' | 'unresolved' | 'missing';
export type ChannelCapabilityScope = 'surface' | 'accounts' | 'directory' | 'delivery' | 'interaction' | 'tooling';
export type ChannelAccountLifecycleAction =
  | 'inspect'
  | 'setup'
  | 'retest'
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'stop'
  | 'login'
  | 'logout'
  | 'wait_login';
export type ChannelTargetSource = 'explicit' | 'directory' | 'route' | 'normalized' | 'synthetic' | 'miss';

export interface ChannelIdentity {
  surface: ChannelSurface;
  accountId?: string | undefined;
  workspaceId?: string | undefined;
  channelId?: string | undefined;
  threadId?: string | undefined;
  messageId?: string | undefined;
  userId?: string | undefined;
}

export interface ChannelRouteBinding {
  id: string;
  surface: ChannelSurface;
  identity: ChannelIdentity;
  sessionId?: string | undefined;
  automationJobId?: string | undefined;
  replyTarget?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelAdapterDescriptor {
  id: string;
  surface: ChannelSurface;
  displayName: string;
  capabilities: ChannelCapability[];
  setupVersion?: number | undefined;
}

export interface ChannelDirectoryEntry {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly kind: ChannelDirectoryKind;
  readonly label: string;
  readonly handle?: string | undefined;
  readonly accountId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly memberCount?: number | undefined;
  readonly memberIds?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly isSelf?: boolean | undefined;
  readonly isDirect?: boolean | undefined;
  readonly isGroupConversation?: boolean | undefined;
  readonly searchText?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDirectoryQueryOptions {
  readonly query?: string | undefined;
  readonly scope?: ChannelDirectoryScope | undefined;
  readonly groupId?: string | undefined;
  readonly limit?: number | undefined;
  readonly live?: boolean | undefined;
}

export interface ChannelTargetResolveOptions {
  readonly input: string;
  readonly accountId?: string | undefined;
  readonly preferredKind?: ChannelConversationKind | undefined;
  readonly threadId?: string | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly live?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelResolvedTarget {
  readonly surface: ChannelSurface;
  readonly input: string;
  readonly normalized: string;
  readonly kind: ChannelConversationKind;
  readonly to: string;
  readonly display?: string | undefined;
  readonly accountId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionTarget?: string | undefined;
  readonly bindingId?: string | undefined;
  readonly directoryEntryId?: string | undefined;
  readonly source: ChannelTargetSource;
  readonly metadata: Record<string, unknown>;
}

/**
 * What a channel's reported state MEANS.
 *
 * These answer "can this channel send and receive right now", which is a
 * different question from "are its credentials present". The two were the same
 * value until a Telegram bot whose ingress had died kept reporting `healthy`
 * because its token was still in config — the owner sent a message, got
 * nothing back, and every surface agreed everything was fine.
 *
 * - `healthy`      — something observed the live path and it is working.
 * - `degraded`     — observed and partially working; delivery is at risk.
 * - `dead`         — observed and NOT working, while configured and switched
 *                    on. The state the old shape could not express at all.
 * - `unknown`      — configured and switched on, but nothing on this node can
 *                    see whether it works. An honest unknown, never a green.
 * - `unresolved`   — a credential is DECLARED but does not resolve in the store
 *                    this process reads. The channel cannot send, and that is
 *                    knowable without attempting one. Measured on this project's
 *                    own machine: the daemon's `surfaces.telegram.botToken` held
 *                    `goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN` while the
 *                    daemon's own store was `{}` and the token lived in the
 *                    agent's and the TUI's stores instead. Every send failed with
 *                    "Missing Telegram bot token"; every surface said healthy.
 * - `unconfigured` — nothing is declared at all, so it was never going to work.
 *                    Distinct from `unresolved`: nobody believes it is set up.
 * - `disabled`     — switched off on purpose; not a fault.
 */
export type ChannelHealthState =
  | 'healthy'
  | 'degraded'
  | 'dead'
  | 'unknown'
  | 'unresolved'
  | 'unconfigured'
  | 'disabled';

/**
 * What this node can actually SEE of a channel's live inbound/outbound path.
 *
 * `observable` is the honesty gate. A surface the daemon serves by registering
 * an HTTP route and waiting cannot tell a working provider from a silent one,
 * and must say so rather than let configuration stand in for liveness.
 */
export interface ChannelRuntimeObservation {
  /** True when something here genuinely watches the live path. */
  readonly observable: boolean;
  /** Live state when `observable`; null when nothing here can tell. */
  readonly running: boolean | null;
  /**
   * Plain-language account of the state above, and — when it is not working —
   * the specific thing to change. Never empty.
   */
  readonly reason: string;
  /** The most recent failure this surface reported, when one is known. */
  readonly lastError?: string | undefined;
  /** When the observation was taken (epoch ms). */
  readonly observedAt?: number | undefined;
}

export interface ChannelStatusSnapshot {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly state: ChannelHealthState;
  readonly enabled: boolean;
  /** True when a credential for this surface is DECLARED in any backend. */
  readonly configured?: boolean | undefined;
  /**
   * True when a declared credential actually resolves to a value in the store
   * this process reads. Separate from `configured` because the gap between them
   * is its own failure: a `goodvibes://secrets/...` reference pointing at a key
   * that is not in THIS surface's store reads as configured and sends nothing.
   */
  readonly credentialResolves?: boolean | undefined;
  /**
   * What the state was derived from. Present on every snapshot the built-in
   * runtime produces; optional so a third-party plugin that only knows its own
   * state is still a valid plugin.
   */
  readonly runtime?: ChannelRuntimeObservation | undefined;
  readonly accountId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelSecretStatus {
  readonly field: string;
  readonly label: string;
  /** A value or a reference is DECLARED for this field. */
  readonly configured: boolean;
  /**
   * The declared value actually resolves to a secret in the store this process
   * reads. False with `configured` true is the shape that bit: a reference
   * naming a key another surface's store holds and this one does not.
   */
  readonly resolved?: boolean | undefined;
  readonly source: ChannelSecretSource;
}

export interface ChannelAccountAction {
  readonly id: string;
  readonly label: string;
  readonly kind: ChannelAccountLifecycleAction;
  readonly available: boolean;
}

export interface ChannelAccountRecord {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly linked: boolean;
  readonly state: ChannelAccountState;
  readonly authState: ChannelAuthState;
  readonly accountId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly secrets: readonly ChannelSecretStatus[];
  readonly actions: readonly ChannelAccountAction[];
  readonly metadata: Record<string, unknown>;
}

export interface ChannelCapabilityDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly scope: ChannelCapabilityScope;
  readonly supported: boolean;
  readonly detail: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelToolDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly name: string;
  readonly description: string;
  readonly actionIds: readonly string[];
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelOperatorActionDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly description: string;
  readonly dangerous: boolean;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAccountLifecycleResult {
  readonly surface: ChannelSurface;
  readonly accountId?: string | undefined;
  readonly action: ChannelAccountLifecycleAction;
  readonly ok: boolean;
  readonly state?: ChannelAccountState | undefined;
  readonly authState?: ChannelAuthState | undefined;
  readonly account?: ChannelAccountRecord | null | undefined;
  readonly message?: string | undefined;
  readonly login?: {
    readonly kind: 'none' | 'browser' | 'qr' | 'manual';
    readonly url?: string | undefined;
    readonly qr?: string | undefined;
    readonly expiresAt?: number | undefined;
    readonly instructions?: string | undefined;
  };
  readonly metadata: Record<string, unknown>;
}

export interface ChannelActorAuthorizationRequest {
  readonly actorId?: string | undefined;
  readonly actionId: string;
  readonly accountId?: string | undefined;
  readonly target?: ChannelResolvedTarget | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelActorAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly account?: ChannelAccountRecord | null | undefined;
  readonly actionAvailable?: boolean | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelPolicyRecord {
  readonly surface: ChannelSurface;
  readonly enabled: boolean;
  readonly requireMention: boolean;
  readonly allowDirectMessages: boolean;
  readonly allowGroupMessages: boolean;
  readonly allowThreadMessages: boolean;
  readonly dmPolicy: ChannelConversationPolicy;
  readonly groupPolicy: ChannelConversationPolicy;
  readonly allowTextCommandsWithoutMention: boolean;
  readonly allowlistUserIds: readonly string[];
  readonly allowlistChannelIds: readonly string[];
  readonly allowlistGroupIds: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly groupPolicies: readonly ChannelGroupPolicyRecord[];
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelGroupPolicyRecord {
  readonly id: string;
  readonly label?: string | undefined;
  readonly groupId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly requireMention?: boolean | undefined;
  readonly allowGroupMessages?: boolean | undefined;
  readonly allowThreadMessages?: boolean | undefined;
  readonly allowTextCommandsWithoutMention?: boolean | undefined;
  readonly allowlistUserIds?: readonly string[] | undefined;
  readonly allowlistChannelIds?: readonly string[] | undefined;
  readonly allowlistGroupIds?: readonly string[] | undefined;
  readonly allowedCommands?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelPolicyAuditRecord {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly createdAt: number;
  readonly allowed: boolean;
  readonly reason: string;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly conversationKind?: ChannelConversationKind | undefined;
  readonly matchedGroupPolicyId?: string | undefined;
  readonly text?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelIngressPolicyInput {
  readonly surface: ChannelSurface;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly conversationKind?: ChannelConversationKind | undefined;
  readonly hasAnyMention?: boolean | undefined;
  readonly text?: string | undefined;
  readonly mentioned?: boolean | undefined;
  readonly controlCommand?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policy: ChannelPolicyRecord;
  readonly matchedGroupPolicy?: ChannelGroupPolicyRecord | undefined;
  readonly matchedScope?: ChannelPolicyMatchScope | undefined;
  readonly effectiveRequireMention?: boolean | undefined;
  readonly effectiveAllowedCommands?: readonly string[] | undefined;
}

export type ChannelSecretBackend =
  | 'env'
  | 'goodvibes'
  | 'service-registry'
  | '1password'
  | 'bitwarden'
  | 'vaultwarden'
  | 'bitwarden-secrets-manager'
  | 'bws'
  | 'manual';

export type ChannelSetupFieldKind =
  | 'string'
  | 'secret'
  | 'url'
  | 'boolean'
  | 'number'
  | 'select';

export type ChannelDoctorStatus = 'pass' | 'warn' | 'fail';
export type ChannelAllowlistTargetKind = 'user' | 'channel' | 'group';
export type ChannelReasoningVisibility = 'suppress' | 'private' | 'public' | 'summary';
export type ChannelRenderFormat = 'plain' | 'markdown' | 'json';
export type ChannelRenderPhase = 'progress' | 'final' | 'approval';
export type ChannelRenderEventKind =
  | 'assistant_text'
  | 'reasoning'
  | 'tool_start'
  | 'tool_result'
  | 'plan'
  | 'approval'
  | 'command_output'
  | 'patch'
  | 'compaction'
  | 'model'
  | 'status'
  | 'error';

export interface ChannelSecretTargetDescriptor {
  readonly id: string;
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly required: boolean;
  readonly supports: readonly ChannelSecretBackend[];
  readonly serviceName?: string | undefined;
  readonly serviceField?: string | undefined;
  readonly envKeys?: readonly string[] | undefined;
  readonly configKeys?: readonly string[] | undefined;
  readonly detail?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelSetupFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface ChannelSetupFieldDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: ChannelSetupFieldKind;
  readonly required: boolean;
  readonly detail?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly configKey?: string | undefined;
  readonly secretTargetId?: string | undefined;
  readonly defaultValue?: string | number | boolean | undefined;
  readonly options?: readonly ChannelSetupFieldOption[] | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelSetupSchema {
  readonly surface: ChannelSurface;
  readonly version: number;
  readonly label: string;
  readonly setupMode: 'config' | 'oauth' | 'bot' | 'bridge' | 'webhook';
  readonly description: string;
  readonly fields: readonly ChannelSetupFieldDescriptor[];
  readonly secretTargets: readonly ChannelSecretTargetDescriptor[];
  readonly externalSteps: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: ChannelDoctorStatus;
  readonly detail: string;
  readonly repairActionId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelRepairAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly dangerous: boolean;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDoctorReport {
  readonly surface: ChannelSurface;
  readonly accountId?: string | undefined;
  /**
   * The same health question the status snapshot answers, resolved by the same
   * rule. It used to be the ACCOUNT state — credential presence — so `doctor`
   * on a Telegram bot whose ingress had died reported `healthy`, which is the
   * one answer a doctor must never give a broken thing.
   */
  readonly state: ChannelHealthState;
  /** What this node can see of the live path; the basis for `state`. */
  readonly runtime?: ChannelRuntimeObservation | undefined;
  readonly summary: string;
  readonly checkedAt: number;
  readonly checks: readonly ChannelDoctorCheck[];
  readonly repairActions: readonly ChannelRepairAction[];
  readonly metadata: Record<string, unknown>;
}

export interface ChannelLifecycleState {
  readonly surface: ChannelSurface;
  readonly accountId?: string | undefined;
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAllowlistTarget {
  readonly kind: ChannelAllowlistTargetKind;
  readonly input: string;
  readonly id: string;
  readonly label: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAllowlistResolution {
  readonly surface: ChannelSurface;
  readonly resolved: readonly ChannelAllowlistTarget[];
  readonly unresolved: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface ChannelAllowlistEditInput {
  readonly add?: readonly string[] | undefined;
  readonly remove?: readonly string[] | undefined;
  readonly groupId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly kind?: ChannelAllowlistTargetKind | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ChannelAllowlistEditResult {
  readonly surface: ChannelSurface;
  readonly updatedPolicy: ChannelPolicyRecord;
  readonly resolution: ChannelAllowlistResolution;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelRenderEvent {
  readonly id: string;
  readonly kind: ChannelRenderEventKind;
  readonly phase: ChannelRenderPhase;
  readonly ts: number;
  readonly text?: string | undefined;
  readonly title?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly toolName?: string | undefined;
  readonly callId?: string | undefined;
  readonly summary?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelRenderPolicy {
  readonly surface: ChannelSurface;
  readonly reasoningVisibility: ChannelReasoningVisibility;
  readonly format: ChannelRenderFormat;
  readonly supportsThreads: boolean;
  readonly maxChunkChars: number;
  readonly maxEventsPerUpdate: number;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelRenderRequest {
  readonly surface: ChannelSurface;
  readonly phase: ChannelRenderPhase;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly title: string;
  readonly text: string;
  readonly events: readonly ChannelRenderEvent[];
  readonly pending?: Record<string, unknown> | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelRenderResult {
  readonly delivered: boolean;
  readonly responseId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}
