import { ChannelPolicyManager } from '../policy-manager.js';
import type {
  ChannelAccountRecord,
  ChannelAllowlistEditInput,
  ChannelAllowlistEditResult,
  ChannelAllowlistResolution,
  ChannelAllowlistTarget,
  ChannelAllowlistTargetKind,
  ChannelConversationKind,
  ChannelDoctorCheck,
  ChannelDoctorReport,
  ChannelDoctorStatus,
  ChannelLifecycleState,
  ChannelRenderPolicy,
  ChannelRepairAction,
  ChannelResolvedTarget,
  ChannelSurface,
  ChannelTargetResolveOptions,
} from '../types.js';
import type { ChannelPlugin } from '../plugin-registry.js';
import {
  CHANNEL_SETUP_VERSION,
  type BuiltinChannelRuntimeDeps,
  configSectionForSurface,
} from './shared.js';
import { renderBuiltinPolicy, surfaceLabelForBuiltin } from './presentation.js';
import { getBuiltinSetupSchema } from './setup-schema.js';

interface BuiltinContractContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly channelPolicy: ChannelPolicyManager;
  readonly buildAccount: (surface: ChannelSurface) => Promise<ChannelAccountRecord>;
  readonly resolveAccount: (surface: ChannelSurface, accountId: string) => Promise<ChannelAccountRecord | null>;
  readonly resolveTarget: (surface: ChannelSurface, options: ChannelTargetResolveOptions) => Promise<ChannelResolvedTarget | null>;
}

export function buildBuiltinContractHooks(
  context: BuiltinContractContext,
  surface: ChannelSurface,
): Pick<
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
  return {
    setupVersion: CHANNEL_SETUP_VERSION,
    renderPolicy: () => renderBuiltinPolicy(surface),
    getSetupSchema: () => getBuiltinSetupSchema(surface),
    doctor: (accountId) => getBuiltinDoctorReport(context, surface, accountId),
    listRepairActions: (accountId) => listBuiltinRepairActions(context, surface, accountId),
    getLifecycleState: (accountId) => getBuiltinLifecycleState(context, surface, accountId),
    resolveAllowlist: (input) => resolveBuiltinAllowlist(context, surface, input),
    editAllowlist: (input) => editBuiltinAllowlist(context, surface, input),
  };
}

export async function listBuiltinRepairActions(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<readonly ChannelRepairAction[]> {
  const account = accountId ? await context.resolveAccount(surface, accountId) : await context.buildAccount(surface);
  const actions = (account?.actions ?? []).map((action): ChannelRepairAction => ({
    id: action.kind,
    label: action.label,
    description: `Run the ${action.kind} lifecycle action for ${surfaceLabelForBuiltin(surface)}.`,
    dangerous: action.kind === 'disconnect' || action.kind === 'logout',
    inputSchema: action.kind === 'disconnect' || action.kind === 'logout'
      ? {
          type: 'object',
          properties: {
            confirm: { type: 'boolean' },
          },
          required: ['confirm'],
        }
      : undefined,
    metadata: { actionId: action.id, available: action.available },
  }));
  return actions;
}

export async function getBuiltinDoctorReport(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<ChannelDoctorReport> {
  const account = accountId ? await context.resolveAccount(surface, accountId) : await context.buildAccount(surface);
  const effectiveAccount = account ?? await context.buildAccount(surface);
  const lifecycle = await getBuiltinLifecycleState(context, surface, accountId);
  const checks: ChannelDoctorCheck[] = [];
  const pushCheck = (id: string, label: string, status: ChannelDoctorStatus, detail: string, repairActionId?: string) => {
    checks.push({ id, label, status, detail, ...(repairActionId ? { repairActionId } : {}), metadata: {} });
  };

  pushCheck(
    'configured',
    'Configuration present',
    effectiveAccount.configured ? 'pass' : 'fail',
    effectiveAccount.configured
      ? 'Surface configuration or account identity is present.'
      : 'No durable configuration is present for this surface.',
    effectiveAccount.configured ? undefined : 'setup',
  );
  pushCheck(
    'credentials',
    'Credentials linked',
    effectiveAccount.linked ? 'pass' : effectiveAccount.configured ? 'warn' : 'fail',
    effectiveAccount.linked
      ? 'At least one secret source is available.'
      : effectiveAccount.configured
        ? 'Configuration exists but no linked credentials were detected.'
        : 'No credentials were detected.',
    effectiveAccount.linked ? undefined : 'retest',
  );
  pushCheck(
    'enabled',
    'Surface enabled',
    effectiveAccount.enabled ? 'pass' : 'warn',
    effectiveAccount.enabled
      ? 'Surface delivery is enabled for the current runtime.'
      : 'Surface delivery is disabled until it is enabled in config or env.',
    effectiveAccount.enabled ? undefined : 'start',
  );
  pushCheck(
    'lifecycle',
    'Lifecycle version',
    lifecycle.currentVersion >= lifecycle.targetVersion ? 'pass' : 'warn',
    lifecycle.currentVersion >= lifecycle.targetVersion
      ? `Setup metadata is at version ${lifecycle.currentVersion}.`
      : `Setup metadata is at version ${lifecycle.currentVersion}; target is ${lifecycle.targetVersion}.`,
  );

  const surfaces = context.deps.configManager.getCategory('surfaces');
  if (surface === 'telegram' && !surfaces.telegram.defaultChatId) {
    pushCheck('default-target', 'Default chat id', 'warn', 'No default Telegram chat id is configured; direct delivery requires a chat id or route binding.', 'setup');
  }
  if (surface === 'google-chat' && !surfaces.googleChat.webhookUrl && !surfaces.googleChat.spaceId) {
    pushCheck('space-routing', 'Space routing', 'warn', 'Google Chat has neither a webhook URL nor a default space id configured.', 'setup');
  }
  if (surface === 'signal' && !surfaces.signal.bridgeUrl) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'Signal requires a bridge URL.', 'setup');
  }
  if (surface === 'whatsapp' && !surfaces.whatsapp.phoneNumberId && surfaces.whatsapp.provider === 'meta-cloud') {
    pushCheck('provider-shape', 'Provider metadata', 'warn', 'Meta Cloud mode works best with a phone number id configured.', 'setup');
  }
  if (surface === 'imessage' && !surfaces.imessage.bridgeUrl) {
    pushCheck('bridge-url', 'Bridge URL', 'fail', 'iMessage requires a bridge URL or local companion endpoint.', 'setup');
  }
  if (surface === 'msteams' && !surfaces.msteams.appId) {
    pushCheck('app-id', 'App id', 'fail', 'Microsoft Teams requires an app id.', 'setup');
  }
  if (surface === 'msteams' && !surfaces.msteams.serviceUrl && !surfaces.msteams.defaultConversationId) {
    pushCheck('conversation-routing', 'Conversation routing', 'warn', 'Teams will deliver best after an inbound conversation reference has been captured or a default conversation id is configured.', 'setup');
  }
  if (surface === 'bluebubbles' && !surfaces.bluebubbles.serverUrl) {
    pushCheck('server-url', 'Server URL', 'fail', 'BlueBubbles requires a server URL.', 'setup');
  }
  if (surface === 'mattermost' && !surfaces.mattermost.baseUrl) {
    pushCheck('base-url', 'Base URL', 'fail', 'Mattermost requires a base URL.', 'setup');
  }
  if (surface === 'mattermost' && !surfaces.mattermost.defaultChannelId) {
    pushCheck('default-channel', 'Default channel', 'warn', 'No default Mattermost channel id is configured; proactive delivery will require route bindings.', 'setup');
  }
  if (surface === 'matrix' && !surfaces.matrix.homeserverUrl) {
    pushCheck('homeserver-url', 'Homeserver URL', 'fail', 'Matrix requires a homeserver URL.', 'setup');
  }
  if (surface === 'homeassistant' && !surfaces.homeassistant.webhookSecret) {
    pushCheck('webhook-secret', 'Webhook secret', 'fail', 'Home Assistant ingress requires a webhook secret because webhook routes are evaluated before daemon bearer auth.', 'setup');
  }
  if (surface === 'homeassistant' && !surfaces.homeassistant.instanceUrl) {
    pushCheck('instance-url', 'Instance URL', 'warn', 'Home Assistant REST-backed tools require an instance URL; daemon-only prompt ingress can work without one.', 'setup');
  }
  if (surface === 'homeassistant' && !surfaces.homeassistant.accessToken) {
    pushCheck('access-token', 'Long-lived access token', 'warn', 'Home Assistant state, service, template, and event-delivery tools require an access token.', 'setup');
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  const summary = failures > 0
    ? `${failures} failing checks and ${warnings} warnings.`
    : warnings > 0
      ? `${warnings} warnings; no failing checks.`
      : 'All checks passed.';

  return {
    surface,
    ...(accountId ? { accountId } : {}),
    state: effectiveAccount.state,
    summary,
    checkedAt: Date.now(),
    checks,
    repairActions: await listBuiltinRepairActions(context, surface, accountId),
    metadata: {
      accountId: effectiveAccount.accountId ?? effectiveAccount.id,
    },
  };
}

export async function getBuiltinLifecycleState(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  accountId?: string,
): Promise<ChannelLifecycleState> {
  const currentVersion = getConfiguredSetupVersion(context, surface);
  return {
    surface,
    ...(accountId ? { accountId } : {}),
    currentVersion,
    targetVersion: CHANNEL_SETUP_VERSION,
    metadata: {},
  };
}

export async function resolveBuiltinAllowlist(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  input: ChannelAllowlistEditInput,
): Promise<ChannelAllowlistResolution> {
  const requested = [...(input.add ?? []), ...(input.remove ?? [])];
  const resolved: ChannelAllowlistTarget[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const rawInput of requested) {
    const candidate = rawInput.trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const target = await context.resolveTarget(surface, {
      input: candidate,
      createIfMissing: true,
      ...(input.kind ? { preferredKind: preferredConversationKindForAllowlist(input.kind) } : {}),
    });
    if (!target) {
      unresolved.push(candidate);
      continue;
    }
    const kind = input.kind ?? allowlistTargetKindForResolvedTarget(target);
    const id = allowlistTargetId(kind, target);
    if (!id) {
      unresolved.push(candidate);
      continue;
    }
    resolved.push({
      kind,
      input: candidate,
      id,
      label: target.display ?? target.to,
      metadata: { target },
    });
  }
  return {
    surface,
    resolved,
    unresolved,
    metadata: {},
  };
}

export async function editBuiltinAllowlist(
  context: BuiltinContractContext,
  surface: ChannelSurface,
  input: ChannelAllowlistEditInput,
): Promise<ChannelAllowlistEditResult> {
  await context.channelPolicy.start();
  const resolution = await resolveBuiltinAllowlist(context, surface, input);
  const addInputs = new Set((input.add ?? []).map((value) => value.trim()).filter(Boolean));
  const removeInputs = new Set((input.remove ?? []).map((value) => value.trim()).filter(Boolean));
  const added = resolution.resolved.filter((entry) => addInputs.has(entry.input));
  const removed = resolution.resolved.filter((entry) => removeInputs.has(entry.input));
  const existing = context.channelPolicy.getPolicy(surface);
  const scoped = Boolean(input.groupId || input.channelId || input.workspaceId);

  if (scoped) {
    const match = existing.groupPolicies.find((entry) => (
      (input.groupId && entry.groupId === input.groupId)
      || (input.channelId && entry.channelId === input.channelId)
      || (input.workspaceId && entry.workspaceId === input.workspaceId)
    ));
    const nextGroup = {
      id: match?.id ?? `allowlist:${surface}:${input.groupId ?? input.channelId ?? input.workspaceId ?? 'scope'}`,
      ...(match?.label ? { label: match.label } : {}),
      ...(input.groupId ? { groupId: input.groupId } : match?.groupId ? { groupId: match.groupId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : match?.channelId ? { channelId: match.channelId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : match?.workspaceId ? { workspaceId: match.workspaceId } : {}),
      allowlistUserIds: applyAllowlistChanges(match?.allowlistUserIds ?? [], added.filter((entry) => entry.kind === 'user').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'user').map((entry) => entry.id)),
      allowlistChannelIds: applyAllowlistChanges(match?.allowlistChannelIds ?? [], added.filter((entry) => entry.kind === 'channel').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'channel').map((entry) => entry.id)),
      allowlistGroupIds: applyAllowlistChanges(match?.allowlistGroupIds ?? [], added.filter((entry) => entry.kind === 'group').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'group').map((entry) => entry.id)),
      metadata: match?.metadata ?? {},
    };
    const updated = await context.channelPolicy.upsertPolicy(surface, {
      groupPolicies: [
        ...existing.groupPolicies.filter((entry) => entry.id !== nextGroup.id),
        nextGroup,
      ],
    });
    return {
      surface,
      updatedPolicy: updated,
      resolution,
      metadata: { scoped: true, groupPolicyId: nextGroup.id },
    };
  }

  const updated = await context.channelPolicy.upsertPolicy(surface, {
    allowlistUserIds: applyAllowlistChanges(existing.allowlistUserIds, added.filter((entry) => entry.kind === 'user').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'user').map((entry) => entry.id)),
    allowlistChannelIds: applyAllowlistChanges(existing.allowlistChannelIds, added.filter((entry) => entry.kind === 'channel').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'channel').map((entry) => entry.id)),
    allowlistGroupIds: applyAllowlistChanges(existing.allowlistGroupIds, added.filter((entry) => entry.kind === 'group').map((entry) => entry.id), removed.filter((entry) => entry.kind === 'group').map((entry) => entry.id)),
  });
  return {
    surface,
    updatedPolicy: updated,
    resolution,
    metadata: { scoped: false },
  };
}

function getConfiguredSetupVersion(context: BuiltinContractContext, surface: ChannelSurface): number {
  if (surface === 'tui' || surface === 'web') return CHANNEL_SETUP_VERSION;
  const section = configSectionForSurface(surface);
  const surfaces = context.deps.configManager.getCategory('surfaces');
  return Number(surfaces[section].setupVersion ?? 0);
}

function applyAllowlistChanges(existing: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const next = new Set(existing);
  for (const value of add) {
    if (value.trim()) next.add(value.trim());
  }
  for (const value of remove) {
    if (value.trim()) next.delete(value.trim());
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}

function preferredConversationKindForAllowlist(kind: ChannelAllowlistTargetKind): ChannelConversationKind {
  if (kind === 'user') return 'direct';
  if (kind === 'channel') return 'channel';
  return 'group';
}

function allowlistTargetKindForResolvedTarget(target: ChannelResolvedTarget): ChannelAllowlistTargetKind {
  if (target.kind === 'direct') return 'user';
  if (target.kind === 'channel') return 'channel';
  return 'group';
}

function allowlistTargetId(kind: ChannelAllowlistTargetKind, target: ChannelResolvedTarget): string | null {
  if (kind === 'user') return target.to || null;
  if (kind === 'channel') return target.channelId ?? target.to ?? null;
  return target.groupId ?? target.threadId ?? target.channelId ?? target.to ?? null;
}
