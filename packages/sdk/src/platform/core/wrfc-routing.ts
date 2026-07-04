import type { ToolResult } from '../types/tools.js';
import { isRecord } from '../utils/record-coerce.js';

export function isWrfcWorkflowRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!/\bwrfc\b/.test(normalized)) return false;
  if (/^(what|why|how|explain|describe|define)\b/.test(normalized)) return false;
  return /\bwrfc\b.{0,80}\b(review|agent|build|make|implement|fix|test|verify|for)\b/.test(normalized)
    || /\b(review|agent|build|make|implement|fix|test|verify)\b.{0,80}\bwrfc\b/.test(normalized);
}

/**
 * High-precision detector for an EXPLICIT user instruction not to delegate on this turn — do not
 * spawn agents, do not start a WRFC/owner chain, or do the work directly/yourself. When true, the
 * routing directive is suppressed entirely: the harness must never inject a "start a WRFC chain"
 * nudge against a user who explicitly forbade it.
 *
 * Deliberately conservative. Every pattern pairs an explicit negation (do not / don't / never /
 * no / without) with a delegation concept (spawn / agent(s) / delegate / wrfc / chain), or pairs a
 * direct-action verb with "yourself"/"directly". A plain "build X with WRFC" request contains no
 * such negation and is NOT treated as a prohibition. Precision over recall on purpose: a rare false
 * positive only drops an advisory suggestion (the safe direction — never coerce), whereas a false
 * negative would re-introduce the exact coercion this fixes.
 *
 * The documented pattern set:
 *   - "do not / don't / never spawn"                          → forbids spawning
 *   - "no agents" / "without agents" / "no sub-agents"         → forbids agents
 *   - "no delegation" / "do not / don't / never delegate"      → forbids delegation
 *   - "do not / don't / never start a wrfc|chain" / "no wrfc"  → forbids starting a chain
 *   - "do not / don't / never use the agent tool|agents"       → forbids the agent tool
 *   - "do|handle|implement|write|answer … yourself|directly"   → asks for direct, non-delegated work
 */
const DELEGATION_PROHIBITION_PATTERNS: readonly RegExp[] = [
  /\b(?:do not|don't|never) spawn\b/,
  /\bno (?:sub-?)?agents?\b/,
  /\bwithout (?:spawning )?(?:sub-?)?agents?\b/,
  /\bno delegation\b/,
  /\b(?:do not|don't|never) delegate\b/,
  /\b(?:do not|don't|never) start (?:a |an )?(?:new )?wrfc\b/,
  /\bno wrfc (?:chain|owner)\b/,
  /\b(?:do not|don't|never) start (?:a |an )?(?:new )?chain\b/,
  /\b(?:do not|don't|never) use (?:the )?agents?\b/,
  /\b(?:do not|don't|never) use the agent tool\b/,
  /\b(?:do|handle|implement|write|answer)(?: it| this)?(?: the \w+)? (?:yourself|directly)\b/,
];

export function userProhibitsDelegation(text: string): boolean {
  // Normalize curly apostrophes and whitespace so "don't"/"don’t"/"do  not" all match one pattern.
  const normalized = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  return DELEGATION_PROHIBITION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function buildWrfcWorkflowRoutingPrompt(text: string): string | null {
  if (!isWrfcWorkflowRequest(text)) return null;
  // The user's explicit intent for THIS turn wins over routing: if they forbade delegation, inject
  // nothing at all rather than nudging them toward a chain they told us not to start.
  if (userProhibitsDelegation(text)) return null;
  // Advisory, not imperative: suggest the pipeline and, if chosen, how to enter it, while asserting
  // that the user's explicit instructions always win. mode=spawn/template/reviewMode are retained
  // as the how-to for when the model does choose the pipeline.
  return '[WRFC routing] This looks like work the WRFC pipeline handles well. If you choose to use it, '
    + 'start exactly one WRFC owner chain via the agent tool (mode=spawn, template=engineer, reviewMode=wrfc) '
    + 'rather than spawning reviewer/tester/verifier roots directly. This is a suggestion, not a command — '
    + "the user's explicit instructions always win; if they asked you to do the work yourself or not to "
    + 'delegate, do that instead.';
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
