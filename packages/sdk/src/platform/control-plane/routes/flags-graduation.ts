/**
 * routes/flags-graduation.ts
 *
 * Handler for flags.graduation.report. Reads the feature-flag registry and the
 * owner graduation annotations (both static module data), folding in any real
 * divergence evidence a provider supplies, and returns the graduation report.
 * Registered from register-gateway-verb-groups.ts; needs no runtime dependency,
 * so it is always registered (never a cataloged-but-unhandled 501).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  buildFlagGraduationReport,
  type GraduationEvidenceProvider,
} from '../../runtime/feature-flags/graduation.js';

/**
 * Build the flags.graduation.report handler. An optional evidence provider
 * supplies real shadow/divergence readings; absent, flags with instrumentation
 * honestly report "no evidence collected this run".
 */
export function createFlagsGraduationReportHandler(
  evidence?: GraduationEvidenceProvider | null,
): GatewayMethodHandler {
  return async () => buildFlagGraduationReport({ evidence: evidence ?? null });
}

/** Attach the flags.graduation.report handler to its descriptor. Missing descriptor is a silent no-op. */
export function registerFlagsGraduationGatewayMethods(
  catalog: GatewayMethodCatalog,
  evidence?: GraduationEvidenceProvider | null,
): void {
  const descriptor = catalog.get('flags.graduation.report');
  if (descriptor) {
    catalog.register(descriptor, createFlagsGraduationReportHandler(evidence), { replace: true });
  }
}
