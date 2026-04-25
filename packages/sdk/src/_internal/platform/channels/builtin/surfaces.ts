import type { ProviderRuntimeSurface } from '../provider-runtime.js';
import type { ChannelSurface } from '../types.js';
import type { BuiltinChannelRuntimeDeps, ManagedSurface } from './shared.js';
import { resolveSecretInput } from '../../config/secret-refs.js';

export function asProviderRuntimeSurface(surface: ChannelSurface): ProviderRuntimeSurface | null {
  return surface === 'slack' || surface === 'discord' || surface === 'ntfy' ? surface : null;
}

export function isManagedSurface(surface: ChannelSurface): surface is ManagedSurface {
  return surface === 'slack'
    || surface === 'discord'
    || surface === 'ntfy'
    || surface === 'webhook'
    || surface === 'telegram'
    || surface === 'google-chat'
    || surface === 'signal'
    || surface === 'whatsapp'
    || surface === 'imessage'
    || surface === 'msteams'
    || surface === 'bluebubbles'
    || surface === 'mattermost'
    || surface === 'matrix';
}

export function providerRuntimeStatus(deps: BuiltinChannelRuntimeDeps, surface: ProviderRuntimeSurface): unknown {
  return deps.providerRuntime?.status(surface) ?? null;
}

export function providerEnvBacked(surface: ProviderRuntimeSurface): boolean {
  if (surface === 'slack') return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN);
  if (surface === 'discord') return Boolean(process.env.DISCORD_BOT_TOKEN);
  return Boolean(process.env.NTFY_ACCESS_TOKEN);
}

export async function resolveSlackBotToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('slack', 'primary');
  const configValue = await resolveBuiltinConfigSecret(deps, deps.configManager.get('surfaces.slack.botToken'));
  return serviceValue
    || configValue
    || process.env.SLACK_BOT_TOKEN
    || null;
}

export async function resolveSlackAppToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('slack', 'appToken');
  const configValue = await resolveBuiltinConfigSecret(deps, deps.configManager.get('surfaces.slack.appToken'));
  return serviceValue
    || configValue
    || process.env.SLACK_APP_TOKEN
    || null;
}

export async function resolveDiscordBotToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('discord', 'primary');
  const configValue = await resolveBuiltinConfigSecret(deps, deps.configManager.get('surfaces.discord.botToken'));
  return serviceValue
    || configValue
    || process.env.DISCORD_BOT_TOKEN
    || null;
}

export async function resolveNtfyToken(deps: BuiltinChannelRuntimeDeps): Promise<string | null> {
  const serviceValue = await deps.serviceRegistry.resolveSecret('ntfy', 'primary');
  const configValue = await resolveBuiltinConfigSecret(deps, deps.configManager.get('surfaces.ntfy.token'));
  return serviceValue
    || configValue
    || process.env.NTFY_ACCESS_TOKEN
    || null;
}

async function resolveBuiltinConfigSecret(
  deps: BuiltinChannelRuntimeDeps,
  value: unknown,
): Promise<string | null> {
  return resolveSecretInput(value, {
    resolveLocalSecret: (key) => deps.secretsManager.get(key),
    homeDirectory: deps.secretsManager.getGlobalHome?.() ?? undefined,
  });
}
