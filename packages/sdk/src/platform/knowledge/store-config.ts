import {
  DEFAULT_KNOWLEDGE_DB_FILE,
  resolveKnowledgeDbPathFromControlPlaneDir,
} from './store-schema.js';

export const REGULAR_KNOWLEDGE_DB_FILE = DEFAULT_KNOWLEDGE_DB_FILE;
export const HOME_GRAPH_KNOWLEDGE_DB_FILE = 'knowledge-home-graph.sqlite';

export interface KnowledgeStoreConfig {
  readonly dbPath?: string | undefined;
  readonly dbFileName?: string | undefined;
  readonly configManager?: {
    getControlPlaneConfigDir?: (() => string) | undefined;
  };
}

export function resolveKnowledgeDbPath(config: KnowledgeStoreConfig): string {
  const controlPlaneDir = typeof config.configManager?.getControlPlaneConfigDir === 'function'
    ? config.configManager.getControlPlaneConfigDir()
    : undefined;
  const dbPath = config.dbPath ?? (controlPlaneDir
    ? resolveKnowledgeDbPathFromControlPlaneDir(controlPlaneDir, config.dbFileName)
    : undefined);
  if (!dbPath) throw new Error('KnowledgeStore requires an explicit dbPath or configManager.getControlPlaneConfigDir().');
  return dbPath;
}
