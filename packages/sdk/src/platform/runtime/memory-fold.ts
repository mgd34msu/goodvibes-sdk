import { join } from 'node:path';
import {
  foldMemoryStores,
  formatMemoryFoldReport,
  type LegacyMemorySource,
  type MemoryEmbeddingProviderRegistry,
  type MemoryFoldReport,
  type MemoryStore,
} from '../state/index.js';

/**
 * Fold a workspace's legacy per-project memory store into the canonical
 * cross-surface store.
 *
 * The legacy path is `.goodvibes/tui/memory.sqlite` and stays spelled that way:
 * it is where those records were actually written before memory was unified, so
 * it is a fact about existing disks rather than a scope this function chooses.
 *
 * Called once at boot AFTER `memoryStore.init()` so records written before
 * unification survive. Id-keyed and idempotent, a re-run imports nothing new
 * and never deletes the legacy file. Returns the report so boot can log what
 * moved.
 */
export async function foldLegacyProjectMemory(
  memoryStore: MemoryStore,
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry,
  workingDirectory: string,
): Promise<MemoryFoldReport> {
  const legacyProjectStore = join(workingDirectory, '.goodvibes', 'tui', 'memory.sqlite');
  const sources: LegacyMemorySource[] = [
    { label: `${workingDirectory} (legacy per-project store)`, dbPath: legacyProjectStore },
  ];
  return foldMemoryStores(memoryStore, sources, { embeddingRegistry: memoryEmbeddingRegistry });
}

/** A minimal boot logger seam (matches the platform logger's info/warn shape). */
export interface BootFoldLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

/**
 * Run the legacy memory fold at boot and surface the report. Never blocks or
 * fails boot: a fold error degrades to a warn and the canonical store serves on.
 * Only logs the report when something actually moved (or a source failed), so a
 * clean boot stays quiet.
 */
export async function runBootMemoryFold(
  memoryStore: MemoryStore,
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry,
  workingDirectory: string,
  log: BootFoldLogger,
): Promise<void> {
  try {
    const report = await foldLegacyProjectMemory(memoryStore, memoryEmbeddingRegistry, workingDirectory);
    if (report.totalImported > 0 || report.failedSources.length > 0) {
      log.info(`[bootstrap] memory fold: ${formatMemoryFoldReport(report)}`);
    }
  } catch (err) {
    log.warn('memory fold at bootstrap failed (non-fatal; canonical store unaffected)', { err });
  }
}
