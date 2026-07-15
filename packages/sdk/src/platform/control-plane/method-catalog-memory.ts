/**
 * method-catalog-memory.ts — the MemoryGovernor observability verb.
 *
 * `ops.memory.get` serves the governor snapshot: current tier, budget, RSS/heap,
 * per-cache footprints, paused jobs, and tripwire state — so operators can see
 * the daemon defending its own footprint.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const CACHE_FOOTPRINT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  entries: NUMBER_SCHEMA,
  estimatedBytes: NUMBER_SCHEMA,
}, ['id', 'name', 'entries']);

const MEMORY_SNAPSHOT_SCHEMA = objectSchema({
  tier: { type: 'string', enum: ['normal', 'elevated', 'high', 'critical'] },
  budgetMb: NUMBER_SCHEMA,
  rssMb: NUMBER_SCHEMA,
  heapUsedMb: NUMBER_SCHEMA,
  heapTotalMb: NUMBER_SCHEMA,
  usedPct: NUMBER_SCHEMA,
  refusingExpensiveWork: BOOLEAN_SCHEMA,
  caches: { type: 'array', items: CACHE_FOOTPRINT_SCHEMA },
  pausedJobs: { type: 'array', items: STRING_SCHEMA },
  tripwire: objectSchema({
    armed: BOOLEAN_SCHEMA,
    sustainedSec: NUMBER_SCHEMA,
    rateMbPerSec: NUMBER_SCHEMA,
  }, ['armed', 'sustainedSec', 'rateMbPerSec']),
  thresholds: objectSchema({
    elevatedPct: NUMBER_SCHEMA,
    highPct: NUMBER_SCHEMA,
    criticalPct: NUMBER_SCHEMA,
  }, ['elevatedPct', 'highPct', 'criticalPct']),
}, [
  'tier', 'budgetMb', 'rssMb', 'heapUsedMb', 'usedPct',
  'refusingExpensiveWork', 'caches', 'pausedJobs', 'tripwire', 'thresholds',
]);

export const builtinGatewayMemoryMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'ops.memory.get',
    title: 'Get Memory Governance State',
    description:
      'The MemoryGovernor snapshot: the current memory-pressure tier and budget, resident set size and heap, per-cache footprints the governor can shrink, which deferrable background jobs are paused, and the leak-tripwire state. Read-only observability so operators can see the daemon shedding memory before it approaches OOM.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/ops/memory' },
    inputSchema: objectSchema({}, []),
    outputSchema: MEMORY_SNAPSHOT_SCHEMA,
  }),
];
