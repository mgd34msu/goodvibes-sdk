/**
 * routes/worktree-setup.ts
 *
 * Handler for `worktrees.setup.run` — the rerun affordance for worktree
 * cold-start setup. Re-runs the configured setup (commands + untracked-file
 * carry-over) on a live worktree by path, records the honest outcome onto the
 * worktree registry record (so a failed setup stays a visible worktree state),
 * and returns the result. Registered from services.ts, the composition root
 * that holds the worktree registry, the daemon config, and the source root.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { WorktreeRegistry } from '../../runtime/worktree/registry.js';
import { runWorktreeSetup, type WorktreeSetupConfig } from '../../runtime/worktree/setup.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** The deps the worktree lifecycle verbs need — the registry to act on, the source root to carry from, and the current setup config. */
export interface WorktreeSetupGatewayDeps {
  readonly registry: Pick<WorktreeRegistry, 'recordSetup' | 'discard'>;
  readonly sourceRoot: string;
  /** Resolves the current per-project setup config (read fresh each run so a config change takes effect without a restart). */
  readonly resolveConfig: () => WorktreeSetupConfig;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

export function createWorktreeSetupRunHandler(deps: WorktreeSetupGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requiredString(params.path, 'path');
    const setup = await runWorktreeSetup(path, deps.sourceRoot, deps.resolveConfig());
    deps.registry.recordSetup(path, setup);
    return { path, setup };
  };
}

/**
 * `worktrees.discard` — discard actually discards: the registry's
 * eviction-preserving removal (dirty state committed onto the KEPT branch,
 * directory removed, record dropped) with the honest receipt as the output.
 */
export function createWorktreeDiscardHandler(deps: WorktreeSetupGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const path = requiredString(params.path, 'path');
    return await deps.registry.discard(path);
  };
}

/** Attach the worktree lifecycle handlers to their already-registered descriptors. Missing descriptors are silent no-ops. */
export function registerWorktreeSetupGatewayMethods(catalog: GatewayMethodCatalog, deps: WorktreeSetupGatewayDeps): void {
  const setup = catalog.get('worktrees.setup.run');
  if (setup) catalog.register(setup, createWorktreeSetupRunHandler(deps), { replace: true });
  const discard = catalog.get('worktrees.discard');
  if (discard) catalog.register(discard, createWorktreeDiscardHandler(deps), { replace: true });
}
