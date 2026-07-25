/**
 * Conversation-first spawn gate configuration.
 *
 * The gate itself lives in platform/agents/conversation-gate.ts; this file is
 * only its schema surface. It is a domain of its own rather than another block
 * inside schema-domain-runtime.ts because that file is at its size ceiling.
 *
 * `gatedSurfaces` is an array, so — like wrfc.gates — it is not a scalar
 * ConfigKey and is read through getCategory('conversationGate').
 */
import { type ConfigSettingDefinition } from './schema-shared.js';

export interface ConversationGateSettings {
  mode: 'propose' | 'confirm-all' | 'off';
  proposalTtlMs: number;
  maxPendingProposals: number;
  gatedSurfaces: string[];
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    conversationGate: ConversationGateSettings;
  }
}

export const conversationGateConfigDefaults = {
  conversationGate: {
    mode: 'propose',
    proposalTtlMs: 30 * 60_000,
    maxPendingProposals: 20,
    gatedSurfaces: [
      'ntfy',
      'telegram',
      'slack',
      'discord',
      'homeassistant',
      'google-chat',
      'signal',
      'whatsapp',
      'telephony',
      'imessage',
      'msteams',
      'bluebubbles',
      'mattermost',
      'matrix',
    ],
  },
};

export const conversationGateConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'conversationGate.mode',
    type: 'enum',
    default: 'propose',
    description: 'How inbound channel messages are treated. propose (default): a message gets a conversational reply, and anything that reads as a work request is proposed and waits for your agreement over the same channel. confirm-all: every inbound message is confirmed before any agent runs. off: an inbound message starts work immediately (pre-1.14 behavior). Never applies to goodvibes-tui, and never to already-authorized work such as schedules, triggers, and on-exit chains.',
    enumValues: ['propose', 'confirm-all', 'off'],
  },
  {
    key: 'conversationGate.proposalTtlMs',
    type: 'number',
    default: 30 * 60_000,
    description: 'How long an unanswered work proposal stays answerable, in milliseconds. After this it expires and a late reply is reported as expired rather than starting stale work. Clamped to 1 minute - 24 hours.',
  },
  {
    key: 'conversationGate.maxPendingProposals',
    type: 'number',
    default: 20,
    description: 'Maximum work proposals awaiting an answer at once across all channels. The oldest is dropped past this cap. Clamped to 1 - 200.',
  },
];
