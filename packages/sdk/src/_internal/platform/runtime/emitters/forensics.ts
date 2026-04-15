import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

export function emitForensicsReportCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    reportId: string;
    classification: string;
    errorMessage?: string;
    taskId?: string;
    turnId?: string;
  },
): void {
  bus.emit('forensics', createEventEnvelope('FORENSICS_REPORT_CREATED', { type: 'FORENSICS_REPORT_CREATED', ...data }, ctx));
}
