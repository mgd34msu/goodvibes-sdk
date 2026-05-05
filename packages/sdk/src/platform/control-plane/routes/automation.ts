import type { DaemonApiRouteHandlers } from './context.js';

export async function dispatchAutomationRoutes(
  req: Request,
  handlers: Pick<
    DaemonApiRouteHandlers,
    | 'getReview'
    | 'getIntegrationSession'
    | 'getIntegrationAutomation'
    | 'getAutomationJobs'
    | 'postAutomationJob'
    | 'getAutomationRuns'
    | 'getAutomationRun'
    | 'automationRunAction'
    | 'patchAutomationJob'
    | 'deleteAutomationJob'
    | 'setAutomationJobEnabled'
    | 'runAutomationJobNow'
    | 'getDeliveries'
    | 'getDelivery'
    | 'getSchedules'
    | 'postSchedule'
    | 'deleteSchedule'
    | 'setScheduleEnabled'
    | 'runScheduleNow'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/review' && method === 'GET') return handlers.getReview();
  if (pathname === '/api/session' && method === 'GET') return handlers.getIntegrationSession();
  if (pathname === '/api/automation' && method === 'GET') return handlers.getIntegrationAutomation();
  if (pathname === '/api/automation/jobs' && method === 'GET') return handlers.getAutomationJobs();
  if (pathname === '/api/automation/jobs' && method === 'POST') return handlers.postAutomationJob(req);
  if (pathname === '/api/automation/runs' && method === 'GET') return handlers.getAutomationRuns();

  const automationRunMatch = pathname.match(/^\/api\/automation\/runs\/([^/]+)$/);
  if (automationRunMatch && method === 'GET' && automationRunMatch[1]) return handlers.getAutomationRun(automationRunMatch[1]);

  const automationRunActionMatch = pathname.match(/^\/api\/automation\/runs\/([^/]+)\/(cancel|retry)$/);
  if (automationRunActionMatch && method === 'POST') {
    const [, runId, action] = automationRunActionMatch;
    if (!runId || (action !== 'cancel' && action !== 'retry')) return null;
    return handlers.automationRunAction(runId, action, req);
  }

  const automationJobMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)$/);
  if (automationJobMatch && method === 'PATCH' && automationJobMatch[1]) return handlers.patchAutomationJob(automationJobMatch[1], req);
  if (automationJobMatch && method === 'DELETE' && automationJobMatch[1]) return handlers.deleteAutomationJob(automationJobMatch[1], req);

  const automationJobActionMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)\/(enable|disable|pause|resume|run)$/);
  if (automationJobActionMatch && method === 'POST') {
    const [, jobId, action] = automationJobActionMatch;
    if (!jobId) return null;
    if (action === 'run') return handlers.runAutomationJobNow(jobId, req);
    return handlers.setAutomationJobEnabled(jobId, action === 'enable' || action === 'resume', req);
  }

  if (pathname === '/api/deliveries' && method === 'GET') return handlers.getDeliveries();
  const deliveryMatch = pathname.match(/^\/api\/deliveries\/([^/]+)$/);
  if (deliveryMatch && method === 'GET' && deliveryMatch[1]) return handlers.getDelivery(deliveryMatch[1]);

  if (pathname === '/api/automation/schedules' && method === 'GET') return handlers.getSchedules();
  if (pathname === '/api/automation/schedules' && method === 'POST') return handlers.postSchedule(req);
  const scheduleIdMatch = pathname.match(/^\/api\/automation\/schedules\/([^/]+)$/);
  if (scheduleIdMatch && method === 'DELETE' && scheduleIdMatch[1]) return handlers.deleteSchedule(scheduleIdMatch[1], req);
  const scheduleActionMatch = pathname.match(/^\/api\/automation\/schedules\/([^/]+)\/(enable|disable|run)$/);
  if (scheduleActionMatch && method === 'POST') {
    const [, scheduleId, action] = scheduleActionMatch;
    if (!scheduleId) return null;
    if (action === 'run') return handlers.runScheduleNow(scheduleId, req);
    return handlers.setScheduleEnabled(scheduleId, action === 'enable', req);
  }

  return null;
}
