/**
 * The shutdown seam for a composed runtime graph.
 *
 * `createRuntimeServices()` starts pollers while it builds: the config-file
 * watch, the fleet registry tick, the memory governor, the watcher registry,
 * the cross-session orchestration sweep, the orchestration snapshot writer, the
 * push-subscription sweep, the knowledge scheduler, and the snapshot /
 * retention / consolidation schedulers. Every one of those owners already had
 * its own `stop()` or `dispose()`; what did not exist was anything that called
 * them. A host that built a graph could not take it back down, so
 * `DaemonServer.stop()` returned with two thirds of the daemon's timers still
 * ticking.
 *
 * Teardown is best-effort and total. One owner that throws must not strand the
 * owners behind it, mirroring the `Promise.allSettled` stance the daemon CLI
 * already takes on shutdown: a subsystem refusing to stop cannot be allowed to
 * leave the caller unable to shut anything down.
 *
 * Not every owner here holds a literal timer. The list is what the graph must
 * put down before it can honestly call itself stopped, which also covers the
 * agent runs it was hosting: an agent whose registry, engine and bus are gone
 * has nowhere to report to, and its in-flight provider call is only reachable
 * through its cancellation signal.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Where a poller owner registers the call that stops it. */
export interface DisposalRegistry {
  /**
   * Register a teardown callback.
   *
   * @param label - Names the owner in the warning logged if teardown throws.
   *   Use the thing being stopped ("fleet registry"), not the method.
   */
  add(label: string, dispose: () => void): void;
}

/** A registry plus the one call that runs everything registered on it. */
export interface DisposalScope {
  readonly registry: DisposalRegistry;
  /** Run every registered teardown, newest first. Idempotent. */
  dispose(): void;
}

export function createDisposalScope(scopeName: string): DisposalScope {
  const entries: { label: string; dispose: () => void }[] = [];
  let disposed = false;

  return {
    registry: {
      add(label, dispose) {
        // Registering against an already-disposed scope would silently create a
        // resource nothing will ever stop, the exact failure this module
        // exists to prevent, so stop it immediately instead.
        if (disposed) {
          dispose();
          return;
        }
        entries.push({ label, dispose });
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Reverse order: later entries were built on earlier ones, so they come
      // down first, exactly as construction order implies.
      for (const entry of entries.reverse()) {
        try {
          entry.dispose();
        } catch (error) {
          logger.warn(`${scopeName}: teardown failed`, {
            subsystem: entry.label,
            error: summarizeError(error),
          });
        }
      }
      entries.length = 0;
    },
  };
}

/**
 * Every poller owner a composed runtime graph holds.
 *
 * Deliberately all-required and structurally typed. A poller added to the graph
 * later has to be named here to compile, which is what keeps this list honest,
 * the previous arrangement (each owner disposed at its own call site, or not)
 * is how seven of these came to be started and never stopped. Structural types
 * rather than the concrete classes so the consumer forks, which compose the
 * same subsystems from the published package, can call this too.
 */
export interface RuntimePollerOwners {
  /** Handle returned by `ConfigManager.watchConfigFiles()`. */
  readonly stopConfigWatch: () => void;
  readonly watcherRegistry: { dispose(): void };
  readonly storeSnapshotScheduler: { stop(): void };
  readonly appendOnlyRetentionScheduler: { stop(): void };
  readonly memoryConsolidationScheduler: { stop(): void };
  readonly codeIndexReindexScheduler: { dispose(): void };
  readonly sessionOrchestration: { dispose(): void };
  readonly knowledgeService: { dispose(): void };
  readonly agentKnowledgeService: { dispose(): void };
  /**
   * Cancels the Home Graph post-sync self-improvement pump, a rescheduling
   * loop with a 5s start delay and a 5-15s sleep between as many as ten rounds.
   * It had a dispose() from the day it was written and simply was not named
   * here, which is the whole reason this list is all-required.
   */
  readonly homeGraphService: { dispose(): void };
  readonly wrfcController: { dispose(): void };
  /** Disposing the engine also detaches the orchestration snapshot writer's hourly reap. */
  readonly orchestrationEngine: { dispose(): void };
  readonly processRegistry: { dispose(): void };
  readonly memoryGovernor: { stop(): void };
  /**
   * Releases the ProjectIndex the orchestrator builds for each non-default
   * agent working directory (a worktree an agent was spawned into). Each holds
   * a debounced flush timer and is referenced only from the tool closures of a
   * cached registry, so nothing else can reach it.
   */
  readonly agentOrchestrator: { dispose(): void };
  /**
   * Cancels the agent runs this graph was hosting, returning how many. Not a
   * poller, but the same kind of thing left ticking: an agent whose registry,
   * engine and bus have been disposed keeps its provider call in flight and
   * keeps sleeping out its retry backoff, with nothing left to report to.
   * See tools/agent/cancel-all.ts for the implementation both roots pass in.
   */
  readonly cancelHostedAgentRuns: () => number;
  /** Absent in compositions that build no trigger family. */
  readonly triggerManager?: { shutdown(): void } | undefined;
}

/**
 * Register the stop call for every poller a runtime graph started.
 *
 * The push-subscription sweep is NOT here: it is constructed inside gateway
 * verb registration, which takes the registry directly and registers its own.
 */
export function registerRuntimePollers(registry: DisposalRegistry, owners: RuntimePollerOwners): void {
  registry.add('config file watch', owners.stopConfigWatch);
  registry.add('watcher registry', () => owners.watcherRegistry.dispose());
  registry.add('store snapshot scheduler', () => owners.storeSnapshotScheduler.stop());
  registry.add('append-only retention scheduler', () => owners.appendOnlyRetentionScheduler.stop());
  registry.add('memory consolidation scheduler', () => owners.memoryConsolidationScheduler.stop());
  registry.add('code-index reindex scheduler', () => owners.codeIndexReindexScheduler.dispose());
  registry.add('cross-session task registry', () => owners.sessionOrchestration.dispose());
  registry.add('knowledge service', () => owners.knowledgeService.dispose());
  registry.add('agent knowledge service', () => owners.agentKnowledgeService.dispose());
  registry.add('home graph service', () => owners.homeGraphService.dispose());
  registry.add('wrfc controller', () => owners.wrfcController.dispose());
  registry.add('orchestration engine', () => owners.orchestrationEngine.dispose());
  registry.add('fleet process registry', () => owners.processRegistry.dispose());
  registry.add('memory governor', () => owners.memoryGovernor.stop());
  registry.add('agent orchestrator tool registries', () => owners.agentOrchestrator.dispose());
  const triggers = owners.triggerManager;
  if (triggers) registry.add('trigger manager', () => triggers.shutdown());
  // Registered LAST so it runs FIRST (the scope unwinds in reverse). A running
  // agent keeps making tool calls into the fleet registry, orchestration engine
  // and process registry, so it has to be told to stop BEFORE those are taken
  // out from under it, otherwise the window between is spent driving half-torn-
  // down subsystems.
  registry.add('hosted agent runs', () => {
    const cancelled = owners.cancelHostedAgentRuns();
    if (cancelled > 0) logger.info('Runtime disposal cancelled in-flight agent runs', { cancelled });
  });
}
