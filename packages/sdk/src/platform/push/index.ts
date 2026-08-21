/**
 * push/index.ts, the browser-push module barrel (VAPID custody, subscription
 * store, RFC 8291 encryption, and the delivery path). Daemon-side only; not
 * part of the runtime-neutral or browser bundles.
 */
export { encryptPushPayload } from './encryption.js';
export type { SubscriptionKeyMaterial, EncryptedPushPayload } from './encryption.js';
export {
  VapidManager,
  VAPID_SECRET_KEY,
  DEFAULT_VAPID_SUBJECT,
  VAPID_SUBJECT_HINT,
  isValidVapidSubject,
} from './vapid.js';
export type { VapidSecretStore, VapidManagerOptions } from './vapid.js';
export { PushSubscriptionStore, toPublicSubscription, endpointHashFor } from './subscription-store.js';
export type {
  RegisterSubscriptionInput,
  ReconcileResult,
  PushSubscriptionStoreOptions,
} from './subscription-store.js';
export {
  DEFAULT_PUSH_SUBSCRIPTION_POLICY,
  PushHousekeepingDisclosure,
  decidePushSweep,
  housekeepingPathFor,
  summarizePushSweep,
} from './subscription-housekeeping.js';
export type {
  PushSubscriptionPolicy,
  PushSubscriptionRemoval,
  PushSubscriptionRemovalReason,
  PushSubscriptionCrowding,
  PushSubscriptionSweepReport,
  PushSweepDecision,
} from './subscription-housekeeping.js';
export {
  PushSubscriptionValidationError,
  assertUsableSubscription,
  describeSubscriptionProblem,
  describeEndpointProblem,
  describeP256dhProblem,
  describeAuthSecretProblem,
  P256DH_POINT_BYTES,
  AUTH_SECRET_BYTES,
  MAX_PUSH_ENDPOINT_LENGTH,
} from './subscription-validation.js';
export type { PushSubscriptionField, PushSubscriptionProblem, PushSubscriptionCandidate } from './subscription-validation.js';
export { deliverToSubscription, deliverToAll, DELIVERY_FAILURE_PRUNE_THRESHOLD } from './delivery.js';
export type { PushTransport, DeliveryDeps } from './delivery.js';
export { PushService, DEFAULT_PUSH_ESCALATION } from './service.js';
export type {
  PushServiceDeps,
  SubscribeInput,
  ReconcileOutput,
  ApprovalSource,
  ApprovalNotice,
  FleetNotice,
  FleetNoticeSource,
  NeedsInputPresence,
  PushEscalationConfig,
  EscalationScheduler,
} from './service.js';
export type {
  StoredPushSubscription,
  PublicPushSubscription,
  PushDeliveryOutcome,
  PushDeliveryReceipt,
  PushUrgency,
  PushMessage,
  PushNotificationCategory,
  PushNotificationData,
  PushReconcileDrift,
} from './types.js';
