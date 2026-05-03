import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../config/manager.js';
import { AutomationManager } from './manager.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRouteBinding } from './routes.js';
import type { AutomationRun } from './runs.js';
import type { AutomationSourceRecord } from './sources.js';
import type { LegacySchedulerMigrationResult, LegacySchedulerSnapshot } from './legacy-scheduler.js';
import { migrateLegacySchedules } from './legacy-scheduler.js';
import { AutomationJobStore } from './store/jobs.js';
import { AutomationRouteStore } from './store/routes.js';
import { AutomationRunStore } from './store/runs.js';
import { AutomationSourceStore } from './store/sources.js';

export interface AutomationServiceConfig {
  readonly configManager: ConfigManager;
  readonly jobs?: AutomationJobStore;
  readonly runs?: AutomationRunStore;
  readonly routes?: AutomationRouteStore;
  readonly sources?: AutomationSourceStore;
  readonly manager?: AutomationManager;
}

function sortJobs(jobs: Iterable<AutomationJob>): AutomationJob[] {
  return [...jobs].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

function sortRuns(runs: Iterable<AutomationRun>): AutomationRun[] {
  return [...runs].sort((a, b) => b.queuedAt - a.queuedAt);
}

function sortRoutes(routes: Iterable<AutomationRouteBinding>): AutomationRouteBinding[] {
  return [...routes].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
}

function sortSources(sources: Iterable<AutomationSourceRecord>): AutomationSourceRecord[] {
  return [...sources].sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt);
}

export class AutomationService {
  private readonly jobStore: AutomationJobStore;
  private readonly runStore: AutomationRunStore;
  private readonly routeStore: AutomationRouteStore;
  private readonly sourceStore: AutomationSourceStore;
  private readonly manager: AutomationManager;
  private readonly jobs = new Map<string, AutomationJob>();
  private readonly runs = new Map<string, AutomationRun>();
  private readonly routes = new Map<string, AutomationRouteBinding>();
  private readonly sources = new Map<string, AutomationSourceRecord>();
  private loaded = false;

  constructor(config: AutomationServiceConfig) {
    const configManager = config.configManager;
    this.jobStore = config.jobs ?? new AutomationJobStore({ configManager });
    this.runStore = config.runs ?? new AutomationRunStore({ configManager });
    this.routeStore = config.routes ?? new AutomationRouteStore({ configManager });
    this.sourceStore = config.sources ?? new AutomationSourceStore({ configManager });
    if (!config.manager) {
      throw new Error('AutomationService requires an explicit AutomationManager instance');
    }
    this.manager = config.manager;
  }

  async start(): Promise<void> {
    await this.manager.start();
  }

  stop(): void {
    this.manager.stop();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const [jobSnapshot, runSnapshot, routeSnapshot, sourceSnapshot] = await Promise.all([
      this.jobStore.load(),
      this.runStore.load(),
      this.routeStore.load(),
      this.sourceStore.load(),
    ]);
    this.jobs.clear();
    this.runs.clear();
    this.routes.clear();
    this.sources.clear();

    for (const job of jobSnapshot.jobs) this.jobs.set(job.id, job);
    for (const run of runSnapshot.runs) this.runs.set(run.id, run);
    for (const route of routeSnapshot.routes) this.routes.set(route.id, route);
    for (const source of sourceSnapshot.sources) this.sources.set(source.id, source);

    this.loaded = true;
  }

  async seedFromLegacyScheduler(snapshot: LegacySchedulerSnapshot): Promise<LegacySchedulerMigrationResult> {
    await this.load();
    if (this.jobs.size > 0 || this.runs.size > 0) {
      return { jobs: [], runs: [] };
    }

    const migrated = migrateLegacySchedules(snapshot);
    for (const job of migrated.jobs) {
      this.jobs.set(job.id, job);
      if (job.source) this.sources.set(job.source.id, job.source);
    }
    for (const run of migrated.runs) {
      this.runs.set(run.id, run);
      this.sources.set(run.triggeredBy.id, run.triggeredBy);
      if (run.route) this.routes.set(run.route.id, run.route);
    }

    await Promise.all([
      this.saveJobs(),
      this.saveRuns(),
      this.saveRoutes(),
      this.saveSources(),
    ]);

    return migrated;
  }

  listJobs(): AutomationJob[] {
    return sortJobs(this.jobs.values());
  }

  listRuns(jobId?: string): AutomationRun[] {
    const runs = jobId
      ? [...this.runs.values()].filter((run) => run.jobId === jobId)
      : this.runs.values();
    return sortRuns(runs);
  }

  listRoutes(): AutomationRouteBinding[] {
    return sortRoutes(this.routes.values());
  }

  listSources(): AutomationSourceRecord[] {
    return sortSources(this.sources.values());
  }

  getJob(jobId: string): AutomationJob | undefined {
    return this.jobs.get(jobId);
  }

  getRoute(routeId: string): AutomationRouteBinding | undefined {
    return this.routes.get(routeId);
  }

  getSource(sourceId: string): AutomationSourceRecord | undefined {
    return this.sources.get(sourceId);
  }

  async upsertJob(job: AutomationJob): Promise<AutomationJob> {
    await this.load();
    this.jobs.set(job.id, job);
    if (job.source) {
      this.sources.set(job.source.id, job.source);
    }
    await Promise.all([this.saveJobs(), this.saveSources()]);
    return job;
  }

  async upsertRun(run: AutomationRun): Promise<AutomationRun> {
    await this.load();
    this.runs.set(run.id, run);
    this.sources.set(run.triggeredBy.id, run.triggeredBy);
    if (run.route) {
      this.routes.set(run.route.id, run.route);
    }
    await Promise.all([this.saveRuns(), this.saveRoutes(), this.saveSources()]);
    return run;
  }

  async appendRun(run: Omit<AutomationRun, 'id'> & { readonly id?: string }): Promise<AutomationRun> {
    const timestamp = run.createdAt ?? Date.now();
    const persisted: AutomationRun = {
      ...run,
      id: run.id ?? `run-${randomUUID().slice(0, 8)}`,
      updatedAt: run.updatedAt ?? timestamp,
    };
    return await this.upsertRun(persisted);
  }

  async upsertRoute(route: AutomationRouteBinding): Promise<AutomationRouteBinding> {
    await this.load();
    this.routes.set(route.id, route);
    await this.saveRoutes();
    return route;
  }

  async upsertSource(source: AutomationSourceRecord): Promise<AutomationSourceRecord> {
    await this.load();
    this.sources.set(source.id, source);
    await this.saveSources();
    return source;
  }

  async removeJob(jobId: string): Promise<boolean> {
    await this.load();
    const removed = this.jobs.delete(jobId);
    if (!removed) return false;

    for (const [runId, run] of this.runs) {
      if (run.jobId === jobId) this.runs.delete(runId);
    }
    for (const [routeId, route] of this.routes) {
      if (route.jobId === jobId) this.routes.delete(routeId);
    }
    await Promise.all([this.saveJobs(), this.saveRuns(), this.saveRoutes()]);
    return true;
  }

  async removeRoute(routeId: string): Promise<boolean> {
    await this.load();
    const removed = this.routes.delete(routeId);
    if (!removed) return false;
    await this.saveRoutes();
    return true;
  }

  async removeSource(sourceId: string): Promise<boolean> {
    await this.load();
    const removed = this.sources.delete(sourceId);
    if (!removed) return false;
    await this.saveSources();
    return true;
  }

  private async saveJobs(): Promise<void> {
    await this.jobStore.save(sortJobs(this.jobs.values()));
  }

  private async saveRuns(): Promise<void> {
    await this.runStore.save(sortRuns(this.runs.values()));
  }

  private async saveRoutes(): Promise<void> {
    await this.routeStore.save(sortRoutes(this.routes.values()));
  }

  private async saveSources(): Promise<void> {
    await this.sourceStore.save(sortSources(this.sources.values()));
  }
}
