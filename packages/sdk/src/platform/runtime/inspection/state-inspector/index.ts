/**
 * State inspector subsystem exports.
 *
 * Import from here to access types, the provider class, and the factory.
 *
 * Usage:
 * ```ts
 * import { createStateInspector } from '../runtime/inspection/state-inspector/index.js';
 *
 * const inspector = createStateInspector({
 *   domains: [sessionAdapter, conversationAdapter],
 *   maxTransitions: 500,
 * });
 * ```
 *
 * Devtools / State Inspector.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  DomainSnapshot,
  StateSnapshot,
  TransitionEntry,
  SubscriptionInfo,
  StateInspectorConfig,
  TimelineEvent,
  TimeTravelCursor,
  SelectorHotspot,
  HotspotReport,
  HotspotSamplerConfig,
} from './types.js';
export {
  DEFAULT_MAX_TRANSITIONS,
  DEFAULT_TIMELINE_BUFFER_SIZE,
  DEFAULT_HOTSPOT_WINDOW_MS,
  DEFAULT_HOTSPOT_MAX_SAMPLES_PER_KEY,
} from './types.js';

// ── Transition log ────────────────────────────────────────────────────────────
export { BoundedTransitionLog } from './transition-log.js';

// ── Timeline buffer ───────────────────────────────────────────────────────────
export { TimelineBuffer } from './timeline.js';

// ── Hotspot sampler ───────────────────────────────────────────────────────────
export { SelectorHotspotSampler } from './hotspot-sampler.js';

// ── Provider ─────────────────────────────────────────────────────────────────
export { StateInspectorProvider } from './inspector.js';

// ── Domain adapter re-export ──────────────────────────────────────────────────
export type { InspectableDomain } from '../../diagnostics/panels/state-inspector.js';

// ── Factory ───────────────────────────────────────────────────────────────────
import { StateInspectorProvider } from './inspector.js';
import type { InspectableDomain } from '../../diagnostics/panels/state-inspector.js';
import type { StateInspectorConfig } from './types.js';

/**
 * Factory parameters for createStateInspector.
 */
export interface CreateStateInspectorOptions extends StateInspectorConfig {
  /** Domain adapters to register at construction time. */
  readonly domains?: InspectableDomain[] | undefined;
}

/**
 * Create a fully configured StateInspectorProvider.
 *
 * @param options - Configuration including domains and capacity limits.
 * @returns A ready-to-use StateInspectorProvider instance.
 */
export function createStateInspector(
  options: CreateStateInspectorOptions = {},
): StateInspectorProvider {
  const { domains = [], ...config } = options;
  return new StateInspectorProvider(domains, config);
}
