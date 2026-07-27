import type {
  ChannelAccountLifecycleAction,
  ChannelConversationKind,
  ChannelDirectoryScope,
} from '../types.js';
import type { SecretScope } from '../../config/secrets-store-paths.js';

export function readLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
  return value === 'inspect'
    || value === 'setup'
    || value === 'retest'
    || value === 'connect'
    || value === 'disconnect'
    || value === 'start'
    || value === 'stop'
    || value === 'login'
    || value === 'logout'
    || value === 'wait_login'
    ? value
    : null;
}

export function readConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}

export function readDirectoryScope(value: unknown): ChannelDirectoryScope | null {
  return value === 'all'
    || value === 'self'
    || value === 'users'
    || value === 'peers'
    || value === 'groups'
    || value === 'channels'
    || value === 'threads'
    || value === 'services'
    || value === 'members'
    ? value
    : null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  return undefined;
}

/**
 * Read a caller-supplied secret scope, defaulting to `project` as it always has.
 *
 * `daemon` is accepted because these actions store CHANNEL credentials, and a
 * channel is served by the daemon: an operator setting up Slack or Discord for
 * a machine that may hand the surface over at failover needs to say "this
 * belongs to the daemon, not to this checkout". Refusing the value here would
 * have silently downgraded such a request to `project` — the setup would report
 * success and put the token somewhere the daemon does not read back.
 *
 * The default stays `project` rather than following the key's ownership: these
 * are bare operator-chosen names (`SLACK_BOT_TOKEN`), not names derived from a
 * daemon-owned config path, so nothing here can tell which runtime consumes
 * them without being told.
 */
export function readSecretScope(value: unknown): SecretScope {
  if (value === 'user') return 'user';
  if (value === 'daemon') return 'daemon';
  return 'project';
}
