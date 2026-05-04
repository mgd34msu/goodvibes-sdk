/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Component resource contracts — per-component CPU/IO/update budget definitions.
 *
 * Each component declares a resource contract describing its acceptable update
 * rate and render cost. The ComponentHealthMonitor enforces these contracts at
 * runtime, throttling or degrading components that exceed their budgets.
 *
 * "Component" is intentionally surface-agnostic: a TUI panel, a web widget,
 * or any other renderable unit can register with the monitor using these types.
 */

/** Throttle status for a component. */
export type ComponentThrottleStatus = 'normal' | 'throttled' | 'degraded';

/** Health of a single component based on contract compliance. */
export type ComponentHealthStatus = 'healthy' | 'warning' | 'overloaded';

/**
 * Resource contract for a single component.
 *
 * Defines the maximum acceptable update rate and render cost budget.
 * Violations trigger throttling; sustained violations trigger degradation.
 */
export interface ComponentResourceContract {
  /** Component id this contract applies to. */
  componentId: string;

  /**
   * Maximum updates per second the component is allowed to request.
   * Components that exceed this rate are throttled.
   */
  maxUpdatesPerSecond: number;

  /**
   * Maximum acceptable render duration in milliseconds (p95).
   * Components that consistently exceed this are degraded.
   */
  maxRenderMs: number;

  /**
   * Minimum interval in milliseconds between renders when throttled.
   * The monitor enforces this floor when the component exceeds its update rate.
   */
  throttleIntervalMs: number;

  /**
   * Number of consecutive budget violations before moving to 'degraded' status.
   * Degraded components render at a fixed reduced rate regardless of update requests.
   */
  degradeAfterViolations: number;

  /**
   * Fixed render interval in milliseconds when the component is degraded.
   * Replaces throttleIntervalMs for severely overloaded components.
   */
  degradedIntervalMs: number;
}

/**
 * Live health state for a single component, maintained by the ComponentHealthMonitor.
 */
export interface ComponentHealthState {
  /** Component id. */
  componentId: string;

  /** Current throttle status. */
  throttleStatus: ComponentThrottleStatus;

  /** Current health status. */
  healthStatus: ComponentHealthStatus;

  /** Observed render count over the last measurement window. */
  rendersInWindow: number;

  /** p95 render duration in ms over the last measurement window. */
  renderP95Ms: number;

  /** Number of consecutive contract violations (update rate or render cost). */
  consecutiveViolations: number;

  /** Epoch ms when the component was last allowed to render. */
  lastRenderAt: number;

  /** Epoch ms of next allowed render (0 = no restriction). */
  nextAllowedAt: number;

  /** Total renders suppressed due to throttle or degradation since monitor start. */
  totalSuppressed: number;

  /** Total renders permitted since monitor start. */
  totalPermitted: number;
}

export type PanelThrottleStatus = ComponentThrottleStatus;
export type PanelHealthStatus = ComponentHealthStatus;

export type PanelResourceContract = Omit<ComponentResourceContract, 'componentId'> & {
  panelId: string;
};

export type PanelHealthState = Omit<ComponentHealthState, 'componentId'> & {
  panelId: string;
};

/**
 * Default resource contracts by component category.
 *
 * Components without an explicit contract inherit from their category default.
 * Active/interactive components get more generous budgets; monitoring components
 * are throttled aggressively to prevent render storms.
 */
export const CATEGORY_CONTRACTS: Record<string, Omit<ComponentResourceContract, 'componentId'>> = {
  development: {
    maxUpdatesPerSecond: 10,
    maxRenderMs: 20,
    throttleIntervalMs: 100,
    degradeAfterViolations: 5,
    degradedIntervalMs: 500,
  },
  agent: {
    maxUpdatesPerSecond: 5,
    maxRenderMs: 30,
    throttleIntervalMs: 200,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
  monitoring: {
    maxUpdatesPerSecond: 2,
    maxRenderMs: 50,
    throttleIntervalMs: 500,
    degradeAfterViolations: 3,
    degradedIntervalMs: 2000,
  },
  session: {
    maxUpdatesPerSecond: 4,
    maxRenderMs: 25,
    throttleIntervalMs: 250,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
  ai: {
    maxUpdatesPerSecond: 8,
    maxRenderMs: 20,
    throttleIntervalMs: 125,
    degradeAfterViolations: 5,
    degradedIntervalMs: 500,
  },
  /** Fallback for unrecognised categories. */
  default: {
    maxUpdatesPerSecond: 5,
    maxRenderMs: 30,
    throttleIntervalMs: 200,
    degradeAfterViolations: 5,
    degradedIntervalMs: 1000,
  },
};

/**
 * Build a ComponentResourceContract for a component, merging category defaults
 * with any per-component overrides.
 *
 * @param componentId - The component's unique id.
 * @param category - The component's category (used to select the base contract).
 * @param overrides - Optional per-component overrides applied on top of the category contract.
 */
export function buildContract(
  componentId: string,
  category: string,
  overrides?: Partial<Omit<ComponentResourceContract, 'componentId'>>,
): ComponentResourceContract {
  const base = CATEGORY_CONTRACTS[category]! ?? CATEGORY_CONTRACTS['default']!;
  return {
    componentId,
    ...base,
    ...overrides,
  };
}

/**
 * Create an initial (clean) ComponentHealthState for a component.
 */
export function createInitialComponentHealthState(componentId: string): ComponentHealthState {
  return {
    componentId,
    throttleStatus: 'normal',
    healthStatus: 'healthy',
    rendersInWindow: 0,
    renderP95Ms: 0,
    consecutiveViolations: 0,
    lastRenderAt: 0,
    nextAllowedAt: 0,
    totalSuppressed: 0,
    totalPermitted: 0,
  };
}

export function createInitialPanelHealthState(panelId: string): PanelHealthState {
  const state = createInitialComponentHealthState(panelId);
  const { componentId: _componentId, ...rest } = state;
  return {
    panelId,
    ...rest,
  };
}
