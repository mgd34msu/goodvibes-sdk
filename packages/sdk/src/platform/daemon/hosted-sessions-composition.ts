/**
 * hosted-sessions-composition.ts — wiring the hosted-session engine into a
 * daemon.
 *
 * The engine (platform/hosted-sessions) is deliberately ignorant of the daemon:
 * it takes a way to build a workspace floor, a place to publish lifecycle
 * notices, a store, and the settings it reads. This file supplies those from a
 * composed daemon, and nothing else.
 *
 * ── Why the floor factory is required rather than defaulted ────────────────
 *
 * A hosted run writes files, runs commands and delegates inside a workspace the
 * daemon was pointed at over the wire. WHICH permission seam sits in front of
 * that is the product's decision — the daemon puts its workspace trust gate
 * there, so an undecided workspace raises the trust question as an approval
 * record any attached surface can answer, and a restricted one refuses
 * non-read categories without asking.
 *
 * Defaulting that seam would mean picking a trust posture on the product's
 * behalf, and the only posture available to a default is "no gate at all". So
 * hosted sessions are OFF until a product states how a floor is built. A daemon
 * that says nothing hosts nothing, and the verbs refuse honestly rather than
 * running ungated work.
 */

import { existsSync, statSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import type { SessionLiveTurnControlsHolder } from '../control-plane/routes/session-runtime.js';
import { registerHostedSessionGatewayMethods } from '../control-plane/routes/hosted-sessions.js';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import {
  HostedSessionManager,
  HostedSessionStore,
  type HostedSessionEventPublisher,
  type HostedSessionLoadReport,
  type HostedSessionSpine,
  type HostedWorkspaceFloorFactory,
} from '../hosted-sessions/index.js';
import type { RuntimeServices } from '../runtime/services.js';

/** What a product states to turn hosted sessions on. */
export interface DaemonHostedSessionsOptions {
  /**
   * How a workspace floor is built. Required — see the module header for why
   * there is no default.
   */
  readonly floorFactory: HostedWorkspaceFloorFactory;
  /**
   * The base system prompt for a hosted turn. The orchestrator appends the
   * runtime-awareness block itself, so this is the product's operator policy.
   * Omitted ⇒ a plain statement of what the session is.
   */
  readonly systemPrompt?: ((input: { readonly sessionId: string; readonly workspaceRoot: string }) => string) | undefined;
  /** Where session state is written. Omitted ⇒ `<injected home>/.goodvibes/hosted-sessions`. */
  readonly stateDirectory?: string | undefined;
  /** Whether a workspace root is acceptable. Omitted ⇒ it must be an existing directory. */
  readonly isWorkspaceUsable?: ((workspaceRoot: string) => boolean) | undefined;
}

/** What this composition needs from an already-built daemon. */
export interface HostedSessionCompositionInput {
  readonly options: DaemonHostedSessionsOptions;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly shellPaths: ShellPathService;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly liveTurns: SessionLiveTurnControlsHolder;
  readonly eventPublisher: HostedSessionEventPublisher;
  readonly spine?: HostedSessionSpine | undefined;
}

/** The default prompt: what this session is, stated plainly. */
function defaultHostedSystemPrompt(input: { readonly workspaceRoot: string }): string {
  return [
    'You are running as a GoodVibes session hosted by the daemon rather than by a terminal.',
    `Your working directory is ${input.workspaceRoot}.`,
    'A person may be attached and watching, or may have detached and be reading this later — write as if both are true.',
  ].join(' ');
}

/** An existing directory, checked without throwing on a permission error. */
function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the hosted-session engine, attach its verbs and its lifecycle channel.
 * The caller still has to call `init()` (at start) and `dispose()` (at stop).
 */
export function composeHostedSessions(input: HostedSessionCompositionInput): HostedSessionManager {
  const config = input.configManager;
  const store = new HostedSessionStore(
    input.options.stateDirectory ?? input.shellPaths.resolveUserPath('hosted-sessions'),
    {
      get maxSessions(): number { return config.get('hostedSessions.maxSessions'); },
      get maxMessagesPerSession(): number { return config.get('hostedSessions.maxMessagesPerSession'); },
      get terminatedRetentionMs(): number { return config.get('hostedSessions.terminatedRetentionMs'); },
    },
  );
  const manager = new HostedSessionManager({
    floorFactory: input.options.floorFactory,
    store,
    // Read live on every use: a policy change applies to the next detach, not
    // to whatever the value was when the daemon booted.
    settings: {
      detachPolicy: () => config.get('hostedSessions.detachPolicy'),
      maxSessions: () => config.get('hostedSessions.maxSessions'),
    },
    runtimeBus: input.runtimeBus,
    systemPrompt: input.options.systemPrompt ?? defaultHostedSystemPrompt,
    liveTurns: input.liveTurns,
    ...(input.spine === undefined ? {} : { spine: input.spine }),
    isWorkspaceUsable: input.options.isWorkspaceUsable ?? isExistingDirectory,
  });
  manager.setEventPublisher(input.eventPublisher);
  registerHostedSessionGatewayMethods(input.gatewayMethods, manager);
  return manager;
}

/**
 * The facade's one-line entry point. Everything this composition needs is
 * already on the runtime graph, so the facade names the graph rather than
 * spelling out six fields it would have to keep in step by hand — and an
 * absent options object returns null rather than making the facade branch.
 */
export function composeHostedSessionsForFacade(
  options: DaemonHostedSessionsOptions | undefined,
  runtimeServices: RuntimeServices,
  configManager: ConfigManager,
  runtimeBus: RuntimeEventBus,
  eventPublisher: HostedSessionEventPublisher,
): HostedSessionManager | null {
  // No options is the honest off state, not a missing wire: this daemon hosts
  // no conversation loops and `sessions.hosted.*` refuses.
  if (!options) return null;
  return composeHostedSessions({
    options,
    configManager,
    runtimeBus,
    shellPaths: runtimeServices.shellPaths,
    gatewayMethods: runtimeServices.gatewayMethods,
    liveTurns: runtimeServices.sessionLiveTurnControls,
    eventPublisher,
    spine: runtimeServices.sessionBroker,
  });
}

/**
 * State what a restore pass found. A restart that could not bring a session
 * back has to say so; leaving the counts only in the report object the caller
 * may or may not read is how a silent loss stays silent.
 */
export function reportHostedSessionRestore(report: HostedSessionLoadReport): void {
  if (report.restored.length === 0 && report.rejected.length === 0
    && report.swept.length === 0 && report.evicted.length === 0) return;
  logger.info('DaemonServer: hosted sessions restored', {
    restored: report.restored.length,
    rejected: report.rejected.length,
    swept: report.swept.length,
    evicted: report.evicted.length,
    ...(report.rejected.length > 0
      ? { rejectedFiles: report.rejected.map((entry) => `${entry.file}: ${entry.reason}`) }
      : {}),
  });
}
