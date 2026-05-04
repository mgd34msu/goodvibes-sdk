import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

export function emitForensicsReportCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    reportId: string;
    classification: string;
    errorMessage?: string | undefined;
    taskId?: string | undefined;
    turnId?: string | undefined;
  },
): void {
  bus.emit('forensics', createEventEnvelope('FORENSICS_REPORT_CREATED', { type: 'FORENSICS_REPORT_CREATED', ...data }, ctx));
}
