/**
 * surface-registry.ts, which inbound surfaces THIS node can actually serve.
 *
 * The registry is the answer to the question the ruling turns on: a node must
 * never win an election for something it cannot serve. Winning a surface with
 * no credential for it, or with that surface switched off locally, starves the
 * node that could have served it, the loser stands down, the winner reads
 * nothing, and the topic goes unread by anybody on the network.
 *
 * So membership is not a configuration list. A surface is in here only because
 * a working consumer for it was registered: the composition root resolved the
 * credential, found the surface enabled, built something that can start, and
 * handed it over. A node with no inbound surfaces registers nothing here,
 * joins no elections, and claims nothing.
 *
 * (Not to be confused with `channels/surface-registry.ts`, which is about
 * message routing between channel surfaces. This one is only about who on the
 * LAN is allowed to contest which inbound consumer.)
 */
import { surfaceIdFor, surfaceLabel, type ClusterSurfaceKey } from './surface-id.js';
import type { ClusterConsumerGate, ClusterConsumerStartContext, ClusterLogger } from './types.js';

/** One servable surface and every consumer registered against it. */
export interface RegisteredClusterSurface {
  readonly surfaceId: string;
  readonly key: ClusterSurfaceKey;
  /** Digest-derived label, safe for logs. */
  readonly label: string;
  readonly gates: readonly ClusterConsumerGate[];
}

interface MutableSurface {
  readonly surfaceId: string;
  readonly key: ClusterSurfaceKey;
  readonly label: string;
  readonly gates: ClusterConsumerGate[];
}

export class ClusterSurfaceRegistry {
  private readonly surfaces = new Map<string, MutableSurface>();
  /**
   * Surfaces whose last consumer has been unregistered but whose election has
   * not finished standing down yet.
   *
   * They must stay reachable for exactly one more `stopSurface`. Leaving with
   * a RESIGN means asserting to the whole network that this node has stopped
   * reading, and if the gate were already unreachable there would be nothing
   * to stop, so the assertion would be false and the successor would start
   * against a consumer still running. They are dropped by `forget` once the
   * election has actually stopped.
   */
  private readonly retiring = new Map<string, MutableSurface>();
  private readonly listeners = new Set<(surfaceId: string) => void>();

  constructor(private readonly logger: ClusterLogger) {}

  /**
   * Add a consumer. Returns an unregister function.
   *
   * Several gates may share one surface, the ntfy stream and a diagnostic
   * tap on the same topic, say. They start in registration order and stop in
   * the reverse, so a consumer another depends on is up first and down last.
   */
  register(gate: ClusterConsumerGate): () => void {
    const surfaceId = surfaceIdFor(gate.surface);
    // A surface re-registered before its stand-down completed is servable
    // again; it must not be dropped underneath the new consumer.
    this.retiring.delete(surfaceId);
    let surface = this.surfaces.get(surfaceId);
    if (!surface) {
      surface = {
        surfaceId,
        key: gate.surface,
        label: surfaceLabel(gate.surface),
        gates: [],
      };
      this.surfaces.set(surfaceId, surface);
    }
    surface.gates.push(gate);
    this.notify(surfaceId);
    return () => {
      const current = this.surfaces.get(surfaceId);
      if (!current) return;
      const index = current.gates.indexOf(gate);
      if (index < 0) return;
      if (current.gates.length > 1) {
        current.gates.splice(index, 1);
        this.notify(surfaceId);
        return;
      }
      // The LAST consumer for this surface. It leaves the servable set and,
      // through the listener, leaves the election, because holding a seat
      // with nothing behind it is the starvation case this file exists to
      // prevent. It moves to `retiring` with its gate STILL ATTACHED: the
      // ordered stand-down that follows has to actually stop the consumer
      // before it broadcasts a RESIGN saying it did.
      this.surfaces.delete(surfaceId);
      this.retiring.set(surfaceId, current);
      this.notify(surfaceId);
    };
  }

  /** Called whenever the servable set changes, with the surface that moved. */
  onChange(listener: (surfaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True when this node has a working consumer for the surface right now. */
  canServe(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  get(surfaceId: string): RegisteredClusterSurface | undefined {
    return this.surfaces.get(surfaceId);
  }

  /** Every servable surface, in a stable order. */
  list(): RegisteredClusterSurface[] {
    return [...this.surfaces.values()].sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
  }

  get size(): number {
    return this.surfaces.size;
  }

  /** Start every consumer for one surface, in registration order. */
  async startSurface(surfaceId: string, context: ClusterConsumerStartContext): Promise<void> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return;
    for (const gate of [...surface.gates]) {
      try {
        await gate.start(context);
      } catch (error) {
        // One consumer failing must not strand the others, and must not leave
        // the node believing it is not responsible when it is.
        this.logger.error('cluster: an inbound consumer failed to start on taking its surface', {
          surface: surface.label,
          consumer: gate.id,
          reason: context.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Stop every consumer for one surface, newest first, and do not resolve
   * until they have all settled. The RESIGN that follows this is a claim that
   * consumption has genuinely ceased, so it must not be sent a moment early.
   */
  async stopSurface(surfaceId: string, reason: string): Promise<void> {
    const surface = this.surfaces.get(surfaceId) ?? this.retiring.get(surfaceId);
    if (!surface) return;
    for (const gate of [...surface.gates].reverse()) {
      try {
        await gate.stop(reason);
      } catch (error) {
        this.logger.error('cluster: an inbound consumer did not stop cleanly', {
          surface: surface.label,
          consumer: gate.id,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Drop a retired surface once its election has finished standing down. */
  forget(surfaceId: string): void {
    this.retiring.delete(surfaceId);
  }

  private notify(surfaceId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(surfaceId);
      } catch (error) {
        this.logger.error('cluster: a surface registry listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
