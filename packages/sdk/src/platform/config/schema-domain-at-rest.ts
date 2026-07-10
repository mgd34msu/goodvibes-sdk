/**
 * schema-domain-at-rest.ts — config for the at-rest redaction + retention policy
 * applied to the on-disk transcript journal (agents/session.ts) and local
 * execution ledger (runtime/telemetry/exporters/local-ledger.ts). Consumed by
 * runtime/at-rest-persistence.ts (resolveAtRestPolicy).
 *
 * Honest defaults: redaction ON by default (secrets never persisted in the
 * clear); retention generous but bounded (30 days / 512 MB) so a normal
 * debugging window survives while a long-lived daemon cannot grow these files
 * without limit.
 */
import type { AtRestConfig, ConfigSetting } from './schema-types.js';
import { intRange } from './schema-shared.js';

export const atRestConfigDefaults: { atRest: AtRestConfig } = {
  atRest: {
    redactionEnabled: true,
    retentionMaxAgeDays: 30,
    retentionMaxTotalMb: 512,
  },
};

export const atRestConfigSettings: ConfigSetting[] = [
  {
    key: 'atRest.redactionEnabled',
    type: 'boolean',
    default: true,
    description:
      'When true (default), secret/credential patterns (API keys, bearer tokens, GitHub/GitLab/Slack/AWS credentials, home paths) are redacted at WRITE time from the on-disk transcript journal (per-agent <agentId>.jsonl) and the local execution ledger (spans + ledger jsonl), reusing the same pattern set as the telemetry egress. A redacted value shows a [REDACTED_*] marker — a record never pretends the content was absent. Set false ONLY for local debugging where plaintext secrets on disk are acceptable.',
  },
  {
    key: 'atRest.retentionMaxAgeDays',
    type: 'number',
    default: 30,
    description:
      'Age cap (days) for the on-disk transcript journal and execution-ledger files. Files older than this are pruned at the retention enforcement point (the journal prunes on each new agent session; the ledger prunes on each export). Generous by default; bounded so the files cannot grow without limit.',
    ...intRange(1, 365),
  },
  {
    key: 'atRest.retentionMaxTotalMb',
    type: 'number',
    default: 512,
    description:
      'Total-size cap (MB) across the on-disk transcript journal / execution-ledger file set. When exceeded, the retention enforcement point deletes oldest-first (rotated backups before freshly-written active files) until under budget.',
    ...intRange(1, 1_048_576),
  },
];
