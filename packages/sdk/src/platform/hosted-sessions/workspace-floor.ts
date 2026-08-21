/**
 * workspace-floor.ts, one client-shape composition per WORKSPACE, shared by
 * every hosted session in it.
 *
 * ── The choice this file records ───────────────────────────────────────────
 *
 * The obvious shape is one `createClientRuntimeServices` per hosted session.
 * It is also the wrong one, and the floor's own construction says why. Building
 * a floor costs, per composition:
 *
 *  - a provider stack, including a model-DISCOVERY pass at construction
 *    (provider-stack.ts: `initProviderModelDiscovery`), a network round trip
 *    per configured provider;
 *  - filesystem watchers on the config tree (`watchConfigFiles`) plus a
 *    config→bus bridge;
 *  - a plugin manager and an MCP registry, each of which reaches processes and
 *    files that exist once per machine;
 *  - a `ProjectIndex` and a `FileStateCache` over the workspace tree.
 *
 * Every one of those is a per-machine or per-workspace truth. Duplicating them
 * per session buys no isolation, two sessions in one workspace would discover
 * the same models, watch the same files, and index the same tree, and costs
 * watcher handles and discovery traffic linear in session count. The file cache
 * and project index are the sharpest case: they exist precisely SO tools share
 * cache state, and two sessions editing one workspace with two caches would
 * disagree about the file they both just wrote.
 *
 * What genuinely differs per session is the conversation and the turn: message
 * history, the queued mid-turn messages, the in-flight tool-call aborts, the
 * live-turn controls, context accounting. Those all belong to the Orchestrator
 * and its own tool registry, which is exactly what hosted-session-runtime.ts
 * builds per session, over the floor this file shares.
 *
 * So: floors are keyed by resolved workspace root, reference-counted by the
 * sessions using them, and disposed when the last one goes. A workspace with no
 * live hosted session holds no watchers.
 *
 * ── Why the factory is injected ────────────────────────────────────────────
 *
 * The floor's `requestApproval` seam is where a product's trust posture lives,
 * the daemon puts its workspace trust gate there, and that gate reads a
 * decision file under the workspace being asked about. A floor built for
 * workspace W must therefore be built with W's gate, which only the product can
 * supply. The engine owns the CACHING and the lifetime; the product owns what a
 * floor is made of.
 *
 * The exec POSTURE ({@link HostedWorkspaceFloor.execPosture}) is here for the
 * same reason and no other: it is a statement about how much authority a run on
 * this floor carries, which is the product's to make. The engine's own default
 *, stated when a floor says nothing, is the contained one.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ClientRuntimeServices } from '../runtime/client-services.js';
import type { WrfcController } from '../agents/wrfc-controller.js';
import type { HostedExecPostureDecider } from './exec-posture.js';

/**
 * A composed floor for one workspace, plus whatever the product wired around
 * it that a turn also needs.
 */
export interface HostedWorkspaceFloor {
  /** The client-shape composition every session in this workspace runs on. */
  readonly services: ClientRuntimeServices;
  /**
   * Review-chain listing for the orchestrator's services bag. Omitted ⇒ this
   * floor runs no review/fix chains, and the orchestrator is told so by being
   * handed a listing that reports none, an honest empty answer rather than a
   * missing dependency.
   */
  readonly wrfcController?: Pick<WrfcController, 'listChains'> | undefined;
  /**
   * What a session on this floor may do with exec, decided per session.
   *
   * Omitted ⇒ `conversational`: the exec boundary is REQUIRED, so a command
   * that cannot be contained refuses rather than running on the host, and the
   * owner's terminal is denied. That is the posture every session created over
   * `sessions.hosted.*` runs under.
   *
   * A product returns `workstream` only for a spawn it composed itself, for a
   * work chain the owner authorized. It is a function on the FLOOR and not a
   * field on `CreateHostedSessionInput` deliberately: a caller over the wire
   * must have no spelling that reaches the host.
   */
  readonly execPosture?: HostedExecPostureDecider | undefined;
  /** Release everything this floor started. Called when its last session goes. */
  dispose(): void | Promise<void>;
}

/** How a product builds a floor for one workspace. */
export type HostedWorkspaceFloorFactory = (
  input: { readonly workspaceRoot: string },
) => HostedWorkspaceFloor | Promise<HostedWorkspaceFloor>;

/** A borrowed floor. `release()` is idempotent and drops one reference. */
export interface HostedWorkspaceFloorLease {
  readonly floor: HostedWorkspaceFloor;
  release(): void;
}

interface FloorEntry {
  readonly workspaceRoot: string;
  readonly floor: HostedWorkspaceFloor;
  refs: number;
}

/**
 * The floor cache. One instance per engine.
 *
 * `acquire` is async and single-flighted per workspace: two sessions created in
 * the same workspace at the same moment share one construction rather than
 * racing two provider-discovery passes against each other.
 */
export class HostedWorkspaceFloors {
  private readonly entries = new Map<string, FloorEntry>();
  private readonly pending = new Map<string, Promise<FloorEntry>>();
  private disposed = false;

  constructor(private readonly factory: HostedWorkspaceFloorFactory) {}

  /** How many workspaces currently hold a composed floor. */
  size(): number {
    return this.entries.size;
  }

  /** The workspace roots with a live floor, for status reporting. */
  workspaces(): readonly string[] {
    return [...this.entries.keys()];
  }

  async acquire(workspaceRoot: string): Promise<HostedWorkspaceFloorLease> {
    if (this.disposed) {
      throw new Error('The hosted-session engine has been disposed; no new workspace floor can be composed.');
    }
    const entry = await this.resolveEntry(workspaceRoot);
    entry.refs += 1;
    let released = false;
    return {
      floor: entry.floor,
      release: (): void => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs <= 0) this.retire(entry);
      },
    };
  }

  private async resolveEntry(workspaceRoot: string): Promise<FloorEntry> {
    const existing = this.entries.get(workspaceRoot);
    if (existing) return existing;
    const inFlight = this.pending.get(workspaceRoot);
    if (inFlight) return await inFlight;
    const construction = (async (): Promise<FloorEntry> => {
      const floor = await this.factory({ workspaceRoot });
      const entry: FloorEntry = { workspaceRoot, floor, refs: 0 };
      this.entries.set(workspaceRoot, entry);
      return entry;
    })().finally(() => {
      this.pending.delete(workspaceRoot);
    });
    this.pending.set(workspaceRoot, construction);
    return await construction;
  }

  private retire(entry: FloorEntry): void {
    if (this.entries.get(entry.workspaceRoot) !== entry) return;
    this.entries.delete(entry.workspaceRoot);
    void Promise.resolve()
      .then(() => entry.floor.dispose())
      .catch((error: unknown) => {
        // A floor that fails to release its watchers is a leak worth naming; it
        // must not take down the caller that merely stopped using it.
        logger.warn('[hosted-sessions] disposing a workspace floor failed', {
          workspaceRoot: entry.workspaceRoot,
          error: summarizeError(error),
        });
      });
  }

  /** Dispose every floor. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      try {
        await entry.floor.dispose();
      } catch (error) {
        logger.warn('[hosted-sessions] disposing a workspace floor failed at shutdown', {
          workspaceRoot: entry.workspaceRoot,
          error: summarizeError(error),
        });
      }
    }
  }
}
