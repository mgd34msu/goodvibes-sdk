/**
 * schema-domain-push.ts — browser push subscription custody (`push.*`).
 *
 * These are the knobs over the daemon's `push-subscriptions.json`: the contact
 * a push service can reach the operator on, how many registered devices per
 * operator is worth mentioning, when a push service has proved an endpoint
 * dead, and how often housekeeping runs.
 *
 * The load-bearing thing to know about this domain, and the reason
 * `warnAbovePerPrincipal` is a warning and not a cap: a device is removed only
 * on EVIDENCE that it is already dead. No count and no amount of quiet ever
 * removes a subscription that still works, because doing so would silently stop
 * notifications on a device nobody unsubscribed and the operator would have to
 * resubscribe to find out.
 */
import type { ConfigSettingDefinition } from './schema-shared.js';
import { intRange } from './schema-shared.js';
import { VAPID_SUBJECT_HINT, isValidVapidSubject } from '../push/vapid-subject.js';

/** Browser-push configuration (`push.*`). */
export interface PushConfig {
  /**
   * Contact a push service uses to report a delivery problem — the VAPID JWT's
   * `sub` claim. Empty means the built-in localhost fallback.
   */
  vapidSubject: string;
  subscriptions: {
    warnAbovePerPrincipal: number;
    failureThreshold: number;
    sweepIntervalMinutes: number;
  };
}

declare module './schema-types.js' {
  interface GoodVibesConfig {
    push: PushConfig;
  }
}

export const pushConfigDefaults: { push: PushConfig } = {
  push: {
    vapidSubject: '',
    subscriptions: {
      warnAbovePerPrincipal: 50,
      failureThreshold: 5,
      sweepIntervalMinutes: 60,
    },
  },
};

export const pushConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'push.vapidSubject',
    type: 'string',
    default: '',
    validate: (v) => typeof v === 'string' && (v.trim().length === 0 || isValidVapidSubject(v.trim())),
    validationHint: `empty, or ${VAPID_SUBJECT_HINT}`,
    description: 'Who a push service contacts when it has a problem delivering your notifications. Every push the daemon sends is signed with this address in it (the VAPID "sub" claim), and it is the only way Apple, Google, or Mozilla can reach you about, say, a malformed payload or a rate limit. Set it to a mailto: address you read, or an https: page with contact details on it. Left empty it falls back to mailto:goodvibes-push@localhost, which is well-formed and accepted but reaches nobody — push still works, you just never hear about a problem.',
  },
  {
    key: 'push.subscriptions.warnAbovePerPrincipal',
    type: 'number',
    default: 50,
    ...intRange(1, 100000),
    description: 'How many registered push devices one operator can hold before housekeeping starts saying so. This is a WARNING line, not a limit: passing it logs the count and writes it into the housekeeping disclosure, and every subscription is kept. A working device is NEVER removed to make room for a new one — registering a new phone always succeeds, even when that puts you over this number, because dropping a quiet-but-live device would stop its notifications with nothing to tell you and no way back but resubscribing. Devices leave only when something proves them dead (the push service reports the endpoint gone, or refuses it repeatedly).',
  },
  {
    key: 'push.subscriptions.failureThreshold',
    type: 'number',
    default: 5,
    ...intRange(1, 100),
    description: 'How many deliveries in a row a push service must refuse before the daemon treats that endpoint as dead and removes it. A 404 or 410 removes it immediately — that is the push service saying the subscription is gone — so this bound is for the murkier case of an endpoint that only ever errors or times out. Any single success resets the count to zero. Raise it if you have a flaky network and would rather keep retrying; lower it to clear out dead endpoints faster.',
  },
  {
    key: 'push.subscriptions.sweepIntervalMinutes',
    type: 'number',
    default: 60,
    ...intRange(1, 1440),
    description: 'How often housekeeping re-reads the stored push subscriptions while the daemon is up, looking for records that are provably dead — unreadable key material, a torn record, or an endpoint past the refusal threshold. A sweep also runs at every start; this interval is what keeps a daemon that stays up for weeks from going that long without one. Each sweep writes what it removed and the evidence, so a removal is never indistinguishable from data loss.',
  },
];
