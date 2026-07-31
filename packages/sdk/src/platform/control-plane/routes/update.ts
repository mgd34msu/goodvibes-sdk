/**
 * routes/update.ts — the handlers behind `update.status` and `update.check`.
 *
 * Thin on purpose. Everything these report is state the self-update loop
 * already keeps (platform/daemon/facade-lifecycle.ts + auto-updater.ts); this
 * module only makes it askable over the wire, which is the whole defect: a
 * daemon that could not update itself looked exactly like one with nothing to
 * update to, from every surface.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { DaemonUpdateStatus } from '../../daemon/update-status.js';

/** The lifecycle surface these verbs need, declared rather than imported whole. */
export interface DaemonUpdateStatusService {
  updateStatus(): DaemonUpdateStatus;
  checkForUpdatesNow(): Promise<DaemonUpdateStatus>;
}

export function createUpdateStatusHandler(service: DaemonUpdateStatusService): GatewayMethodHandler {
  return () => service.updateStatus();
}

export function createUpdateCheckHandler(service: DaemonUpdateStatusService): GatewayMethodHandler {
  return () => service.checkForUpdatesNow();
}

/** Every verb this module owns. */
export const UPDATE_METHOD_IDS: readonly string[] = ['update.status', 'update.check'];

/**
 * Attach the update handlers to their descriptors. A missing descriptor is a
 * silent no-op, matching every other route group here.
 */
export function registerUpdateGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: DaemonUpdateStatusService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('update.status', createUpdateStatusHandler(service));
  attach('update.check', createUpdateCheckHandler(service));
}
