/**
 * operator-contract-schemas-flags.ts
 *
 * Input/output JSON schemas for flags.graduation.report — the read-only
 * feature-flag graduation view (see runtime/feature-flags/graduation.ts). The
 * report lists every flag with its graduation state and whatever real
 * validation evidence exists; the release policy fails when any flag sits in
 * graduate-candidate. ws-only invoke verb (no REST binding). Handlers:
 * routes/flags-graduation.ts.
 */
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  STRING_LIST_SCHEMA,
  arraySchema,
  enumSchema,
  nullableSchema,
  objectSchema,
} from './operator-contract-schemas-shared.js';

/** flags.graduation.report takes no arguments. */
export const FLAGS_GRADUATION_REPORT_INPUT_SCHEMA = objectSchema({}, []);

const FLAG_GRADUATION_BLOCKER_SCHEMA = objectSchema(
  {
    reason: STRING_SCHEMA,
    date: STRING_SCHEMA,
  },
  ['reason', 'date'],
);

const FLAG_GRADUATION_DIVERGENCE_SCHEMA = objectSchema(
  {
    divergenceRate: NUMBER_SCHEMA,
    totalEvaluations: NUMBER_SCHEMA,
    gateStatus: enumSchema(['allowed', 'blocked', 'no_data']),
  },
  ['divergenceRate', 'totalEvaluations', 'gateStatus'],
);

const FLAG_GRADUATION_EVIDENCE_SCHEMA = objectSchema(
  {
    instrumentation: enumSchema(['divergence-simulation', 'none']),
    divergence: nullableSchema(FLAG_GRADUATION_DIVERGENCE_SCHEMA),
    note: STRING_SCHEMA,
  },
  ['instrumentation', 'divergence', 'note'],
);

const FLAG_GRADUATION_ENTRY_SCHEMA = objectSchema(
  {
    flagId: STRING_SCHEMA,
    name: STRING_SCHEMA,
    tier: NUMBER_SCHEMA,
    currentDefault: enumSchema(['enabled', 'disabled', 'killed']),
    runtimeToggleable: BOOLEAN_SCHEMA,
    state: enumSchema(['dark', 'soaking', 'graduate-candidate', 'graduated', 'blocked']),
    evidence: FLAG_GRADUATION_EVIDENCE_SCHEMA,
    blocker: nullableSchema(FLAG_GRADUATION_BLOCKER_SCHEMA),
    note: nullableSchema(STRING_SCHEMA),
  },
  ['flagId', 'name', 'tier', 'currentDefault', 'runtimeToggleable', 'state', 'evidence', 'blocker', 'note'],
);

const FLAG_GRADUATION_SUMMARY_SCHEMA = objectSchema(
  {
    total: NUMBER_SCHEMA,
    dark: NUMBER_SCHEMA,
    soaking: NUMBER_SCHEMA,
    graduateCandidate: NUMBER_SCHEMA,
    graduated: NUMBER_SCHEMA,
    blocked: NUMBER_SCHEMA,
  },
  ['total', 'dark', 'soaking', 'graduateCandidate', 'graduated', 'blocked'],
);

export const FLAGS_GRADUATION_REPORT_OUTPUT_SCHEMA = objectSchema(
  {
    generatedAt: NUMBER_SCHEMA,
    entries: arraySchema(FLAG_GRADUATION_ENTRY_SCHEMA),
    summary: FLAG_GRADUATION_SUMMARY_SCHEMA,
    releaseBlockers: STRING_LIST_SCHEMA,
  },
  ['generatedAt', 'entries', 'summary', 'releaseBlockers'],
);
