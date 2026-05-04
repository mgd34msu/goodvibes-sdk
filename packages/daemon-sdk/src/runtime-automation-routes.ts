import type { DaemonRuntimeAutomationRouteHandlers } from './context.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';
import { withAdmin } from './auth-helpers.js';
import { jsonErrorResponse } from './error-response.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readOptionalStringField,
  readStringArrayField,
  type JsonRecord,
} from './route-helpers.js';

type AutomationScheduleBody = {
  readonly prompt: string;
  readonly kind: string;
  readonly cron?: string | undefined;
  readonly every?: string | undefined;
  readonly at?: string | number | undefined;
  readonly timezone?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fallbackModels?: string[] | undefined;
};

export function createDaemonRuntimeAutomationRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeAutomationRouteHandlers {
  return {
    getAutomationJobs: () => Response.json({ jobs: context.automationManager.listJobs() }),
    postAutomationJob: async (request) => withAdmin(context, request, () => handlePostSchedule(context, request)),
    getAutomationRuns: () => Response.json({ runs: context.automationManager.listRuns() }),
    getAutomationRun: (runId) => handleGetAutomationRun(context, runId),
    getAutomationHeartbeat: () => Response.json({ pending: [] }),
    postAutomationHeartbeat: async (request) => withAdmin(context, request, () => handlePostAutomationHeartbeat(context, request)),
    automationRunAction: async (runId, action, request) => withAdmin(context, request, () => handleAutomationRunAction(context, runId, action, request)),
    patchAutomationJob: async (jobId, request) => withAdmin(context, request, () => handlePatchSchedule(context, jobId, request)),
    deleteAutomationJob: async (jobId, request) => withAdmin(context, request, () => handleDeleteSchedule(context, jobId)),
    setAutomationJobEnabled: async (jobId, enabled, request) => withAdmin(context, request, () => handleSetScheduleEnabled(context, jobId, enabled)),
    runAutomationJobNow: async (jobId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, jobId)),
    getSchedules: () => handleGetSchedules(context),
    postSchedule: (request) => withAdmin(context, request, () => handlePostSchedule(context, request)),
    deleteSchedule: async (scheduleId, request) => withAdmin(context, request, () => handleDeleteSchedule(context, scheduleId)),
    setScheduleEnabled: (scheduleId, enabled, request) => withAdmin(context, request, () => handleSetScheduleEnabled(context, scheduleId, enabled)),
    runScheduleNow: (scheduleId, request) => withAdmin(context, request, () => handleRunScheduleNow(context, scheduleId)),
    getSchedulerCapacity: (req) => withAdmin(context, req, () => Response.json(context.automationManager.getSchedulerCapacity())),
  };
}


function handleGetSchedules(context: DaemonRuntimeRouteContext): Response {
  const jobs = context.automationManager.listJobs();
  const runs = context.automationManager.listRuns().slice(0, 50);
  return Response.json({ jobs, runs });
}

const automationBodySchemas = createRouteBodySchemaRegistry({
  schedule: createRouteBodySchema<AutomationScheduleBody>('POST /api/automation/schedules', (body) => {
    const prompt = readOptionalStringField(body, 'prompt');
    if (!prompt) return jsonErrorResponse({ error: 'Missing required field: prompt (string)' }, { status: 400 });
    if (prompt.length > 10_000) {
      return jsonErrorResponse({ error: 'prompt exceeds maximum length of 10000 characters' }, { status: 400 });
    }
    const scheduleObj = body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
      ? body.schedule as JsonRecord
      : null;
    const timeoutMs = readScheduleTimeoutMs(body.timeoutMs);
    if (timeoutMs instanceof Response) return timeoutMs;
    const cron = readOptionalStringField(body, 'cron') ?? readOptionalStringField(scheduleObj ?? {}, 'expression');
    const every = readOptionalStringField(body, 'every');
    const timezone = readOptionalStringField(body, 'timezone');
    const fallbackModels = readStringArrayField(body, 'fallbackModels');
    return {
      prompt,
      kind: readOptionalStringField(body, 'kind') ?? 'cron',
      ...(cron ? { cron } : {}),
      ...(every ? { every } : {}),
      ...(typeof body.at === 'string' || typeof body.at === 'number' ? { at: body.at } : {}),
      ...(timezone ? { timezone } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(fallbackModels ? { fallbackModels } : {}),
    };
  }),
});

function readScheduleTimeoutMs(value: unknown): number | Response | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return jsonErrorResponse({ error: 'timeoutMs must be a finite positive number' }, { status: 400 });
  }
  return readBoundedBodyInteger(value, 1, 86_400_000);
}

async function handlePostSchedule(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = automationBodySchemas.schedule.parse(body);
  if (input instanceof Response) return input;
  try {
    const schedule = input.kind === 'every'
      ? context.normalizeEverySchedule(input.every ?? '')
      : input.kind === 'at'
        ? context.normalizeAtSchedule(readAtSchedule(input.at))
        : context.normalizeCronSchedule(input.cron ?? '', input.timezone, body.staggerMs ?? body.stagger);
    const job = await context.automationManager.createJob({
      name: typeof body.name === 'string' ? body.name : input.prompt.slice(0, 40),
      prompt: input.prompt,
      schedule,
      description: input.prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      ...(input.fallbackModels ? { fallbackModels: input.fallbackModels } : {}),
      template: typeof body.template === 'string' ? body.template : undefined,
      target: typeof body.target === 'object' && body.target !== null ? body.target as Record<string, unknown> : undefined,
      reasoningEffort: body.reasoningEffort,
      thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
      wakeMode: body.wakeMode,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist.filter((value: unknown): value is string => typeof value === 'string') : undefined,
      autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : undefined,
      allowUnsafeExternalContent: typeof body.allowUnsafeExternalContent === 'boolean' ? body.allowUnsafeExternalContent : undefined,
      externalContentSource: body.externalContentSource,
      lightContext: typeof body.lightContext === 'boolean' ? body.lightContext : undefined,
      delivery: typeof body.delivery === 'object' && body.delivery !== null ? body.delivery : undefined,
      failure: typeof body.failure === 'object' && body.failure !== null ? body.failure : undefined,
      enabled: body.enabled !== false,
      deleteAfterRun: typeof body.deleteAfterRun === 'boolean' ? body.deleteAfterRun : undefined,
    });
    return Response.json(job, { status: 201 });
  } catch (e: unknown) {
    return jsonErrorResponse(e, { status: 400, fallbackMessage: 'Failed to create schedule' });
  }
}

function readAtSchedule(at: string | number | undefined): number {
  const value = typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(value)) {
    throw new Error('Invalid at schedule; expected an epoch timestamp or parseable date string');
  }
  return value;
}

async function handlePatchSchedule(context: DaemonRuntimeRouteContext, id: string, req: Request): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const updated = await context.automationManager.updateJob(job.id, body as Record<string, unknown>);
    return updated
      ? Response.json(updated)
      : jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to update schedule' });
  }
}

async function handleDeleteSchedule(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  await context.automationManager.removeJob(job.id);
  return Response.json({ removed: true, id: job.id });
}

async function handleSetScheduleEnabled(context: DaemonRuntimeRouteContext, id: string, enabled: boolean): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  const updated = await context.automationManager.setEnabled(job.id, enabled);
  return Response.json(updated ?? { id: job.id, enabled });
}

async function handleRunScheduleNow(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return jsonErrorResponse({ error: `Schedule not found: ${id}` }, { status: 404 });
  try {
    const run = await context.automationManager.runNow(job.id);
    return Response.json({ jobId: job.id, runId: run.id, agentId: run.agentId, status: run.status });
  } catch (e: unknown) {
    return jsonErrorResponse(e, { status: 500, fallbackMessage: 'Failed to run schedule' });
  }
}

async function handlePostAutomationHeartbeat(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  // m2: Schema: only `source` (optional string) is consumed; extra fields are ignored.
  const result = await context.automationManager.triggerHeartbeat({
    source: body && typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'api',
  });
  return Response.json(result);
}

async function handleAutomationRunAction(
  context: DaemonRuntimeRouteContext,
  runId: string,
  action: 'cancel' | 'retry',
  req: Request,
): Promise<Response> {
  if (action === 'cancel') {
    const body = await context.parseOptionalJsonBody(req);
    if (body instanceof Response) return body; // m19: preserve parse error rather than coercing to 'operator-cancelled'
    const reason = body && typeof body.reason === 'string'
      ? body.reason
      : 'operator-cancelled';
    const run = await context.automationManager.cancelRun(runId, reason);
    return run
      ? context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }))
      : context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, jsonErrorResponse({ error: 'Unknown automation run' }, { status: 404 }));
  }
  try {
    const run = await context.automationManager.retryRun(runId);
    return context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }, { status: 202 }));
  } catch (error) {
    return context.recordApiResponse(
      req,
      `/api/automation/runs/${runId}/${action}`,
      jsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to retry automation run' }),
    );
  }
}

function handleGetAutomationRun(context: DaemonRuntimeRouteContext, runId: string): Response {
  const run = context.automationManager.getRun(runId);
  if (!run) {
    return jsonErrorResponse({ error: 'Unknown automation run' }, { status: 404 });
  }
  return Response.json({ run, deliveries: [] });
}

function findAutomationJob(context: DaemonRuntimeRouteContext, id: string) {
  // MAJ-01: exact-match only — prefix match was non-deterministic when multiple ids share a prefix.
  return context.automationManager.listJobs().find((entry) => entry.id === id);
}
