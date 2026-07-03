import type { ConfigManager } from '../config/manager.js';
import type { AgentManager } from '../tools/agent/index.js';

export type AgentManagerLike = Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'listByCohort' | 'clear'>;
export type WrfcCommitScope = 'off' | 'scoped' | 'all';

const WRFC_COMMIT_SCOPES: readonly WrfcCommitScope[] = ['off', 'scoped', 'all'];

function isWrfcCommitScope(value: unknown): value is WrfcCommitScope {
  return typeof value === 'string' && (WRFC_COMMIT_SCOPES as readonly string[]).includes(value);
}

export type WrfcConfigLike = {
  scoreThreshold: number;
  maxFixAttempts: number;
  autoCommit: boolean;
  /**
   * Scope of files staged on WRFC auto-commit:
   * - 'off': never commit on gate pass.
   * - 'scoped' (default): stage only the paths the chain's own completion reports claim
   *   to have touched (see collectChainTouchedPaths in wrfc-controller.ts).
   * - 'all': legacy full-tree `git add -A` sweep.
   */
  commitScope: WrfcCommitScope;
  gates: Array<{ name: string; command: string; enabled: boolean }>;
  /**
   * How long (in ms) to wait for an agent event before treating a running agent
   * as hung/silent and failing the chain. Default: 0 (disabled).
   */
  agentHeartbeatTimeoutMs: number;
};

export type WrfcConfigReader = Pick<ConfigManager, 'get' | 'getCategory'>;

export function readWrfcConfig(configManager: WrfcConfigReader): WrfcConfigLike {
  const wrfcConfig = configManager.getCategory('wrfc') as Partial<WrfcConfigLike> | undefined;
  // Number.isFinite (not typeof === 'number') so a NaN/Infinity config value is
  // rejected rather than poisoning the numeric bounds: a NaN maxFixAttempts makes
  // `fixAttempts >= maxFixAttempts` always false, so the fix loop never terminates.
  const rawScore = configManager.get('wrfc.scoreThreshold');
  const rawMax = configManager.get('wrfc.maxFixAttempts');
  const rawHeartbeat = configManager.get('wrfc.agentHeartbeatTimeoutMs');
  return {
    scoreThreshold: Number.isFinite(rawScore)
      ? (rawScore as number)
      : Number.isFinite(wrfcConfig?.scoreThreshold) ? (wrfcConfig?.scoreThreshold as number) : 9.9,
    maxFixAttempts: Number.isFinite(rawMax)
      ? (rawMax as number)
      : Number.isFinite(wrfcConfig?.maxFixAttempts) ? (wrfcConfig?.maxFixAttempts as number) : 5,
    autoCommit:
      typeof configManager.get('wrfc.autoCommit') === 'boolean'
        ? (configManager.get('wrfc.autoCommit') as boolean)
        : wrfcConfig?.autoCommit ?? false,
    commitScope: isWrfcCommitScope(configManager.get('wrfc.commitScope'))
      ? (configManager.get('wrfc.commitScope') as WrfcCommitScope)
      : isWrfcCommitScope(wrfcConfig?.commitScope) ? wrfcConfig!.commitScope : 'scoped',
    gates: Array.isArray(wrfcConfig?.gates) ? wrfcConfig.gates : [],
    agentHeartbeatTimeoutMs: Number.isFinite(rawHeartbeat)
      ? (rawHeartbeat as number)
      : Number.isFinite(wrfcConfig?.agentHeartbeatTimeoutMs) ? (wrfcConfig?.agentHeartbeatTimeoutMs as number) : 0,
  };
}

export function getWrfcAgentHeartbeatTimeoutMs(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).agentHeartbeatTimeoutMs ?? 0;
}

export function getWrfcScoreThreshold(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).scoreThreshold ?? 9.9;
}

export function getWrfcMaxFixAttempts(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).maxFixAttempts ?? 5;
}

export function getWrfcAutoCommit(configManager: WrfcConfigReader): boolean {
  return readWrfcConfig(configManager).autoCommit ?? false;
}

export function getWrfcCommitScope(configManager: WrfcConfigReader): WrfcCommitScope {
  return readWrfcConfig(configManager).commitScope ?? 'scoped';
}

export function getEnabledWrfcGates(configManager: WrfcConfigReader): WrfcConfigLike['gates'] {
  return readWrfcConfig(configManager).gates.filter((gate) => gate.enabled);
}
