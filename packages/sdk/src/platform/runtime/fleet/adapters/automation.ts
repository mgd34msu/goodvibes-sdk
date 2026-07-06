/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { AutomationJob } from '../../../automation/jobs.js';
import type { ProcessNode } from '../types.js';

/**
 * Automation-job node ids are namespaced separately from workflow-tool
 * ScheduleEntry ids (adapters/schedule.ts's scheduleNodeId) — same kind
 * ('schedule'), completely different id space (AutomationJob.id vs
 * ScheduleEntry.name), so the two can never collide even though a user
 * could name a workflow-tool schedule and an automation job identically.
 */
export function automationJobNodeId(jobId: string): string {
  return `automation-job:${jobId}`;
}

/** The `raw` shape for an automation-job-sourced 'schedule' node — the source marker registry.ts's control dispatch switches on to route kill/interrupt/resume to AutomationManager instead of ScheduleManager. */
export interface AutomationJobRaw {
  readonly source: 'automation-manager';
  readonly job: AutomationJob;
}

/** Type guard for AutomationJobRaw, used by registry.ts to distinguish an automation-job 'schedule' node's `raw` from a workflow-tool ScheduleEntry's `raw` — both share the 'schedule' kind. */
export function isAutomationJobRaw(raw: unknown): raw is AutomationJobRaw {
  return raw !== null && typeof raw === 'object' && (raw as { source?: unknown }).source === 'automation-manager';
}

/**
 * AutomationJob → ProcessNode. Reuses the 'schedule'
 * kind rather than inventing a new one — a job created via `/schedule` IS a
 * schedule from the user's viewpoint, even though it lives in a completely
 * separate subsystem (platform/automation) from the workflow-tool's
 * ScheduleManager (platform/tools/workflow) that adapters/schedule.ts
 * already covers. `raw.source: 'automation-manager'` (AutomationJobRaw)
 * distinguishes the origin so registry.ts's kill/interrupt/resume dispatch
 * can route to the right manager.
 */
export function adaptAutomationJob(job: AutomationJob): ProcessNode {
  return {
    id: automationJobNodeId(job.id),
    kind: 'schedule',
    parentId: undefined,
    label: job.name,
    task: job.execution.prompt,
    state: job.enabled ? 'idle' : 'paused',
    startedAt: job.lastRunAt,
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: job.enabled, resumable: !job.enabled, steerable: false },
    raw: { source: 'automation-manager', job } satisfies AutomationJobRaw,
  };
}
