import type { DaemonAutomationRouteHandlers } from './context.js';

export async function dispatchAutomationRoutes(
  req: Request,
  handlers: DaemonAutomationRouteHandlers,
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
  if (automationRunMatch && method === 'GET') return handlers.getAutomationRun(automationRunMatch[1]!);

  const automationRunActionMatch = pathname.match(/^\/api\/automation\/runs\/([^/]+)\/(cancel|retry)$/);
  if (automationRunActionMatch && method === 'POST') {
    return handlers.automationRunAction(automationRunActionMatch[1]!, automationRunActionMatch[2]! as 'cancel' | 'retry', req);
  }

  const automationJobMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)$/);
  if (automationJobMatch && method === 'PATCH') return handlers.patchAutomationJob(automationJobMatch[1]!, req);
  if (automationJobMatch && method === 'DELETE') return handlers.deleteAutomationJob(automationJobMatch[1]!, req);

  const automationJobActionMatch = pathname.match(/^\/api\/automation\/jobs\/([^/]+)\/(enable|disable|pause|resume|run)$/);
  if (automationJobActionMatch && method === 'POST') {
    const [, jobId, action] = automationJobActionMatch;
    if (action === 'run') return handlers.runAutomationJobNow(jobId!, req);
    return handlers.setAutomationJobEnabled(jobId!, action === 'enable' || action === 'resume', req);
  }

  if (pathname === '/api/deliveries' && method === 'GET') return handlers.getDeliveries();
  const deliveryMatch = pathname.match(/^\/api\/deliveries\/([^/]+)$/);
  if (deliveryMatch && method === 'GET') return handlers.getDelivery(deliveryMatch[1]!);

  // m11: /schedules (non-/api/-prefixed) and /api/automation/jobs are dual surfaces
  // with overlapping schedule semantics (both list/create/delete). Preserved for
  // backward compatibility; /api/automation/jobs is the canonical surface.
  if (pathname === '/schedules' && method === 'GET') return handlers.getSchedules();
  if (pathname === '/schedules' && method === 'POST') return handlers.postSchedule(req);
  const scheduleIdMatch = pathname.match(/^\/schedules\/([^/]+)$/);
  if (scheduleIdMatch && method === 'DELETE') return handlers.deleteSchedule(scheduleIdMatch[1]!, req);
  const scheduleActionMatch = pathname.match(/^\/schedules\/([^/]+)\/(enable|disable|run)$/);
  if (scheduleActionMatch && method === 'POST') {
    const [, scheduleId, action] = scheduleActionMatch;
    if (action === 'run') return handlers.runScheduleNow(scheduleId!, req);
    return handlers.setScheduleEnabled(scheduleId!, action === 'enable', req);
  }

  return null;
}
