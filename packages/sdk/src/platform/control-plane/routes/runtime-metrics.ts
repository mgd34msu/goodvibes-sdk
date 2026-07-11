/**
 * routes/runtime-metrics.ts
 *
 * Handler for runtime.metrics.get. Reads the process-wide RuntimeMeter
 * snapshot (platformMeter's counters/gauges/histograms) and the per-model
 * tool-format telemetry singleton — both already-live process state, no
 * runtime dependency needed. Registered from register-gateway-verb-groups.ts;
 * always registered, exactly like flags.graduation.report (never a cataloged-
 * but-unhandled 501).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { snapshotMetrics } from '../../runtime/metrics.js';

/** Build the runtime.metrics.get handler. */
export function createRuntimeMetricsHandler(): GatewayMethodHandler {
  return async () => snapshotMetrics();
}

/** Attach the runtime.metrics.get handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerRuntimeMetricsGatewayMethods(catalog: GatewayMethodCatalog): void {
  const descriptor = catalog.get('runtime.metrics.get');
  if (descriptor) {
    catalog.register(descriptor, createRuntimeMetricsHandler(), { replace: true });
  }
}
