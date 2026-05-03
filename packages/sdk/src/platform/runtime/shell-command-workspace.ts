import type { ComponentHealthMonitor } from './perf/component-health-monitor.js';
import type { SandboxSessionRegistry } from './sandbox/session-registry.js';
import type { ShellPathService } from './shell-paths.js';
import type { WorktreeRegistry } from './worktree/registry.js';

export interface CommandWorkspaceShellServices {
  readonly shellPaths?: ShellPathService;
  readonly componentHealthMonitor?: ComponentHealthMonitor;
  readonly worktreeRegistry?: WorktreeRegistry;
  readonly sandboxSessionRegistry?: SandboxSessionRegistry;
}

export interface CreateShellWorkspaceServicesOptions extends CommandWorkspaceShellServices {}

export function createShellWorkspaceServices(
  options: CreateShellWorkspaceServicesOptions,
): CommandWorkspaceShellServices {
  const {
    shellPaths,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
  } = options;

  return {
    shellPaths,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
  };
}
