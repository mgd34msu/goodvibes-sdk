import { resolveKnowledgeDbPathFromControlPlaneDir } from './store-schema.js';

export interface KnowledgeStoreConfig {
  readonly dbPath?: string | undefined;
  readonly configManager?: {
    getControlPlaneConfigDir?: (() => string) | undefined;
  };
}

export function resolveKnowledgeDbPath(config: KnowledgeStoreConfig): string {
  const controlPlaneDir = typeof config.configManager?.getControlPlaneConfigDir === 'function'
    ? config.configManager.getControlPlaneConfigDir()
    : undefined;
  const dbPath = config.dbPath ?? (controlPlaneDir ? resolveKnowledgeDbPathFromControlPlaneDir(controlPlaneDir) : undefined);
  if (!dbPath) throw new Error('KnowledgeStore requires an explicit dbPath or configManager.getControlPlaneConfigDir().');
  return dbPath;
}
