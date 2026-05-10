import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';

export interface WorkmapEntry {
  ts: string;
  wrfcId: string;
  event: 'engineer_complete' | 'integrator_complete' | 'review_complete' | 'fix_started' | 'gate_result' | 'chain_passed' | 'chain_failed' | 'owner_decision';
  agentId?: string | undefined;
  role?: string | undefined;
  subtaskId?: string | undefined;
  task?: string;        // original task (on first engineer_complete only)
  score?: number;       // review score
  passed?: boolean;     // review passed or gate passed
  issues?: Array<{ severity: string; description: string; file?: string | undefined }>;  // review issues (truncated)
  gate?: string;        // gate name
  gateOutput?: string;  // gate output (truncated to 200 chars)
  attempt?: number;     // fix attempt number
  reason?: string;      // failure reason
  action?: string;      // owner decision action
  state?: string;       // chain state at decision time
  model?: string | undefined;
  provider?: string | undefined;
  reasoningEffort?: string | undefined;
}

export class WrfcWorkmap {
  private filePath: string;

  constructor(projectRoot: string, sessionId: string, options?: { readonly surfaceRoot?: string | undefined; readonly sessionsDir?: string | undefined }) {
    const sessionsDir = options?.sessionsDir ?? resolveScopedDirectory(projectRoot, options?.surfaceRoot, 'sessions');
    this.filePath = join(sessionsDir, `${sessionId}_workmap.jsonl`);
  }

  private dirCreated = false;

  append(entry: WorkmapEntry): void {
    try {
      if (!this.dirCreated) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.dirCreated = true;
      }
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.warn('WrfcWorkmap: append failed', { error: summarizeError(err) });
    }
  }

  /** Read all entries, optionally filtered by wrfcId */
  read(wrfcId?: string): WorkmapEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const entries = lines.map(line => {
        try {
          return JSON.parse(line) as WorkmapEntry;
        } catch (error) {
          logger.warn('WrfcWorkmap: malformed JSONL line skipped', { error: summarizeError(error) });
          return null;
        }
      }).filter((e): e is WorkmapEntry => e !== null);
      if (wrfcId) return entries.filter(e => e.wrfcId === wrfcId);
      return entries;
    } catch (error) {
      logger.warn('WrfcWorkmap: read failed', { error: summarizeError(error) });
      return [];
    }
  }

  /** Get all unique WRFC chain IDs with their latest status */
  listChains(): Array<{ wrfcId: string; task?: string; status: string; lastScore?: number; events: number }> {
    const entries = this.read();
    const chains = new Map<string, { task?: string; status: string; lastScore?: number; events: number }>();
    for (const e of entries) {
      const existing = chains.get(e.wrfcId) ?? { status: 'active', events: 0 };
      existing.events++;
      if (e.task) existing.task = e.task;
      if (e.score !== undefined) existing.lastScore = e.score;
      if (e.event === 'chain_passed') existing.status = 'passed';
      if (e.event === 'chain_failed') existing.status = 'failed';
      chains.set(e.wrfcId, existing);
    }
    return Array.from(chains.entries()).map(([wrfcId, data]) => ({ wrfcId, ...data }));
  }

  /** Static: find the most recent workmap file in sessions dir */
  static findLatest(sessionsDir: string): string | null {
    const dir = sessionsDir;
    if (!existsSync(dir)) return null;
    try {
      const files = readdirSync(dir)
        .filter((f: string) => f.endsWith('_workmap.jsonl'))
        .map((f: string) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
      return files.length > 0 ? join(dir, files[0]?.name ?? '') : null;
    } catch (error) {
      logger.warn('WrfcWorkmap: latest file discovery failed', { error: summarizeError(error) });
      return null;
    }
  }
}
