import type { Tool } from '../../types/tools.js';
import type { CrossSessionTaskRef, CrossSessionTaskRegistry } from '../../sessions/orchestration/index.js';
import { LEGACY_TASK_NAMESPACE } from '../../sessions/orchestration/types.js';
import { TASK_TOOL_SCHEMA, type TaskToolInput } from './schema.js';
import { toRecord } from '../../utils/record-coerce.js';

/** Options for {@link createTaskTool}. */
export interface TaskToolOptions {
  /**
   * Resolves the REAL runtime session identity, called fresh on every tool
   * invocation.
   *
   * A getter, not a value: `runtime.sessionId` is reassigned in place when a
   * crash-recovery snapshot is accepted, so an id captured at tool-registration
   * time would keep writing refs under the boot session the user just left
   * behind. Reading it per call is the only way the tool follows the session the
   * user is actually in.
   *
   * When absent, the tool falls back to the legacy namespace and every ref it
   * writes is unowned — see {@link LEGACY_TASK_NAMESPACE}. Hosts that care
   * about owner-existence reaping must pass this.
   */
  readonly resolveSessionId?: (() => string) | undefined;
}

function summarizeRef(ref: CrossSessionTaskRef | null) {
  if (!ref) return null;
  return {
    sessionId: ref.sessionId,
    taskId: ref.taskId,
    title: ref.title,
    label: ref.label,
    status: ref.status,
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
  };
}

/**
 * The `task` tool.
 *
 * OWNERSHIP IS NOT A TOOL INPUT. The owning `sessionId` on every ref this tool
 * writes comes from `options.resolveSessionId` — the host's real runtime session
 * identity — and the model's `input.sessionId` is IGNORED for all of them. It
 * used to be the authority, defaulting to the literal `'local'`, which meant an
 * ownership key the model could set to anything (or, overwhelmingly, forget to
 * set at all). A field the caller can spoof cannot be the key a store reaps by:
 * owner-existence housekeeping over a namespace the model chooses is not
 * housekeeping, and one shared `'local'` bucket is not per-session ownership.
 *
 * `input.sessionId` still means something in exactly one place: READ modes
 * (`list`, `show`), where it selects WHICH session's refs to display. Reading
 * another session's graph is the point of a cross-session registry and asserts
 * no ownership, so it stays available and simply defaults to the caller's own
 * session. Naming another session as a dependency target
 * (`dependsOnSessionId`) or a handoff destination (`toSessionId`) likewise
 * still works — those are references to a counterparty, not a claim about who
 * owns the record being written.
 */
export function createTaskTool(registry: CrossSessionTaskRegistry, options: TaskToolOptions = {}): Tool {
  return {
    definition: {
      name: 'task',
      description: 'Manage durable cross-session task refs, dependencies, cancellations, and handoffs.',
      parameters: toRecord(TASK_TOOL_SCHEMA),
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as TaskToolInput;
      // The one authoritative identity. Every WRITE below keys on this and
      // never on input.sessionId — see the createTaskTool doc comment.
      const sessionId = options.resolveSessionId?.().trim() || LEGACY_TASK_NAMESPACE;
      // Read-only selector: which session's refs to display. Defaults to ours.
      const readSessionId = input.sessionId?.trim() || sessionId;
      const view = input.view ?? 'summary';

      if (input.mode === 'create') {
        if (!input.taskId || !input.title) {
          return { success: false, error: 'create requires taskId and title.' };
        }
        const now = Date.now();
        const result = registry.linkTask({
          sessionId,
          taskId: input.taskId,
          title: input.title,
          status: input.status ?? 'queued',
          createdAt: now,
          updatedAt: now,
          ...(input.label ? { label: input.label } : {}),
        });
        if (!result.ok) return { success: false, error: result.error ?? 'task link failed' };
        return { success: true, output: JSON.stringify(registry.getRef(sessionId, input.taskId)) };
      }

      if (input.mode === 'list') {
        const refs = registry.getRefsBySession(readSessionId);
        return {
          success: true,
          output: JSON.stringify({
            sessionId: readSessionId,
            view,
            count: refs.length,
            refs: view === 'full' ? refs : refs.map((ref) => summarizeRef(ref)),
          }),
        };
      }

      if (input.mode === 'show') {
        if (!input.taskId) return { success: false, error: 'show requires taskId.' };
        const ref = registry.getRef(readSessionId, input.taskId);
        if (!ref) return { success: false, error: `Unknown task ref: ${readSessionId}:${input.taskId}` };
        return {
          success: true,
          output: JSON.stringify({
            ref: view === 'full' ? ref : summarizeRef(ref),
            dependencies: registry.getDependencies(readSessionId, input.taskId),
            dependents: registry.getDependents(readSessionId, input.taskId),
          }),
        };
      }

      if (input.mode === 'status') {
        if (!input.taskId || !input.status) return { success: false, error: 'status requires taskId and status.' };
        const changed = registry.propagateStatus(sessionId, input.taskId, input.status);
        if (!changed) return { success: false, error: `Task ref not updated: ${sessionId}:${input.taskId}` };
        return { success: true, output: JSON.stringify(registry.getRef(sessionId, input.taskId)) };
      }

      if (input.mode === 'depend') {
        if (!input.taskId || !input.dependsOnTaskId) {
          return { success: false, error: 'depend requires taskId and dependsOnTaskId.' };
        }
        const ref = registry.getRef(sessionId, input.taskId);
        if (!ref) return { success: false, error: `Unknown task ref: ${sessionId}:${input.taskId}` };
        const result = registry.linkTask(
          ref,
          {
            sessionId: input.dependsOnSessionId?.trim() || sessionId,
            taskId: input.dependsOnTaskId,
          },
          input.reason,
        );
        if (!result.ok) return { success: false, error: result.error ?? 'dependency link failed' };
        return {
          success: true,
          output: JSON.stringify({
            ref,
            dependencies: registry.getDependencies(sessionId, input.taskId),
          }),
        };
      }

      if (input.mode === 'cancel') {
        const result = registry.cancel({
          sessionId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          scope: input.scope ?? 'task',
          requestedAt: Date.now(),
          ...(input.reason ? { reason: input.reason } : {}),
        });
        if (!result.ok) return { success: false, error: result.error ?? 'cancel failed' };
        return { success: true, output: JSON.stringify(result) };
      }

      if (input.mode === 'handoff') {
        if (!input.taskId || !input.toSessionId) {
          return { success: false, error: 'handoff requires taskId and toSessionId.' };
        }
        const result = registry.initiateHandoff(
          { sessionId, taskId: input.taskId },
          sessionId,
          input.toSessionId,
          input.reason,
        );
        if (!result.ok) return { success: false, error: result.error ?? 'handoff failed' };
        return { success: true, output: JSON.stringify({ handoffId: result.handoffId }) };
      }

      if (input.mode === 'handoffs') {
        const handoffs = registry.getHandoffs();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: handoffs.length,
            handoffs: view === 'full'
              ? handoffs
              : handoffs.map((handoff) => ({
                handoffId: handoff.handoffId,
                fromSessionId: handoff.fromSessionId,
                toSessionId: handoff.toSessionId,
                taskRef: handoff.taskRef,
                acknowledged: handoff.acknowledged,
                initiatedAt: handoff.initiatedAt,
              })),
          }),
        };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}
