import { SQLiteStore } from '../state/sqlite-store.js';
import { nowMs } from './store-schema.js';
import type {
  KnowledgeScheduleRecord,
  KnowledgeScheduleUpsertInput,
} from './types.js';

export async function upsertKnowledgeSchedule(
  sqlite: SQLiteStore,
  schedules: Map<string, KnowledgeScheduleRecord>,
  input: KnowledgeScheduleUpsertInput,
  idFactory: () => string,
): Promise<KnowledgeScheduleRecord> {
  const existing = input.id ? schedules.get(input.id) : null;
  const now = nowMs();
  const record: KnowledgeScheduleRecord = {
    id: existing?.id ?? input.id ?? idFactory(),
    jobId: input.jobId,
    label: input.label.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    schedule: input.schedule,
    ...(typeof input.lastRunAt === 'number' ? { lastRunAt: input.lastRunAt } : existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(typeof input.nextRunAt === 'number' ? { nextRunAt: input.nextRunAt } : existing?.nextRunAt ? { nextRunAt: existing.nextRunAt } : {}),
    metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_schedules (
      id, job_id, label, enabled, schedule, last_run_at, next_run_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.jobId,
    record.label,
    record.enabled ? 1 : 0,
    JSON.stringify(record.schedule),
    record.lastRunAt ?? null,
    record.nextRunAt ?? null,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
  schedules.set(record.id, record);
  await sqlite.save();
  return record;
}

export async function deleteKnowledgeSchedule(
  sqlite: SQLiteStore,
  schedules: Map<string, KnowledgeScheduleRecord>,
  id: string,
): Promise<boolean> {
  const existing = schedules.get(id);
  if (!existing) return false;
  sqlite.run('DELETE FROM knowledge_schedules WHERE id = ?', [id]);
  schedules.delete(id);
  await sqlite.save();
  return true;
}
