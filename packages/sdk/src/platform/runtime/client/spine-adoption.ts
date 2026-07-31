/**
 * spine-adoption.ts — wiring a surface's session and memory spines to the
 * daemon it adopted.
 *
 * ── What the branch used to be, and what it is now ─────────────────────────
 *
 * There were two supported topologies and this was the one selection point
 * between them: `embedded` meant the surface's own `SharedSessionBroker` WAS
 * the daemon's broker, so there was nothing to mirror to and the spine stayed
 * dormant; `external` meant a separately-running daemon the surface adopted,
 * and only then did the wire mirror come up.
 *
 * `embedded` is gone. A surface never hosts a daemon, so there is exactly one
 * live topology — adopted — and every other mode (`disabled`, `blocked`,
 * `incompatible`, `unavailable`) means the same honest thing: no daemon, local
 * only, nothing mirrored. The branch that remains is "adopted or not", not "who
 * is hosting".
 *
 * ── What crosses the wire ──────────────────────────────────────────────────
 *
 * Session IDENTITY, not session execution. The conversation itself still runs
 * in the surface; what the daemon holds is the register — which sessions exist,
 * which surface is live on each, and the inputs queued against them. Concretely,
 * on adoption this wires:
 *
 *   - `sessions.register` / `sessions.close` — the identity mirror, deliberately
 *     fire-and-forget so a slow daemon never shows up in a keystroke.
 *   - `sessions.inputs.list` / `sessions.inputs.deliver` — the inbound steer
 *     path, so a message another surface queued for THIS session lands in the
 *     turn machinery here and is acknowledged on the wire.
 *   - `sessions.list` — the cross-surface union the views read, interval-
 *     refreshed and served synchronously.
 *   - the memory spine's wire transport, on the same adoption signal.
 *
 * Plus a one-time, marker-guarded fold of the project's own pre-spine session
 * store into the adopted daemon, so sessions that predate the split are visible
 * rather than stranded.
 *
 * ── The one product choice: WHEN adoption happens ─────────────────────────
 *
 * Two shapes are in production and both are correct for their product:
 *
 * - `adopt-on-status`: a surface with a boot discovery probe drives this from
 *   the probe's verdict, and only a verdict of `external` wires anything. That
 *   surface can render "no daemon" honestly, so gating on the mode is right.
 * - `live-immediately`: a surface with no such probe (its connection resolution
 *   IS the signal) wires as soon as it is handed a base URL and lets the spine
 *   client's own reachability handling deal with a daemon that is not there.
 *
 * The reconcile policy below — idempotent per base URL, tear down on a change,
 * fold once — is identical either way, which is why the timing is an OPTION and
 * not a second implementation.
 */
import { foldLegacySpineStore, type SessionSpineClient, type SpineTransport } from '../session-spine/index.js';
import type { MemoryTransport } from '../memory-spine/index.js';
import { logger } from '../../utils/index.js';
import type { SessionInputsWireClient } from './session-dispatch.js';

/** When the wire comes up. See the module header. */
export type SpineActivationTiming = 'adopt-on-status' | 'live-immediately';

/** The inbound steer poller, as this module drives it. */
export interface InboundInputsActivation {
  activate(client: SessionInputsWireClient): void;
  deactivate(reason: string): void;
}

/** The cross-surface union read model, as this module drives it. */
export interface SessionUnionActivation {
  activate(source: { list(limit: number): Promise<readonly unknown[]> }): void;
  deactivate(reason: string): void;
}

/** The memory spine's two members this policy drives. */
export interface MemorySpineActivation {
  activate(transport: MemoryTransport): void;
  deactivate(reason: string): void;
}

/**
 * Everything the adopted daemon is reached through, built by the product from
 * its own HTTP client.
 *
 * The SDK owns WHEN these come up and go down; the product owns what they are,
 * because building them is the same connection-resolution concern the verb
 * caller already keeps product-side.
 */
export interface SpineWireBundle {
  /** `sessions.register` / `sessions.close`. */
  readonly sessionTransport: SpineTransport;
  /** `sessions.inputs.list` / `sessions.inputs.deliver`. */
  readonly inboundInputs: SessionInputsWireClient;
  /** `sessions.list`, for the cross-surface union. */
  readonly sessionList: { list(limit: number): Promise<readonly unknown[]> };
  /** The memory wire. Absent ⇒ this product mirrors memory nowhere. */
  readonly memoryTransport?: MemoryTransport | undefined;
}

export interface SpineAdoptionOptions {
  readonly sessionSpine: Pick<SessionSpineClient, 'activate' | 'deactivate' | 'foldLegacyRecords'>;
  /** Absent ⇒ this product's memory does not follow daemon adoption. */
  readonly memorySpine?: MemorySpineActivation | undefined;
  readonly sessionInboundInputs: InboundInputsActivation;
  readonly sessionUnionCache: SessionUnionActivation;
  /** Build the wire for one adopted daemon. Called once per distinct base URL. */
  readonly connect: (baseUrl: string, authToken: string) => SpineWireBundle;
  /** Where this project's pre-spine session store lives, for the one-time fold. */
  readonly legacyStorePath: string;
  readonly workingDirectory: string;
  /** See the module header. Defaults to `adopt-on-status`. */
  readonly activation?: SpineActivationTiming | undefined;
  /**
   * Extra seams driven on the same adoption signal: inbound continuation
   * dispatch, and offering this surface's conversation for rewind. Both are
   * meaningless without an adopted daemon and both must come up with one, so
   * they ride the signal that already knows.
   */
  readonly onAdopted?: ((client: SessionInputsWireClient) => void) | undefined;
  readonly onDetached?: ((reason: string) => void) | undefined;
  readonly log?: Pick<typeof logger, 'info' | 'debug'> | undefined;
}

/** The adoption signal, as the caller already has it. */
export interface SpineAdoptionSignal {
  /** The probe's verdict. `adopt-on-status` wires only on `external`. */
  readonly mode: string;
  readonly baseUrl: string;
}

/**
 * Build the "the adopted daemon changed" handler.
 *
 * Idempotent per base URL: re-running it against the same adopted daemon is a
 * no-op, so a re-probe after an autostart does not tear a live mirror down and
 * put it back up.
 */
export function createSpineAdoptionSync(
  options: SpineAdoptionOptions,
): (signal: SpineAdoptionSignal, sharedDaemonToken: string) => void {
  const log = options.log ?? logger;
  const timing = options.activation ?? 'adopt-on-status';
  let activeForBaseUrl: string | null = null;
  let memoryActiveForBaseUrl: string | null = null;

  const detach = (reason: string): void => {
    if (memoryActiveForBaseUrl !== null) {
      options.memorySpine?.deactivate(reason);
      memoryActiveForBaseUrl = null;
    }
    if (activeForBaseUrl !== null) {
      options.sessionSpine.deactivate(reason);
      options.sessionInboundInputs.deactivate(reason);
      options.onDetached?.(reason);
      activeForBaseUrl = null;
    }
    options.sessionUnionCache.deactivate(reason);
  };

  return (signal, sharedDaemonToken) => {
    // `live-immediately` treats any base URL it is handed as the daemon to
    // mirror to; `adopt-on-status` waits for the probe to say `external`.
    const adopted = signal.baseUrl !== ''
      && (timing === 'live-immediately' || signal.mode === 'external');
    if (!adopted) {
      if (activeForBaseUrl !== null || memoryActiveForBaseUrl !== null) {
        detach(`daemon mode changed to '${signal.mode}'`);
      } else {
        options.sessionUnionCache.deactivate(`daemon mode '${signal.mode}'`);
      }
      log.info(`[bootstrap] session spine: daemon mode '${signal.mode}' — local-only (no spine mirror)`);
      return;
    }

    const baseUrl = signal.baseUrl;
    if (activeForBaseUrl === baseUrl) return; // already wired to this exact adopted daemon
    if (activeForBaseUrl !== null) detach(`the adopted daemon moved to ${baseUrl}`);

    const wire = options.connect(baseUrl, sharedDaemonToken);
    if (options.memorySpine && wire.memoryTransport) {
      options.memorySpine.activate(wire.memoryTransport);
      memoryActiveForBaseUrl = baseUrl;
      log.info(`[bootstrap] memory spine: adopted daemon at ${baseUrl} — routing memory ops over the wire`);
    }
    options.sessionSpine.activate(wire.sessionTransport);
    options.sessionInboundInputs.activate(wire.inboundInputs);
    options.onAdopted?.(wire.inboundInputs);
    options.sessionUnionCache.activate(wire.sessionList);
    activeForBaseUrl = baseUrl;
    log.info(`[bootstrap] session spine: adopted daemon at ${baseUrl} — mirroring session identity`);

    // One-time, marker-guarded import of this project's own pre-spine sessions.
    const fold = foldLegacySpineStore(options.sessionSpine, {
      storePath: options.legacyStorePath,
      markerPath: `${options.legacyStorePath}.spine-migrated`,
      project: options.workingDirectory,
    });
    if (fold.folded > 0) {
      log.info(`[bootstrap] session spine: folded ${fold.folded} legacy local session(s) into the adopted daemon`);
    }
  };
}
