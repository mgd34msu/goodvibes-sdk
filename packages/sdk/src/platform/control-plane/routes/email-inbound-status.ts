/**
 * routes/email-inbound-status.ts — the inbound watcher's disclosure verb.
 *
 * §9's rule is that anything persisted across restarts reaps, bounds,
 * validates by content, sweeps periodically, and DISCLOSES. Three things
 * outlive a restart here — the cursors, the inbound records and the
 * expectations — and until this verb existed the fifth rule was the one with
 * no mechanism behind it. Everything below is that mechanism.
 *
 * It is a read, and only a read: the handler holds a supervisor slice
 * consisting of exactly one method that returns a snapshot. There is nothing
 * here that can start, stop, or reconfigure the watcher, which matters because
 * a disclosure verb is the one an operator is most likely to grant broadly.
 *
 * No `http` binding, for the same reason the expectation verbs have none: the
 * callers are inside the daemon and no route serves an
 * `/api/email/inbound/status` path. The descriptor says `transport: ['ws']`
 * to match, and the two halves are kept honest by the route-reconcile and
 * transport-honesty gates rather than by this comment.
 *
 * Nulls are omitted rather than serialized. `capability` before the first
 * probe and `lastSweep` before the first sweep are ABSENT facts, and a wire
 * shape that says `"capability": null` invites a consumer to render "state:
 * null" as though it were a state.
 */

import type { GatewayMethodCatalog, GatewayMethodHandler } from '../method-catalog.js';
import type { InboundMailSupervisor } from '../../email/inbound/supervisor.js';

/**
 * What a backend must be able to do to serve this verb: describe itself.
 *
 * Structurally satisfied by `InboundMailSupervisor`, so the daemon wiring
 * passes the supervisor itself rather than an adapter — and a `Pick` rather
 * than a restated method signature, so it cannot describe a method the
 * supervisor does not have.
 */
export type InboundMailStatusService = Pick<InboundMailSupervisor, 'describeStatus'>;

export function createEmailInboundStatusHandler(
  service: InboundMailStatusService,
): GatewayMethodHandler {
  return async () => {
    const snapshot = await service.describeStatus();
    const { capability, retention, ...rest } = snapshot;
    const { lastSweep, ...retained } = retention;
    return {
      ...rest,
      ...(capability === null ? {} : { capability }),
      retention: {
        ...retained,
        ...(lastSweep === null ? {} : { lastSweep }),
      },
      health: {
        kind: snapshot.health.kind,
        id: snapshot.health.id,
        label: snapshot.health.label,
        state: snapshot.health.state,
        enabled: snapshot.health.enabled,
        account: snapshot.health.account,
        mailbox: snapshot.health.mailbox,
        mode: snapshot.health.mode,
        reason: snapshot.health.reason,
      },
      source: {
        ...(snapshot.source.kind === null ? {} : { kind: snapshot.source.kind }),
        basis: snapshot.source.basis,
        detail: snapshot.source.detail,
        latency: snapshot.source.latency,
      },
    };
  };
}

/** Attach the inbound-status handler to its descriptor (missing = no-op). */
export function registerEmailInboundStatusGatewayMethod(
  catalog: GatewayMethodCatalog,
  service: InboundMailStatusService,
): void {
  const descriptor = catalog.get('email.inbound.status');
  if (descriptor) {
    catalog.register(descriptor, createEmailInboundStatusHandler(service), { replace: true });
  }
}
