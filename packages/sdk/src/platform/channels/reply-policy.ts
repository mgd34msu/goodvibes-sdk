/**
 * The per-surface render policy every channel falls back to.
 *
 * Split out of reply-pipeline.ts, which owns the delivery DECISIONS (what to
 * send, when, once). This is the table those decisions are made against: how
 * much text a surface can carry, whether it threads, and what it is allowed to
 * show of the model's reasoning. A plugin that supplies its own policy
 * (ChannelPluginRegistry.getRenderPolicy) overrides the entry here.
 *
 * `reasoningVisibility: 'suppress'` on ntfy and telephony is load-bearing: a
 * lock screen and a phone call are the two surfaces where the model's thinking
 * is never what the reader asked for.
 */
import type { ChannelRenderPolicy, ChannelSurface } from './types.js';

export const DEFAULT_POLICY: Record<ChannelSurface, ChannelRenderPolicy> = {
  tui: {
    surface: 'tui',
    reasoningVisibility: 'public',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  web: {
    surface: 'web',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  slack: {
    surface: 'slack',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  discord: {
    surface: 'discord',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 2_500,
    maxEventsPerUpdate: 12,
    metadata: {},
  },
  ntfy: {
    surface: 'ntfy',
    reasoningVisibility: 'suppress',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 1_600,
    maxEventsPerUpdate: 6,
    metadata: {},
  },
  webhook: {
    surface: 'webhook',
    reasoningVisibility: 'private',
    format: 'json',
    supportsThreads: false,
    maxChunkChars: 12_000,
    maxEventsPerUpdate: 24,
    metadata: {},
  },
  homeassistant: {
    surface: 'homeassistant',
    reasoningVisibility: 'summary',
    format: 'json',
    supportsThreads: true,
    maxChunkChars: 8_000,
    maxEventsPerUpdate: 16,
    metadata: {},
  },
  telegram: {
    surface: 'telegram',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  'google-chat': {
    surface: 'google-chat',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  signal: {
    surface: 'signal',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  whatsapp: {
    surface: 'whatsapp',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  telephony: {
    surface: 'telephony',
    reasoningVisibility: 'suppress',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 1_400,
    maxEventsPerUpdate: 6,
    metadata: {},
  },
  imessage: {
    surface: 'imessage',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  msteams: {
    surface: 'msteams',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  bluebubbles: {
    surface: 'bluebubbles',
    reasoningVisibility: 'summary',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  mattermost: {
    surface: 'mattermost',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
  matrix: {
    surface: 'matrix',
    reasoningVisibility: 'summary',
    format: 'markdown',
    supportsThreads: true,
    maxChunkChars: 3_500,
    maxEventsPerUpdate: 10,
    metadata: {},
  },
};
