/**
 * operator-contract-schemas-memory-projection.ts
 *
 * Wire schemas for the memory.projections.list / memory.projections.get verbs —
 * the live read view over standing (project/team) memory records rendered as
 * markdown. Split out of operator-contract-schemas-runtime.ts to keep that file
 * under the 800-line source cap; the memory record/enum schemas it reuses are
 * imported from there.
 */
import {
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.js';
import { STRING_LIST_SCHEMA, enumSchema } from './operator-contract-schemas-shared.js';
import {
  MEMORY_CLASS_SCHEMA,
  MEMORY_REVIEW_STATE_SCHEMA,
  MEMORY_SCOPE_SCHEMA,
} from './operator-contract-schemas-runtime.js';

const MEMORY_TEMPORAL_STATUS_SCHEMA = enumSchema(['active', 'pending', 'expired']);

/** One entry in the live memory projection — standing-record metadata + temporal status. */
export const MEMORY_PROJECTION_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  filename: STRING_SCHEMA,
  scope: MEMORY_SCOPE_SCHEMA,
  cls: MEMORY_CLASS_SCHEMA,
  summary: STRING_SCHEMA,
  tags: STRING_LIST_SCHEMA,
  confidence: NUMBER_SCHEMA,
  reviewState: MEMORY_REVIEW_STATE_SCHEMA,
  validFrom: NUMBER_SCHEMA,
  validUntil: NUMBER_SCHEMA,
  status: MEMORY_TEMPORAL_STATUS_SCHEMA,
}, ['id', 'filename', 'scope', 'cls', 'summary', 'tags', 'confidence', 'reviewState', 'status']);

export const MEMORY_PROJECTIONS_LIST_INPUT_SCHEMA = objectSchema({}, []);

export const MEMORY_PROJECTIONS_LIST_OUTPUT_SCHEMA = objectSchema({
  projections: arraySchema(MEMORY_PROJECTION_ENTRY_SCHEMA),
}, ['projections']);

export const MEMORY_PROJECTIONS_GET_INPUT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
}, ['id']);

/** One record's projection: its metadata entry plus the exact projected markdown. */
export const MEMORY_PROJECTIONS_GET_OUTPUT_SCHEMA = objectSchema({
  projection: MEMORY_PROJECTION_ENTRY_SCHEMA,
  markdown: STRING_SCHEMA,
}, ['projection', 'markdown']);
