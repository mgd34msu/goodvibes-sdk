import { asPhasedTool } from '../../runtime/tools/adapter.js';
import type { PhasedTool } from '../../runtime/tools/adapter.js';
import { createExecTool } from './index.js';
import { ProcessManager } from '../shared/process-manager.js';

/**
 * Creates a phased version of the exec tool.
 *
 * The exec tool is categorised as `execute` — it runs arbitrary shell commands
 * and therefore requires full permission checks in the prehook phase.
 * It is cancellable: the underlying process manager supports SIGTERM/SIGKILL,
 * so the phased executor can abort long-running commands via AbortSignal.
 *
 * Phase timeout: 120 000 ms (2 min) for the executing phase, matching the
 * exec tool's own default timeout for individual commands.
 *
 * @returns A PhasedTool wrapping an owned exec tool instance.
 */
export function createPhasedExecTool(): PhasedTool {
  return asPhasedTool(createExecTool(new ProcessManager()), {
    category: 'execute',
    cancellable: true,
    phaseTimeouts: {
      executing: 120_000,
    },
  });
}
