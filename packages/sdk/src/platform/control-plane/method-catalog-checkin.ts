/**
 * method-catalog-checkin.ts
 *
 * Contract descriptors for the proactive check-in verbs (checkin.config.get/set,
 * checkin.receipts.list, checkin.run). These expose the CheckinService
 * (../../checkin) over the operator surface: read/update the cadence, delivery
 * channel, and quiet hours; read the visible run receipts; and trigger a check-in
 * now. The scheduled runs ride the automation scheduler as a kind:'checkin' job.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  EMPTY_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  entityOutputSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

export const CHECKIN_CONFIG_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  cadence: STRING_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  quietHours: STRING_SCHEMA,
}, ['enabled', 'cadence', 'deliveryChannel', 'quietHours']);

const CHECKIN_TRIGGER_SCHEMA = { type: 'string', enum: ['scheduled', 'manual'] } as const;
const CHECKIN_RECEIPT_OUTCOME_SCHEMA = {
  type: 'string',
  enum: ['delivered', 'quiet', 'skipped-disabled', 'skipped-quiet-hours', 'error'],
} as const;
const CHECKIN_RUN_OUTCOME_SCHEMA = { type: 'string', enum: ['delivered', 'quiet', 'skipped', 'error'] } as const;

export const CHECKIN_RECEIPT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  ranAt: NUMBER_SCHEMA,
  trigger: CHECKIN_TRIGGER_SCHEMA,
  outcome: CHECKIN_RECEIPT_OUTCOME_SCHEMA,
  briefingSummary: STRING_SCHEMA,
  decisionReason: STRING_SCHEMA,
  deliveredMessage: STRING_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  deliveryId: STRING_SCHEMA,
  error: STRING_SCHEMA,
}, ['id', 'ranAt', 'trigger', 'outcome', 'briefingSummary']);

export const CHECKIN_CONFIG_GET_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const CHECKIN_CONFIG_GET_OUTPUT_SCHEMA = entityOutputSchema('config', CHECKIN_CONFIG_SCHEMA);

export const CHECKIN_CONFIG_SET_INPUT_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  cadence: STRING_SCHEMA,
  deliveryChannel: STRING_SCHEMA,
  quietHours: STRING_SCHEMA,
}, []);
export const CHECKIN_CONFIG_SET_OUTPUT_SCHEMA = entityOutputSchema('config', CHECKIN_CONFIG_SCHEMA);

export const CHECKIN_RECEIPTS_LIST_INPUT_SCHEMA = objectSchema({ limit: NUMBER_SCHEMA }, []);
export const CHECKIN_RECEIPTS_LIST_OUTPUT_SCHEMA = listOutputSchema('receipts', CHECKIN_RECEIPT_SCHEMA);

export const CHECKIN_RUN_INPUT_SCHEMA = EMPTY_OBJECT_SCHEMA;
export const CHECKIN_RUN_OUTPUT_SCHEMA = objectSchema({
  outcome: CHECKIN_RUN_OUTCOME_SCHEMA,
  summary: STRING_SCHEMA,
  deliveryId: STRING_SCHEMA,
}, ['outcome', 'summary']);

export const builtinGatewayCheckinMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'checkin.config.get',
    title: 'Get Check-in Config',
    description: 'Return the proactive check-in configuration: enabled, cadence (cron), delivery channel, and quiet hours.',
    category: 'checkin',
    scopes: ['read:checkin'],
    http: { method: 'GET', path: '/api/checkin/config' },
    inputSchema: CHECKIN_CONFIG_GET_INPUT_SCHEMA,
    outputSchema: CHECKIN_CONFIG_GET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkin.config.set',
    title: 'Update Check-in Config',
    description: 'Update the proactive check-in configuration. Absent fields are left unchanged. Enabling syncs the kind:checkin automation job onto the scheduler; disabling stops it.',
    category: 'checkin',
    scopes: ['write:checkin'],
    access: 'admin',
    http: { method: 'POST', path: '/api/checkin/config' },
    inputSchema: CHECKIN_CONFIG_SET_INPUT_SCHEMA,
    outputSchema: CHECKIN_CONFIG_SET_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkin.receipts.list',
    title: 'List Check-in Receipts',
    description: 'Return the visible receipts of past check-in runs (newest first): each run records whether it stayed quiet, delivered a message (and what), or was skipped.',
    category: 'checkin',
    scopes: ['read:checkin'],
    http: { method: 'GET', path: '/api/checkin/receipts' },
    inputSchema: CHECKIN_RECEIPTS_LIST_INPUT_SCHEMA,
    outputSchema: CHECKIN_RECEIPTS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'checkin.run',
    title: 'Run Check-in Now',
    description: 'Trigger one check-in evaluation immediately (a manual run): assemble the briefing, judge whether to contact the user, deliver if so, and record a receipt.',
    category: 'checkin',
    scopes: ['write:checkin'],
    http: { method: 'POST', path: '/api/checkin/run' },
    inputSchema: CHECKIN_RUN_INPUT_SCHEMA,
    outputSchema: CHECKIN_RUN_OUTPUT_SCHEMA,
  }),
];
