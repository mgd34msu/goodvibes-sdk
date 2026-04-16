/**
 * ComponentHealthMonitor — enforces per-component resource contracts.
 *
 * Tracks update rate and render cost per component. Components that exceed their
 * contracted budget are throttled (render gated to a minimum interval).
 * Components with sustained violations are degraded (rendered at a fixed low rate).
 *
 * The monitor does NOT render components itself — callers ask canRender() before
 * rendering and report the actual render cost via recordRender().
 *
 * This keeps the monitor policy-focused and the rendering path ignorant of
 * throttling policy details.
 *
 * Surface-agnostic: a TUI panel, a web widget, or any other renderable unit
 * can register with this monitor. The TUI uses componentId values that
 * correspond to panel identifiers; other surfaces use their own naming.
 */

import type { ComponentResourceContract, ComponentHealthState } from './component-contracts.js';
import {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
} from './component-contracts.js';

/** Measurement window for update-rate enforcement (ms). */
const RATE_WINDOW_MS = 1000;

/** Number of recent render durations to keep for p95 calculation. */
const RENDER_SAMPLE_CAPACITY = 20;

/** Ring buffer for render duration samples. */
interface RingBuffer {
  buf: number[];
  head: number;
  size: number;
}

/** Recovery: violations reset to 0 after this many consecutive clean windows. */
const RECOVERY_CLEAN_WINDOWS = 3;

/** Internal per-component tracking state (not externally visible). */
interface ComponentTrack {
  contract: ComponentResourceContract;
  health: ComponentHealthState;
  /** Ring buffer of recent render durations (ms). */
  renderSamples: RingBuffer;
  /** Epoch ms timestamps of render requests in the current window. */
  windowRequests: number[];
  /** Number of consecutive clean measurement windows (no violations). */
  cleanWindows: number;
  /** Start of the current measurement window. */
  windowStart: number;
}

/**
 * ComponentHealthMonitor — tracks component resource usage and enforces budgets.
 *
 * Usage:
 * 1. Register components with register(componentId, category).
 * 2. Before rendering: if (!monitor.canRender(componentId, now)) skip the render.
 * 3. After rendering: monitor.recordRender(componentId, durationMs, now).
 * 4. Read health via getHealth(componentId) or getAllHealth().
 */
export class ComponentHealthMonitor {
  private readonly _tracks: Map<string, ComponentTrack> = new Map();

  /**
   * Register a component with the monitor.
   *
   * If the component is already registered, this is a no-op.
   *
   * @param componentId - Unique component identifier.
   * @param category - Component category (used to select the base contract).
   * @param contractOverrides - Optional per-component contract overrides.
   */
  register(
    componentId: string,
    category: string,
    contractOverrides?: Partial<Omit<ComponentResourceContract, 'componentId'>>,
  ): void {
    if (this._tracks.has(componentId)) return;

    const contract = buildContract(componentId, category, contractOverrides);
    const health = createInitialComponentHealthState(componentId);

    this._tracks.set(componentId, {
      contract,
      health,
      renderSamples: { buf: new Array(RENDER_SAMPLE_CAPACITY), head: 0, size: 0 },
      windowRequests: [],
      cleanWindows: 0,
      windowStart: 0,
    });
  }

  /**
   * Deregister a component, removing all tracking state.
   */
  deregister(componentId: string): void {
    this._tracks.delete(componentId);
  }

  /**
   * Check whether a component is permitted to render at the given time.
   *
   * Records the render request for rate tracking regardless of the outcome.
   * If the component is not registered, renders are always permitted.
   *
   * @param componentId - Component to check.
   * @param now - Current epoch ms (defaults to Date.now()).
   * @returns true if the render is permitted; false if it should be skipped.
   */
  canRender(componentId: string, now: number = Date.now()): boolean {
    const track = this._tracks.get(componentId);
    if (!track) return true; // unregistered components are always permitted

    // Rotate the measurement window if needed
    this._rotateWindow(track, now);

    // Gate on throttle/degrade interval
    if (now < track.health.nextAllowedAt) {
      track.health.totalSuppressed++;
      return false;
    }

    // Record this request in the current window
    track.windowRequests.push(now);

    // Check update rate limit
    let requestsInWindow = 0;
    for (const t of track.windowRequests) {
      if (now - t < RATE_WINDOW_MS) requestsInWindow++;
    }
    // Note: stale entries older than RATE_WINDOW_MS are pruned at window rotation, not here
    const maxPerWindow = track.contract.maxUpdatesPerSecond;

    if (requestsInWindow > maxPerWindow) {
      // Rate exceeded: throttle or degrade
      this._applyViolation(track, now);
      track.health.totalSuppressed++;
      return false;
    }

    track.health.totalPermitted++;
    return true;
  }

  /**
   * Record the actual render duration for a component.
   *
   * Should be called after every permitted render completes. Updates the
   * p95 render cost and may escalate the component's throttle status if the
   * render cost budget is violated.
   *
   * @param componentId - Component that rendered.
   * @param durationMs - Actual render duration in milliseconds.
   * @param now - Epoch ms at render completion (defaults to Date.now()).
   */
  recordRender(componentId: string, durationMs: number, now: number = Date.now()): void {
    const track = this._tracks.get(componentId);
    if (!track) return;

    // Add sample to ring buffer (O(1) modular index — no shift/realloc)
    const rb = track.renderSamples;
    rb.buf[rb.head] = durationMs;
    rb.head = (rb.head + 1) % RENDER_SAMPLE_CAPACITY;
    if (rb.size < RENDER_SAMPLE_CAPACITY) rb.size++;

    // Update p95
    const samples = rb.buf.slice(0, rb.size);
    samples.sort((a, b) => a - b); // sort in-place, no second copy
    const p95Val = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    track.health.renderP95Ms = p95Val;
    track.health.lastRenderAt = now;
    track.health.rendersInWindow++;

    // Check render cost budget
    if (track.health.renderP95Ms > track.contract.maxRenderMs) {
      this._applyViolation(track, now);
    } else {
      // Render cost within budget — count as a clean observation
      this._recordClean(track);
    }
  }

  /**
   * Return the current health state for a component, or undefined if not registered.
   */
  getHealth(componentId: string): ComponentHealthState | undefined {
    return this._tracks.get(componentId)?.health;
  }

  /**
   * Return health states for all registered components.
   */
  getAllHealth(): ComponentHealthState[] {
    return Array.from(this._tracks.values()).map((t) => ({ ...t.health }));
  }

  /**
   * Return the resource contract for a registered component, or undefined.
   */
  getContract(componentId: string): ComponentResourceContract | undefined {
    return this._tracks.get(componentId)?.contract;
  }

  /**
   * Forcibly reset a component's health state to normal.
   * Useful for tests or manual operator intervention.
   */
  resetHealth(componentId: string): void {
    const track = this._tracks.get(componentId);
    if (!track) return;
    track.health = createInitialComponentHealthState(componentId);
    track.renderSamples = { buf: new Array(RENDER_SAMPLE_CAPACITY), head: 0, size: 0 };
    track.windowRequests = [];
    track.cleanWindows = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _rotateWindow(track: ComponentTrack, now: number): void {
    if (track.windowStart === 0) {
      track.windowStart = now;
      return;
    }
    if (now - track.windowStart >= RATE_WINDOW_MS) {
      // Check for recovery
      let requestsLastWindow = 0;
      for (const t of track.windowRequests) {
        if (t >= track.windowStart && t < track.windowStart + RATE_WINDOW_MS) requestsLastWindow++;
      }
      const withinBudget = requestsLastWindow <= track.contract.maxUpdatesPerSecond;
      if (withinBudget) {
        track.cleanWindows++;
        if (track.cleanWindows >= RECOVERY_CLEAN_WINDOWS) {
          this._recover(track);
        }
      } else {
        track.cleanWindows = 0;
      }
      // Discard old requests
      track.windowRequests = track.windowRequests.filter((t) => now - t < RATE_WINDOW_MS);
      track.windowStart = now;
      track.health.rendersInWindow = 0;
    }
  }

  private _applyViolation(track: ComponentTrack, now: number): void {
    track.health.consecutiveViolations++;
    track.cleanWindows = 0;

    if (track.health.consecutiveViolations >= track.contract.degradeAfterViolations) {
      // Escalate to degraded
      track.health.throttleStatus = 'degraded';
      track.health.healthStatus = 'overloaded';
      track.health.nextAllowedAt = now + track.contract.degradedIntervalMs;
    } else {
      // Apply standard throttle
      track.health.throttleStatus = 'throttled';
      track.health.healthStatus = 'warning';
      track.health.nextAllowedAt = now + track.contract.throttleIntervalMs;
    }
  }

  /**
   * Dual-path recovery: `_recordClean` handles render-cost-based recovery
   * (triggered from `recordRender` after a cheap render), while `_rotateWindow`
   * handles rate-based recovery (triggered at window boundaries). Both paths
   * call `_recover` once the clean-window threshold is met, so either signal
   * alone is sufficient to restore a component to normal status.
   */
  private _recordClean(track: ComponentTrack): void {
    // Only advance recovery if we're already throttled/degraded
    if (track.health.throttleStatus === 'normal') return;
    track.cleanWindows++;
    if (track.cleanWindows >= RECOVERY_CLEAN_WINDOWS) {
      this._recover(track);
    }
  }

  private _recover(track: ComponentTrack): void {
    track.health.throttleStatus = 'normal';
    track.health.healthStatus = 'healthy';
    track.health.consecutiveViolations = 0;
    track.health.nextAllowedAt = 0;
    track.cleanWindows = 0;
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible alias
// ---------------------------------------------------------------------------

/** @deprecated Use ComponentHealthMonitor */
export { ComponentHealthMonitor as PanelHealthMonitor };
