import type { ToolResult } from '../types/tools.js';

export function isWrfcWorkflowRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!/\bwrfc\b/.test(normalized)) return false;
  if (/^(what|why|how|explain|describe|define)\b/.test(normalized)) return false;
  return /\bwrfc\b.{0,80}\b(review|agent|build|make|implement|fix|test|verify|for)\b/.test(normalized)
    || /\b(review|agent|build|make|implement|fix|test|verify)\b.{0,80}\bwrfc\b/.test(normalized);
}

export function buildWrfcWorkflowRoutingPrompt(text: string): string | null {
  if (!isWrfcWorkflowRequest(text)) return null;
  return '[WRFC routing] The user is asking for WRFC-owned work. Use the agent tool to start exactly one WRFC owner chain with mode=spawn, template=engineer, reviewMode=wrfc. Do not answer by describing WRFC, and do not spawn reviewer/tester/verifier roots.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolOutput(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordIsAuthoritativeWrfcOwner(record: Record<string, unknown>): boolean {
  if (record.orchestrationStopSignal === 'wrfc_owner_chain_started') return true;
  if (record.authoritativeWrfcChain === true && record.continueRootSpawning === false) return true;
  return record.wrfcRole === 'owner'
    && typeof record.wrfcId === 'string'
    && record.wrfcId.length > 0
    && record.continueRootSpawning === false;
}

export function toolResultIndicatesAuthoritativeWrfcChain(result: ToolResult): boolean {
  if (!result.success) return false;
  const payload = parseToolOutput(result.output);
  if (!payload) return false;
  if (recordIsAuthoritativeWrfcOwner(payload)) return true;
  const agents = payload.agents;
  if (!Array.isArray(agents)) return false;
  return agents.some((agent) => isRecord(agent) && recordIsAuthoritativeWrfcOwner(agent));
}
