/**
 * compaction-sections.ts
 *
 * Section builder functions for prompt compaction.
 *
 * Rule-based builders return CompactionSection | null directly.
 * LLM-assisted builders return a string prompt to be sent to the LLM by the
 * orchestrator; the caller assembles the section from the LLM response.
 *
 * Empty sections return null — the orchestrator omits them entirely (no header).
 */

import type { ProviderMessage, ContentPart } from '../providers/interface.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { isActiveAgent } from '../tools/agent/predicates.js';
import type { WrfcChain } from '../agents/wrfc-types.js';
import type { ExecutionPlan, PlanItem } from './execution-plan.js';
import type { CompactionSection, CompactionConfig, SessionMemory } from './compaction-types.js';
import { estimateTokens, IMAGE_TOKEN_ESTIMATE } from './compaction-types.js';
import { parseCompletionReport, type EngineerReport } from '../agents/completion-report.js';

/** Extract plain text from a ProviderMessage content field. */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return (content as ContentPart[])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Count image content parts in a ProviderMessage content field. */
function countImageParts(content: string | ContentPart[]): number {
  if (typeof content === 'string') return 0;
  return (content as ContentPart[]).filter((p) => p.type === 'image').length;
}


/** Build a CompactionSection. Returns null if content is empty. */
function makeSection(
  id: string,
  header: string,
  content: string,
): CompactionSection | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    id,
    header,
    content: trimmed,
    tokens: estimateTokens(header + '\n' + trimmed),
  };
}

// ---------------------------------------------------------------------------
// Handoff header
// ---------------------------------------------------------------------------

/**
 * buildHandoffHeader — always returns the mandatory handoff header.
 * This is the first line of every compacted output.
 */
export function buildHandoffHeader(): CompactionSection {
  const content =
    'IMPORTANT: This session is not new! Context was compacted, please read the following for proper handoff so you may resume work!';
  return {
    id: 'handoff-header',
    header: '',
    content,
    tokens: estimateTokens(content),
  };
}

// ---------------------------------------------------------------------------
// Re-injected standing instructions
// ---------------------------------------------------------------------------

/**
 * Sentinel markers wrapping the re-injected instruction block. They let a
 * later compaction pass strip a prior re-injected block out of the message
 * history before it is summarized again, so the instructions appear exactly
 * once no matter how many times compaction runs.
 */
export const REINJECT_INSTRUCTIONS_START = '<!-- goodvibes:reinjected-instructions:start -->';
export const REINJECT_INSTRUCTIONS_END = '<!-- goodvibes:reinjected-instructions:end -->';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const REINJECT_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(REINJECT_INSTRUCTIONS_START)}[\\s\\S]*?${escapeRegExp(REINJECT_INSTRUCTIONS_END)}\\n*`,
  'g',
);

/**
 * Remove any previously re-injected instruction block(s) from a piece of text.
 * Used to keep repeated compactions from stacking duplicate instruction copies.
 */
export function stripReinjectedInstructions(text: string): string {
  if (!text.includes(REINJECT_INSTRUCTIONS_START)) return text;
  return text.replace(REINJECT_BLOCK_PATTERN, '').trimEnd();
}

/**
 * buildReinjectedInstructions — re-includes the standing system instruction
 * chain and the frontmatter of any active skill at the compaction boundary so
 * compaction never silently strips them. Returns null when neither is present.
 *
 * The block is wrapped in sentinel markers ({@link REINJECT_INSTRUCTIONS_START}
 * / {@link REINJECT_INSTRUCTIONS_END}) so a subsequent compaction can strip the
 * prior copy before re-adding a fresh one (no duplication across passes).
 */
export function buildReinjectedInstructions(
  instructionChain: string | undefined,
  activeSkillFrontmatter: string | undefined,
): CompactionSection | null {
  const chain = instructionChain?.trim() ?? '';
  const skill = activeSkillFrontmatter?.trim() ?? '';
  if (!chain && !skill) return null;

  const parts: string[] = [REINJECT_INSTRUCTIONS_START];
  if (chain) {
    parts.push('### System Instructions');
    parts.push(chain);
  }
  if (skill) {
    parts.push('### Active Skill');
    parts.push(skill);
  }
  parts.push(REINJECT_INSTRUCTIONS_END);
  const content = parts.join('\n');

  return {
    id: 'reinjected-instructions',
    header: '## Standing Instructions (re-injected)',
    content,
    tokens: estimateTokens('## Standing Instructions (re-injected)\n' + content),
  };
}

// ---------------------------------------------------------------------------
// Session memories
// ---------------------------------------------------------------------------

/**
 * buildSessionMemories — format pinned memories.
 * Returns null if there are no memories.
 */
export function buildSessionMemories(
  memories: SessionMemory[],
): CompactionSection | null {
  if (memories.length === 0) return null;
  const lines = memories.map((m) => `- [${m.id}] ${m.text}`);
  return makeSection(
    'session-memories',
    '## Session Memories (pinned)',
    lines.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Current task
// ---------------------------------------------------------------------------

/**
 * buildCurrentTask — one line stating what the user is currently doing.
 * Uses plan title if a plan exists, otherwise falls back to the last user message.
 */
export function buildCurrentTask(
  planTitle: string | null,
  lastUserMessage: string | null,
): CompactionSection | null {
  const task =
    planTitle ??
    (lastUserMessage ? lastUserMessage.slice(0, 200).trim() : null);
  if (!task) return null;
  return makeSection('current-task', '## Current Task', task);
}

// ---------------------------------------------------------------------------
// Running agents
// ---------------------------------------------------------------------------

/**
 * buildRunningAgents — list agents in running or pending status.
 * Includes WRFC chain ID, agent ID, and task (truncated to 80 chars).
 * Returns null if no agents are running.
 */
export function buildRunningAgents(
  agents: AgentRecord[],
  chains: WrfcChain[],
): CompactionSection | null {
  const active = agents.filter(isActiveAgent);
  if (active.length === 0) return null;

  // Build a map from agent ID to chain ID for quick lookup
  const agentToChain = new Map<string, string>();
  for (const chain of chains) {
    for (const agentId of chain.allAgentIds) {
      agentToChain.set(agentId, chain.id);
    }
  }

  const lines = active.map((a) => {
    const chainId = a.wrfcId ?? agentToChain.get(a.id) ?? 'no-chain';
    const task = a.task.slice(0, 80).replace(/\n/g, ' ');
    return `- ${chainId} | ${a.id} | ${task}`;
  });

  return makeSection('running-agents', '## Currently Running', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Completed agent work
// ---------------------------------------------------------------------------

/**
 * buildCompletedAgentWork — list standalone (non-WRFC) agents that finished
 * (completed or failed) this session, with a best-effort files-touched summary.
 * Agents that belong to a WRFC chain are excluded — they are already
 * summarized per-chain by buildAgentActivityTable, and listing them again
 * here would double-report the same work.
 */
export function buildCompletedAgentWork(
  agents: AgentRecord[],
  chains: WrfcChain[],
): CompactionSection | null {
  const chainAgentIds = new Set<string>();
  for (const chain of chains) {
    for (const id of chain.allAgentIds) chainAgentIds.add(id);
  }
  const finished = agents.filter(
    (a) =>
      (a.status === 'completed' || a.status === 'failed') &&
      !a.wrfcId &&
      !chainAgentIds.has(a.id),
  );
  if (finished.length === 0) return null;

  const lines = finished.map((a) => {
    const task = a.task.slice(0, 80).replace(/\n/g, ' ');
    const outcome = a.status === 'completed' ? 'DONE' : 'FAILED';
    const toolNote = `${a.toolCallCount} tool call${a.toolCallCount === 1 ? '' : 's'}`;
    const files = describeAgentFiles(a);
    return `- [${outcome}] ${a.id} | ${task} | ${toolNote}${files ? ` | ${files}` : ''}`;
  });

  return makeSection('completed-agent-work', '## Completed Agent Work', lines.join('\n'));
}

/**
 * Best-effort files-touched summary for a plain (non-WRFC) agent, parsed
 * opportunistically from its raw output. Returns null if no structured
 * completion report was found or it reported no file paths — this is a
 * best-effort signal, not a guarantee (plain agents are not required to
 * emit a completion report the way WRFC engineers are).
 */
function describeAgentFiles(agent: AgentRecord): string | null {
  if (!agent.fullOutput) return null;
  const report = parseCompletionReport(agent.fullOutput);
  if (!report || report.archetype !== 'engineer') return null;
  const engineerReport = report as EngineerReport;
  const paths = [
    ...engineerReport.filesCreated,
    ...engineerReport.filesModified,
    ...engineerReport.filesDeleted,
  ];
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 5).join(', ');
  return `files: ${shown}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`;
}

// ---------------------------------------------------------------------------
// Recent conversation gather
// ---------------------------------------------------------------------------

/**
 * gatherRecentConversation — collect user/assistant messages backward from most
 * recent, stopping when adding the next message would exceed maxTokens.
 * Returns full messages only (no partial messages).
 *
 * The returned messages are raw — they will be further filtered by the LLM
 * substance filter in the orchestrator.
 */
export function gatherRecentConversation(
  messages: ProviderMessage[],
  maxTokens = 3000,
): ProviderMessage[] {
  const eligible = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );

  const gathered: ProviderMessage[] = [];
  let tokenCount = 0;

  // Work backward from most recent
  for (let i = eligible.length - 1; i >= 0; i--) {
    const msg = eligible[i]!;
    // Account for image parts separately: extractText drops them, but they carry
    // real provider token cost (mirror IMAGE_TOKEN_ESTIMATE in estimateConversationTokens).
    const msgTokens =
      estimateTokens(extractText(msg.content)) +
      countImageParts(msg.content) * IMAGE_TOKEN_ESTIMATE;
    if (tokenCount + msgTokens > maxTokens) break;
    gathered.unshift(msg);
    tokenCount += msgTokens;
  }

  return gathered;
}

// ---------------------------------------------------------------------------
// LLM substance filter prompt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared delimited-message prompt scaffold
// ---------------------------------------------------------------------------

function buildDelimitedMessagePrompt(opts: {
  intro: string[];
  delimiter: string;
  messages: ProviderMessage[];
  render: (msg: ProviderMessage) => string | null;
  outro: string;
}): string {
  if (opts.messages.length === 0) return '';
  const parts: string[] = [
    ...opts.intro,
    '',
    `--- ${opts.delimiter} ---`,
    '',
  ];
  for (const msg of opts.messages) {
    const line = opts.render(msg);
    if (line != null) {
      parts.push(line);
      parts.push('');
    }
  }
  parts.push(`--- END ${opts.delimiter} ---`);
  parts.push('');
  parts.push(opts.outro);
  return parts.join('\n');
}

/**
 * buildToolResultsPrompt — build the prompt for LLM-assisted tool relevance extraction.
 *
 * The caller sends this to the LLM and uses the response as the section content.
 */
export function buildToolResultsPrompt(toolMessages: ProviderMessage[]): string {
  return buildDelimitedMessagePrompt({
    intro: [
      'From these tool call results, select the ones that are still relevant for ongoing work.',
      'Include: file paths touched with what was done (created/edited/deleted), any error outputs',
      'that have not been resolved, any build/test results.',
      'Max 1,500 tokens. Use relative paths and short descriptions.',
    ],
    delimiter: 'TOOL RESULTS',
    messages: toolMessages,
    render: (msg) => {
      const text = extractText(msg.content);
      return text.trim() ? `[tool]: ${text.trim().slice(0, 2000)}` : null;
    },
    outro: 'Provide a concise summary of relevant tool results now:',
  });
}

// ---------------------------------------------------------------------------
// Recent conversation substance filter prompt
// ---------------------------------------------------------------------------

/**
 * buildConversationFilterPrompt — build the LLM prompt for filtering gathered
 * recent messages for substance.
 *
 * The caller sends this to the LLM; the response replaces the raw gathered messages.
 * Multi-turn coherence rule: keep user-assistant PAIRS.
 */
export function buildConversationFilterPrompt(
  gatheredMessages: ProviderMessage[],
): string {
  return buildDelimitedMessagePrompt({
    intro: [
      'From these recent messages, remove anything that does not advance the work:',
      'short acknowledgments, agent count updates, repetitive system nudges, status confirmations.',
      'Keep: instructions, planning, decisions, task assignments, requirement changes.',
      'ALL user messages are high-priority — bias toward keeping them even if short.',
      'Keep user-assistant pairs together: if you keep an assistant message, keep the user message that prompted it.',
      'Return only the messages worth preserving, in original order.',
    ],
    delimiter: 'RECENT MESSAGES',
    messages: gatheredMessages,
    render: (msg) => {
      const text = extractText(msg.content);
      return text.trim() ? `[${msg.role}]: ${text.trim()}` : null;
    },
    outro: 'Return the filtered messages in the same [role]: content format:',
  });
}

// ---------------------------------------------------------------------------
// Agent activity table
// ---------------------------------------------------------------------------

/**
 * buildAgentActivityTable — rule-based table from WRFC chain data.
 * One row per chain, most recent first. Skips intermediate reviews/fix cycles.
 * Stops when adding the next row would exceed the token budget.
 *
 * Returns:
 *   - section: the table section (or null if no chains)
 *   - remainingChains: chains that did not fit in the table (for older summary)
 */
export function buildAgentActivityTable(
  chains: WrfcChain[],
  tokenBudget: number,
): { section: CompactionSection | null; remainingChains: WrfcChain[] } {
  if (chains.length === 0) {
    return { section: null, remainingChains: [] };
  }

  // Sort most recent first
  const sorted = [...chains].sort((a, b) => b.createdAt - a.createdAt);

  const header = '## Agent Activity';
  const tableHeader =
    '| Chain | Task | Scores | Result | Files |\n|-------|------|--------|--------|-------|';
  const rows: string[] = [];
  const included: WrfcChain[] = [];
  const remaining: WrfcChain[] = [];

  let tokensSoFar = estimateTokens(header + '\n' + tableHeader);

  for (const chain of sorted) {
    const task = chain.task.slice(0, 60).replace(/\n/g, ' ');
    const scores =
      chain.reviewScores.length > 0
        ? chain.reviewScores.map((s) => s.toFixed(1)).join(' → ')
        : '—';
    const result = terminalResult(chain.state);
    const files = describeChainFiles(chain);
    const row = `| ${chain.id.slice(0, 12)} | ${task} | ${scores} | ${result} | ${files} |`;
    const rowTokens = estimateTokens(row + '\n');

    if (tokensSoFar + rowTokens > tokenBudget) {
      remaining.push(chain);
      // All further chains also go to remaining
      const idx = sorted.indexOf(chain);
      remaining.push(...sorted.slice(idx + 1));
      break;
    }

    rows.push(row);
    tokensSoFar += rowTokens;
    included.push(chain);
  }

  if (rows.length === 0) {
    return { section: null, remainingChains: sorted };
  }

  const content = tableHeader + '\n' + rows.join('\n');
  const section = makeSection('agent-activity', header, content);
  return { section, remainingChains: remaining };
}

/**
 * Compact "N files" summary for a chain's touched-paths ledger, or '—' when
 * absent/empty. Degrades gracefully for legacy chains persisted before
 * `touchedPaths` existed (undefined) — this is a cosmetic display gap, not
 * a correctness concern; see `WrfcController.collectChainTouchedPaths()` for
 * the fuller fallback-from-reports reconstruction used by auto-commit.
 */
function describeChainFiles(chain: WrfcChain): string {
  const paths = chain.touchedPaths ?? [];
  if (paths.length === 0) return '—';
  return `${paths.length} file${paths.length === 1 ? '' : 's'}`;
}

/** Map WRFC chain state to display result. */
function terminalResult(state: WrfcChain['state']): string {
  switch (state) {
    case 'passed': return 'PASSED';
    case 'failed': return 'FAILED';
    case 'committing': return 'IN_PROGRESS';
    case 'gating': return 'IN_PROGRESS';
    case 'awaiting_gates': return 'IN_PROGRESS';
    case 'reviewing': return 'IN_PROGRESS';
    case 'fixing': return 'IN_PROGRESS';
    case 'engineering': return 'IN_PROGRESS';
    case 'pending': return 'IN_PROGRESS';
    default: return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Older agent summary prompt (LLM-assisted)
// ---------------------------------------------------------------------------

/**
 * buildOlderAgentSummaryPrompt — build the prompt for LLM-assisted summary of
 * agents that did not fit in the activity table.
 *
 * Returns empty string if no older chains.
 */
export function buildOlderAgentSummaryPrompt(olderChains: WrfcChain[]): string {
  if (olderChains.length === 0) return '';

  const parts: string[] = [
    'Summarize what these agents accomplished in aggregate.',
    'Focus on outcomes: what was built, fixed, reviewed. Max 500 tokens.',
    '',
    '--- OLDER AGENTS ---',
    '',
  ];

  for (const chain of olderChains) {
    const task = chain.task.slice(0, 200).replace(/\n/g, ' ');
    const scores =
      chain.reviewScores.length > 0
        ? chain.reviewScores.map((s) => s.toFixed(1)).join(' → ')
        : 'no scores';
    const result = terminalResult(chain.state);
    parts.push(`- [${result}] ${task} (scores: ${scores})`);
  }

  parts.push('');
  parts.push('--- END OLDER AGENTS ---');
  parts.push('');
  parts.push('Provide aggregate summary now:');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Resolved problems prompt (LLM-assisted)
// ---------------------------------------------------------------------------

/**
 * buildResolvedProblemsPrompt — build the prompt for LLM-assisted extraction
 * of problem → resolution pairs from the conversation.
 *
 * Returns empty string if no messages.
 */
export function buildResolvedProblemsPrompt(
  messages: ProviderMessage[],
): string {
  return buildDelimitedMessagePrompt({
    intro: [
      'Extract problem → resolution pairs from this conversation.',
      'Only include problems that were actually resolved. One line each.',
      'Format: problem → resolution.',
      'Highlight the resolution, not the debugging journey.',
    ],
    delimiter: 'CONVERSATION',
    messages,
    render: (msg) => {
      const text = extractText(msg.content);
      return text.trim() ? `[${msg.role}]: ${text.trim().slice(0, 1000)}` : null;
    },
    outro: 'List resolved problems now (or return empty if none):',
  });
}

// ---------------------------------------------------------------------------
// Plan progress
// ---------------------------------------------------------------------------

/**
 * buildPlanProgress — rule-based from plan state.
 * Returns null if no active plan.
 */
export function buildPlanProgress(
  plan: ExecutionPlan | null,
): CompactionSection | null {
  if (!plan) return null;

  const lines: string[] = [];

  // Group items by phase
  const byPhase = new Map<string, PlanItem[]>();
  const phaseOrder: string[] = [];
  for (const item of plan.items) {
    if (!byPhase.has(item.phase)) {
      byPhase.set(item.phase, []);
      phaseOrder.push(item.phase);
    }
    byPhase.get(item.phase)?.push(item);
  }

  for (const phase of phaseOrder) {
    const items = byPhase.get(phase) ?? [];
    const done = items.filter(
      (i) => i.status === 'complete' || i.status === 'skipped',
    ).length;
    const inProgress = items.some((i) => i.status === 'in_progress');
    const failed = items.some((i) => i.status === 'failed');
    const all = items.length;
    const allDone = done === all;

    let status: string;
    if (allDone) status = 'COMPLETE';
    else if (failed) status = `FAILED (${done}/${all} done)`;
    else if (inProgress) status = `IN_PROGRESS (${done}/${all} done)`;
    else status = `PENDING (${done}/${all} done)`;

    lines.push(`- ${phase}: [${status}]`);
  }

  if (lines.length === 0) return null;

  const content = `**${plan.title}**\n${lines.join('\n')}`;
  return makeSection('plan-progress', '## Plan Progress', content);
}

// ---------------------------------------------------------------------------
// Session lineage
// ---------------------------------------------------------------------------

/**
 * buildSessionLineage — format the append-only micro-log.
 * Each compaction adds one entry; prior entries are never modified.
 */
export function buildSessionLineage(
  originalTask: string | undefined,
  lineageEntries: string[],
  compactionCount: number,
): CompactionSection | null {
  // Omit the section entirely when there is no original task and no recorded
  // compaction entries, matching the documented omit-on-empty contract.
  if (!originalTask && lineageEntries.length === 0) return null;

  const lines: string[] = [];

  if (originalTask) {
    lines.push(`Original task: "${originalTask}"`);
  }
  lines.push(`Prior compactions: ${compactionCount}`);
  for (const entry of lineageEntries) {
    lines.push(entry);
  }

  return makeSection('session-lineage', '## Session Lineage', lines.join('\n'));
}
