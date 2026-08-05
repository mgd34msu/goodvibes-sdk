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
  /**
   * How long a client's attachment stands without renewal, in milliseconds.
   * An attachment is a claim about a live process; a client that crashed or
   * closed its tab makes no detach call, so the claim has to expire or a
   * kill-policy session waits for a departure that never arrives.
   */
  attachmentTtlMs: number;
  /**
   * Whether a surface that receives inbound channel messages hands the
   * conversation to the daemon to host instead of answering it in its own
   * process. Off by default: today an inbound message is answered by the
   * process that received it, and that is what people's channels already do.
   */
  promoteInboundConversations: boolean;
  /**
   * Whether this surface's OWN conversation turns run in the connected daemon
   * rather than in this process. On by default when a connected daemon is
   * there: the daemon is the loop host, so a turn keeps running when this
   * process goes away and every surface sees the same conversation.
   *
   * Distinct from {@link promoteInboundConversations}, which is about messages
   * arriving from a channel. This one is about what happens when the person in
   * front of this surface presses enter.
   *
   * Turning it off forces every turn to run locally. With no connected daemon
   * reachable, turns run locally regardless — and say so, once, in the
   * transcript.
   */
  routeConversationTurns: boolean;
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
    attachmentTtlMs: 10 * 60_000,
    promoteInboundConversations: false,
    routeConversationTurns: true,
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
  {
    key: 'hostedSessions.attachmentTtlMs',
    type: 'number',
    default: 10 * 60_000,
    description: 'How long a client stays attached to a daemon-hosted session without renewing, in milliseconds. Attaching again renews it, and a client whose control-plane connection is still open renews automatically. A client that crashed or closed its tab never detaches, so without this its attachment stands forever and a kill-policy session waits for a departure that never comes. When the last attachment lapses the session is treated as detached, and hostedSessions.detachPolicy decides what happens next. Clamped to at least 30 seconds and at most a day.',
  },
  {
    key: 'hostedSessions.promoteInboundConversations',
    type: 'boolean',
    default: false,
    description: 'Hand inbound channel conversations to the daemon to host, instead of answering them inside the surface process that received them. Off (default): a message from Telegram, Slack, email or any other channel is answered by that process, and it stops when the process stops. On: the first message of a conversation creates a daemon-hosted session and every later message is steered into it, so the conversation keeps its context and keeps running while no surface is open. What happens when the last client leaves is still hostedSessions.detachPolicy.',
  },
  {
    key: 'hostedSessions.routeConversationTurns',
    type: 'boolean',
    default: true,
    description: 'Run this surface\'s own conversation turns inside the connected daemon rather than in this process. On (the default) and with a connected daemon reachable: the first message of a conversation creates a daemon-hosted session rooted at this surface\'s working directory, every later message is steered into it, and this surface renders the turn from the daemon\'s event stream — so the turn survives this process closing and every surface sees one conversation. The daemon holds the authoritative transcript; this surface still keeps its own local record of what the stream delivered. Off: every turn runs in this process, as it always did. With no connected daemon reachable the turn runs locally regardless, and the transcript says so in one line naming the reason — it is never silent about where a turn ran. This is about what happens when you press enter; hostedSessions.promoteInboundConversations is the same question for messages arriving from a channel.',
  },
];
