/**
 * Daemon-hosted session configuration.
 *
 * The engine lives in platform/hosted-sessions; this file is only its settings
 * surface. It is its own domain rather than another block inside
 * schema-domain-runtime.ts because that file is at its size ceiling.
 *
 * `detachPolicy` is the one people will actually change, and its default is
 * deliberate: `kill`. Detaching a client has always ended its work, everyone
 * expects that, and a capability landing must not silently redefine a familiar
 * action. Setting `survive` opts an installation into sessions that outlive the
 * client that opened them; a single session can also override the setting when
 * it is created.
 */
import { type ConfigSettingDefinition } from './schema-shared.js';

export interface HostedSessionsSettings {
  detachPolicy: 'kill' | 'survive';
  maxSessions: number;
  maxMessagesPerSession: number;
  terminatedRetentionMs: number;
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    hostedSessions: HostedSessionsSettings;
  }
}

export const hostedSessionsConfigDefaults = {
  hostedSessions: {
    detachPolicy: 'kill',
    maxSessions: 8,
    maxMessagesPerSession: 500,
    terminatedRetentionMs: 24 * 60 * 60_000,
  },
};

export const hostedSessionsConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'hostedSessions.detachPolicy',
    type: 'enum',
    default: 'kill',
    description: 'What happens to a daemon-hosted session when its last client detaches. kill (default): the session ends, which is what closing a client has always done. survive: the session stays alive and reattachable, so work continues while nothing is watching and you can pick it up again from any surface. A single session can override this when it is created.',
    enumValues: ['kill', 'survive'],
  },
  {
    key: 'hostedSessions.maxSessions',
    type: 'number',
    default: 8,
    description: 'How many daemon-hosted sessions may be live at once. Creating one past this is refused with the count and this setting named, rather than accepted and starved. Terminated sessions do not count.',
  },
  {
    key: 'hostedSessions.maxMessagesPerSession',
    type: 'number',
    default: 500,
    description: 'How many of a hosted session\'s most recent messages are written to disk. The transcript in memory is unaffected; this bounds what a restart can restore, so one long conversation cannot grow its file without limit.',
  },
  {
    key: 'hostedSessions.terminatedRetentionMs',
    type: 'number',
    default: 24 * 60 * 60_000,
    description: 'How long a terminated hosted session\'s record is kept before it is retired, in milliseconds. Until then it is still listable with its termination reason, so a session that ended can be asked about rather than having simply vanished.',
  },
];
