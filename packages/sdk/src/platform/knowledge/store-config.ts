import { basename } from 'node:path';
import {
  DEFAULT_KNOWLEDGE_DB_FILE,
  resolveKnowledgeDbPathFromControlPlaneDir,
} from './store-schema.js';

export const REGULAR_KNOWLEDGE_DB_FILE = DEFAULT_KNOWLEDGE_DB_FILE;
export const HOME_GRAPH_KNOWLEDGE_DB_FILE = 'knowledge-home-graph.sqlite';
export const GOODVIBES_AGENT_KNOWLEDGE_DB_FILE = 'knowledge-agent.sqlite';

/**
 * The three physically separate knowledge families. There is one KnowledgeStore
 * class and one schema; the wall between the general wiki, the home-graph, and the
 * agent personal-ops knowledge is held by construction — separate SQLite files
 * opened by separate store instances. When a caller declares which family it is
 * constructing, the store asserts the resolved file name matches that family so a
 * mis-wired construction site fails loudly instead of silently sharing a file.
 */
export type KnowledgeStoreFamily = 'wiki' | 'home-graph' | 'agent';

export const KNOWLEDGE_FAMILY_DB_FILE: Readonly<Record<KnowledgeStoreFamily, string>> = Object.freeze({
  wiki: REGULAR_KNOWLEDGE_DB_FILE,
  'home-graph': HOME_GRAPH_KNOWLEDGE_DB_FILE,
  agent: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
});

export interface KnowledgeStoreConfig {
  readonly dbPath?: string | undefined;
  readonly dbFileName?: string | undefined;
  /**
   * The knowledge family this store belongs to. When provided, the resolved db
   * file name must match {@link KNOWLEDGE_FAMILY_DB_FILE} for that family, or
   * construction throws — the cheap guard that turns a silent cross-family
   * mis-wire into a loud failure.
   */
  readonly family?: KnowledgeStoreFamily | undefined;
  /**
   * Auto-accept confidence threshold for the node review gate. A synthesized node
   * whose confidence is at or above this value is activated with honest
   * 'auto-accepted' provenance; below it, the node is held as 'draft'
   * (pending review) and is not served by search/ask until reviewed. Defaults to
   * {@link DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE}.
   */
  readonly nodeAutoAcceptConfidence?: number | undefined;
  readonly configManager?: {
    getControlPlaneConfigDir?: (() => string) | undefined;
  };
}

/**
 * Default auto-accept threshold. Chosen just below the lowest confidence the
 * existing synthesis producers emit (deterministic facts at 45, deterministic
 * wiki pages at 55) so those flows keep activating — now with honest,
 * numeric provenance rather than silently — while genuinely low-confidence
 * synthesized content (below 40) is held as 'draft' for review. The mechanism is
 * the deliverable; consumers raise this threshold to hold more for review.
 */
export const DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE = 40;

export function resolveKnowledgeDbPath(config: KnowledgeStoreConfig): string {
  const controlPlaneDir = typeof config.configManager?.getControlPlaneConfigDir === 'function'
    ? config.configManager.getControlPlaneConfigDir()
    : undefined;
  const dbPath = config.dbPath ?? (controlPlaneDir
    ? resolveKnowledgeDbPathFromControlPlaneDir(controlPlaneDir, config.dbFileName)
    : undefined);
  if (!dbPath) throw new Error('KnowledgeStore requires an explicit dbPath or configManager.getControlPlaneConfigDir().');
  if (config.family) {
    const expected = KNOWLEDGE_FAMILY_DB_FILE[config.family];
    const actual = basename(dbPath);
    if (actual !== expected) {
      throw new Error(
        `KnowledgeStore family mismatch: constructed for '${config.family}' (expected file '${expected}') but resolved db file is '${actual}'. `
        + 'This guards the wall between the wiki, home-graph, and agent knowledge families — the construction site is wired to the wrong file.',
      );
    }
  }
  return dbPath;
}
