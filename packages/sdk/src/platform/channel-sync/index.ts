/**
 * platform/channel-sync — the two channel tables a daemon mirrors so a surface
 * draws the same screen on a second device.
 *
 * The routing table binds a channel to a profile identifier a person chose; the
 * draft mirror holds unsent messages they are composing. Both were cataloged as
 * verbs long before anything served them, which is why the descriptors carried
 * `invokable: false` — the contract said "cataloged, not callable" rather than
 * letting a caller find the 404 on their own.
 */

export { ChannelSyncRegistry } from './registry.js';
export type {
  AssignChannelRoutingInput,
  ListChannelDraftsOptions,
  ListChannelRoutingOptions,
} from './registry.js';

export { ChannelSyncStore } from './store.js';
export type { ChannelSyncTables } from './store.js';

export {
  CHANNEL_DRAFT_STATUSES,
  ChannelSyncError,
  channelRoutingRuleId,
  looksLikeLiveWebhook,
} from './types.js';
export type {
  ChannelDraft,
  ChannelDraftStatus,
  ChannelRoutingRule,
  ChannelSyncErrorCode,
} from './types.js';
