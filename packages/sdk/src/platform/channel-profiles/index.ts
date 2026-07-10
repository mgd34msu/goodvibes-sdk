/**
 * channel-profiles/ — per-channel profile bindings for channel intake.
 *
 * Each channel (a surface kind, optionally narrowed to one channel/account) can
 * bind a profile — the model/provider and permission-mode defaults applied to
 * the sessions that channel originates. The intake helpers here (attribution +
 * profile resolution) let the inbound path attribute an originated session to
 * its sending principal and inherit the channel's profile with a single call.
 */
export { ChannelProfileRegistry, type SetChannelProfileInput } from './registry.js';
export { ChannelProfileStore } from './store.js';
export {
  ChannelProfileError,
  CHANNEL_PERMISSION_MODES,
  channelProfileBindingId,
  type ChannelPermissionMode,
  type ChannelProfileBinding,
  type ChannelProfileDefaults,
  type ChannelProfileErrorCode,
} from './types.js';
export {
  attributeInboundSession,
  resolveOriginationProfile,
  applyChannelProfileToSpawn,
  buildInboundIntakeEnrichment,
  ATTRIBUTED_PRINCIPAL_ID_KEY,
  ATTRIBUTED_PRINCIPAL_NAME_KEY,
  ATTRIBUTED_PRINCIPAL_KNOWN_KEY,
  type InboundSender,
  type InboundIntakeEnrichment,
} from './intake.js';
