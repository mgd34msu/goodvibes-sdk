/**
 * Agent-driven goal decomposition for the planner.
 *
 * This module is the model-decomposition counterpart to the deterministic
 * heuristic path in `plan-proposal.ts`. Given a goal, it drives a bounded,
 * READ-ONLY planning agent (through the injected `DecompositionRunner` seam —
 * this module never imports the agent machinery, so it stays in `core` and is
 * fully unit-testable with a stubbed runner), parses and STRICTLY validates
 * the agent's structured output, and produces a `PlanProposal` tagged with
 * honest provenance.
 *
 * Failure honesty is the whole point: a spawn error, a timeout/cancellation,
 * or output that is still malformed after ONE repair attempt all fall back to
 * the existing heuristic `singleItemProposal` path, tagged
 * `decomposedBy: 'heuristic'` with a `fallbackReason`. The heuristic path is
 * reused verbatim — `singleItemProposal`/`assemblePlanProposal` are never
 * modified — so their existing byte-for-byte test expectations are preserved;
 * provenance is layered on afterward.
 *
 * The module NEVER performs surgery on agent output to force it to validate:
 * a proposal is accepted only when `assemblePlanProposal` reports ZERO issues
 * (no dangling dependency, no dependency cycle, no unresolved phase). Anything
 * short of that is one repair attempt and then an honest fallback — never a
 * silent edit that drops or rewrites the agent's work items.
 */

import { AdaptivePlanner } from './adaptive-planner.js';
import type { PlannerInputs, DecompositionGate } from './adaptive-planner.js';
import {
  assemblePlanProposal,
  singleItemProposal,
  type PlanProposal,
  type PlanProposalIssue,
  type RawDecomposition,
  type DecompositionAgentUsage,
} from './plan-proposal.js';

// ---------------------------------------------------------------------------
// The agent output contract (the JSON a planning agent must emit)
// ---------------------------------------------------------------------------

/** A phase in the agent's decomposition. Optional across the contract — items
 *  may share an implicit single phase. */
export interface DecompositionAgentPhase {
  title: string;
  description?: string;
}

/**
 * A single work item in the agent's decomposition.
 *
 * `ordinal` fixes a stable execution order independent of array position.
 * `dependsOn` entries may be either other items' titles or their ordinals
 * (as a number or numeric string) — both are resolved to titles before the
 * proposal is assembled.
 */
export interface DecompositionAgentItem {
  title: string;
  brief: string;
  ordinal: number;
  phase?: string;
  dependsOn?: Array<string | number>;
  suggestedArchetype?: string;
  likelyFiles?: string[];
  verification?: string[];
  canRunConcurrently?: boolean;
  needsReview?: boolean;
}

/** The full JSON object a planning agent emits. */
export interface DecompositionAgentOutput {
  phases?: DecompositionAgentPhase[];
  items: DecompositionAgentItem[];
  /** Extra explicit edges; `{from, to}` reads "from depends on to". */
  dependencies?: Array<{ from: string | number; to: string | number }>;
  notes?: string[];
  risks?: string[];
}

// ---------------------------------------------------------------------------
// Runner seam (the bounded, read-only planning-agent driver)
// ---------------------------------------------------------------------------

/** Hard bounds on a planning-agent run. */
export interface DecompositionBounds {
  /** Maximum agent turns before the run is stopped. */
  maxTurns: number;
  /** Total token budget; exceeding it stops the run. */
  tokenCeiling: number;
  /** Wall-clock timeout in ms; exceeding it cancels the run. */
  wallTimeoutMs: number;
}

export interface DecompositionRunnerRequest {
  goal: string;
  workingDir: string;
  systemPrompt: string;
  userPrompt: string;
  bounds: DecompositionBounds;
  /** Which attempt this is; `'repair'` prompts include prior validation errors. */
  attempt: 'initial' | 'repair';
}

/**
 * Terminal status of a planning-agent run.
 * - `completed` — the agent finished and produced final output text.
 * - `cancelled` — the run was stopped: an external kill, the wall-clock
 *   timeout firing, or the token ceiling being crossed all collapse to this.
 * - `failed`    — the agent could not be spawned or errored mid-run.
 */
export type DecompositionRunStatus = 'completed' | 'cancelled' | 'failed';

export interface DecompositionRunResult {
  status: DecompositionRunStatus;
  /** The agent's final output text (empty when it never produced any). */
  output: string;
  usage?: DecompositionAgentUsage | undefined;
  elapsedMs: number;
  /** Error detail for `failed`, or a stop detail for `cancelled` (e.g. 'wall-timeout'). */
  detail?: string | undefined;
  agentId?: string | undefined;
}

export interface DecompositionRunner {
  run(request: DecompositionRunnerRequest): Promise<DecompositionRunResult>;
}

// ---------------------------------------------------------------------------
// Service inputs / outputs
// ---------------------------------------------------------------------------

export interface DecomposeGoalConstraints {
  /** Concurrency capacity the plan should respect, if the caller set one. */
  capacity?: number | undefined;
  /** Dollar budget for the workstream, if the caller set one. */
  budgetUsd?: number | undefined;
}

export interface DecomposeGoalRequest {
  goal: string;
  workingDir: string;
  constraints?: DecomposeGoalConstraints | undefined;
  /** Optional free-form user context handed to the planning agent. */
  userContext?: string | undefined;
}

export interface DecompositionServiceConfig {
  mode: 'agent' | 'heuristic';
  bounds: DecompositionBounds;
}

/** An honest, machine-readable record of how a decomposition resolved. */
export type DecompositionOutcome =
  | { kind: 'agent'; itemCount: number; repaired: boolean; usage?: DecompositionAgentUsage | undefined; costUsd?: number | undefined; elapsedMs: number }
  | { kind: 'heuristic-configured' }
  | { kind: 'gate-declined'; reasonCode: DecompositionGate['reasonCode'] }
  | { kind: 'fallback'; reason: string; usage?: DecompositionAgentUsage | undefined; elapsedMs?: number | undefined };

export interface DecomposeGoalDeps {
  /** Optional token→dollars estimator; when absent, `agentCostUsd` stays undefined. */
  estimateCostUsd?: ((usage: DecompositionAgentUsage) => number | undefined) | undefined;
  /** Optional honest-event sink, invoked exactly once per decomposition. */
  onOutcome?: ((outcome: DecompositionOutcome) => void) | undefined;
}

export interface DecomposeGoalResult {
  proposal: PlanProposal;
  gate: DecompositionGate;
  issues: PlanProposalIssue[];
  outcome: DecompositionOutcome;
}

// ---------------------------------------------------------------------------
// Parsing + strict validation
// ---------------------------------------------------------------------------

export interface ParsedDecomposition {
  ok: boolean;
  raw?: RawDecomposition | undefined;
  notes?: string[] | undefined;
  errors: string[];
}

/** Pull the first balanced JSON object out of arbitrary agent text (fenced or not). */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced?.[1] ?? text;
  const start = haystack.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse + strictly validate a planning agent's output text into a
 * `RawDecomposition` the assembler can consume. Never throws; every problem is
 * accumulated into `errors` so a single repair prompt can address them all at
 * once. Structural rejects: unparseable JSON, empty/absent items array, empty
 * item title/brief, non-finite ordinal, empty phase title.
 */
export function parseDecomposition(text: string): ParsedDecomposition {
  const errors: string[] = [];
  const json = extractJsonObject(text ?? '');
  if (!json) {
    return { ok: false, errors: ['Output did not contain a JSON object.'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [`Output was not valid JSON: ${(err as Error).message}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['Top-level value must be a JSON object.'] };
  }
  const obj = parsed as Record<string, unknown>;

  const rawItems = obj.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, errors: ['"items" must be a non-empty array.'] };
  }

  // Validate phases (optional).
  const rawPhases = Array.isArray(obj.phases) ? (obj.phases as unknown[]) : [];
  rawPhases.forEach((p, i) => {
    if (typeof p !== 'object' || p === null || !isNonEmptyString((p as Record<string, unknown>).title)) {
      errors.push(`phases[${i}] must have a non-empty "title".`);
    }
  });

  // Validate items.
  const items: DecompositionAgentItem[] = [];
  rawItems.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`items[${i}] must be an object.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    if (!isNonEmptyString(item.title)) errors.push(`items[${i}].title must be a non-empty string.`);
    if (!isNonEmptyString(item.brief)) errors.push(`items[${i}].brief must be a non-empty string.`);
    if (typeof item.ordinal !== 'number' || !Number.isFinite(item.ordinal)) {
      errors.push(`items[${i}].ordinal must be a finite number.`);
    }
    if (item.phase !== undefined && !isNonEmptyString(item.phase)) {
      errors.push(`items[${i}].phase, when present, must be a non-empty string.`);
    }
    if (isNonEmptyString(item.title) && isNonEmptyString(item.brief) && typeof item.ordinal === 'number' && Number.isFinite(item.ordinal)) {
      items.push({
        title: item.title,
        brief: item.brief,
        ordinal: item.ordinal,
        ...(isNonEmptyString(item.phase) ? { phase: item.phase } : {}),
        ...(Array.isArray(item.dependsOn) ? { dependsOn: item.dependsOn.filter((d): d is string | number => typeof d === 'string' || typeof d === 'number') } : {}),
        ...(isNonEmptyString(item.suggestedArchetype) ? { suggestedArchetype: item.suggestedArchetype } : {}),
        ...(Array.isArray(item.likelyFiles) ? { likelyFiles: item.likelyFiles.filter(isNonEmptyString) } : {}),
        ...(Array.isArray(item.verification) ? { verification: item.verification.filter(isNonEmptyString) } : {}),
        ...(typeof item.canRunConcurrently === 'boolean' ? { canRunConcurrently: item.canRunConcurrently } : {}),
        ...(typeof item.needsReview === 'boolean' ? { needsReview: item.needsReview } : {}),
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const notes: string[] = [];
  if (Array.isArray(obj.notes)) notes.push(...(obj.notes as unknown[]).filter(isNonEmptyString));
  if (Array.isArray(obj.risks)) notes.push(...(obj.risks as unknown[]).filter(isNonEmptyString));

  const output: DecompositionAgentOutput = {
    items,
    ...(rawPhases.length > 0 ? { phases: rawPhases as DecompositionAgentPhase[] } : {}),
    ...(Array.isArray(obj.dependencies) ? { dependencies: (obj.dependencies as Array<{ from: string | number; to: string | number }>) } : {}),
  };

  return { ok: true, raw: toRawDecomposition(output), ...(notes.length > 0 ? { notes } : {}), errors: [] };
}

const DEFAULT_PHASE_TITLE = 'Execute';

/**
 * Map a validated `DecompositionAgentOutput` into the `RawDecomposition` shape
 * `assemblePlanProposal` consumes. Items are ordered by `ordinal` (stable on
 * ties). Every referenced phase is materialized so the assembler never has to
 * synthesize an "Unphased" bucket — an unresolved phase from here would be a
 * real bug, not agent sloppiness. Ordinal-based dependency references are
 * resolved to titles so the assembler's title resolver handles them uniformly.
 */
export function toRawDecomposition(output: DecompositionAgentOutput): RawDecomposition {
  const ordered = [...output.items].sort((a, b) => a.ordinal - b.ordinal);
  const ordinalToTitle = new Map<number, string>();
  for (const item of ordered) {
    if (!ordinalToTitle.has(item.ordinal)) ordinalToTitle.set(item.ordinal, item.title);
  }

  const resolveRef = (ref: string | number): string => {
    if (typeof ref === 'number') return ordinalToTitle.get(ref) ?? String(ref);
    const asNum = Number(ref);
    if (ref.trim() !== '' && Number.isFinite(asNum) && ordinalToTitle.has(asNum)) return ordinalToTitle.get(asNum)!;
    return ref;
  };

  // Phase set: explicit phases first, then any item phase titles not covered,
  // then the default shared phase if any item lacks one.
  const phaseTitles: string[] = [];
  const seenPhase = new Set<string>();
  const addPhase = (title: string) => {
    const key = title.toLowerCase().trim();
    if (!seenPhase.has(key)) { seenPhase.add(key); phaseTitles.push(title); }
  };
  const explicit = new Map<string, DecompositionAgentPhase>();
  for (const p of output.phases ?? []) {
    explicit.set(p.title.toLowerCase().trim(), p);
    addPhase(p.title);
  }
  let needsDefault = false;
  for (const item of ordered) {
    if (item.phase) addPhase(item.phase);
    else needsDefault = true;
  }
  if (needsDefault) addPhase(DEFAULT_PHASE_TITLE);

  const phases = phaseTitles.map((title) => {
    const meta = explicit.get(title.toLowerCase().trim());
    return meta?.description ? { title, description: meta.description } : { title };
  });

  // Accumulate dependencies: inline dependsOn plus explicit edges.
  const depsByTitle = new Map<string, Set<string>>();
  const addDep = (from: string, to: string) => {
    const key = from.toLowerCase().trim();
    if (!depsByTitle.has(key)) depsByTitle.set(key, new Set());
    depsByTitle.get(key)!.add(to);
  };
  for (const item of ordered) {
    for (const dep of item.dependsOn ?? []) addDep(item.title, resolveRef(dep));
  }
  for (const edge of output.dependencies ?? []) addDep(resolveRef(edge.from), resolveRef(edge.to));

  const workItems = ordered.map((item) => {
    const deps = depsByTitle.get(item.title.toLowerCase().trim());
    return {
      title: item.title,
      brief: item.brief,
      phase: item.phase ?? DEFAULT_PHASE_TITLE,
      ...(deps && deps.size > 0 ? { dependsOn: [...deps] } : {}),
      ...(item.suggestedArchetype ? { suggestedArchetype: item.suggestedArchetype } : {}),
      ...(item.likelyFiles ? { likelyFiles: item.likelyFiles } : {}),
      ...(item.verification ? { verification: item.verification } : {}),
      ...(item.canRunConcurrently !== undefined ? { canRunConcurrently: item.canRunConcurrently } : {}),
      ...(item.needsReview !== undefined ? { needsReview: item.needsReview } : {}),
    };
  });

  return { phases, workItems };
}

// ---------------------------------------------------------------------------
// Planner agent prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the read-only planning agent. It is explicit
 * about the exact JSON contract and about the read-only posture (the agent's
 * tool set already excludes write/edit/exec; this reinforces intent).
 */
export function buildPlannerSystemPrompt(): string {
  return [
    'You are a READ-ONLY planning agent. You may read, search, and analyze the codebase',
    'to understand it, but you MUST NOT modify anything and you have no write/edit/exec tools.',
    '',
    'Decompose the given goal into an ordered set of work items. Respond with a SINGLE JSON',
    'object and NOTHING else (no prose, no markdown outside a single optional ```json fence).',
    '',
    'Schema:',
    '{',
    '  "phases": [{ "title": string, "description"?: string }],   // optional; shared phase template',
    '  "items": [{',
    '    "title": string,            // required, non-empty, unique',
    '    "brief": string,            // required, non-empty: what this item does',
    '    "ordinal": number,          // required: execution order (0-based or 1-based, ascending)',
    '    "phase"?: string,           // phase title this item belongs to',
    '    "dependsOn"?: (string|number)[],  // item titles or ordinals this item depends on',
    '    "suggestedArchetype"?: "engineer"|"reviewer"|"tester"|"researcher"|"integrator",',
    '    "likelyFiles"?: string[],',
    '    "verification"?: string[],',
    '    "canRunConcurrently"?: boolean,',
    '    "needsReview"?: boolean',
    '  }],',
    '  "dependencies"?: [{ "from": string|number, "to": string|number }],  // "from depends on to"',
    '  "notes"?: string[],',
    '  "risks"?: string[]',
    '}',
    '',
    'Rules: dependencies must reference real items and must be acyclic. Every brief must be',
    'non-empty. Keep the decomposition honest — if the goal is genuinely a single unit of work,',
    'return exactly one item.',
  ].join('\n');
}

function buildUserPrompt(request: DecomposeGoalRequest, repairErrors?: string[]): string {
  const lines: string[] = [`Goal: ${request.goal}`, `Working directory: ${request.workingDir}`];
  if (request.constraints?.capacity !== undefined) lines.push(`Concurrency capacity: ${request.constraints.capacity}`);
  if (request.constraints?.budgetUsd !== undefined) lines.push(`Budget (USD): ${request.constraints.budgetUsd}`);
  if (request.userContext) lines.push('', 'Additional context:', request.userContext);
  if (repairErrors && repairErrors.length > 0) {
    lines.push(
      '',
      'Your previous response was rejected for these reasons. Fix ALL of them and respond again',
      'with a single corrected JSON object:',
      ...repairErrors.map((e) => `  - ${e}`),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Decompose a goal into a `PlanProposal`, honestly tagged with provenance.
 *
 * Control flow:
 *  1. `config.mode === 'heuristic'` → the configured heuristic path (no agent).
 *  2. The planner's decompose gate declines → honest single-item (no agent).
 *  3. No runner available → heuristic fallback (reason: no runtime).
 *  4. Agent path: run → parse → strict-validate → (assemble; issues===0 ?
 *     accept : ONE repair attempt) → accept-or-fallback. Spawn error,
 *     cancellation (kill / wall-timeout / token ceiling), or still-invalid
 *     output after repair all fall back to the heuristic path with a reason.
 */
export async function decomposeGoal(
  request: DecomposeGoalRequest,
  planner: AdaptivePlanner,
  inputs: PlannerInputs,
  config: DecompositionServiceConfig,
  runner: DecompositionRunner | null,
  deps: DecomposeGoalDeps = {},
): Promise<DecomposeGoalResult> {
  const gate = planner.shouldDecompose(inputs);

  const heuristicResult = (outcome: DecompositionOutcome): DecomposeGoalResult => {
    const base = singleItemProposal(request.goal);
    const fallbackReason = outcome.kind === 'fallback' ? outcome.reason : undefined;
    const usage = outcome.kind === 'fallback' ? outcome.usage : undefined;
    const elapsedMs = outcome.kind === 'fallback' ? outcome.elapsedMs : undefined;
    const proposal: PlanProposal = {
      ...base,
      decomposedBy: 'heuristic',
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(usage ? { agentUsage: usage } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    };
    deps.onOutcome?.(outcome);
    return { proposal, gate, issues: [], outcome };
  };

  if (config.mode === 'heuristic') {
    return heuristicResult({ kind: 'heuristic-configured' });
  }
  if (!gate.decompose) {
    return heuristicResult({ kind: 'gate-declined', reasonCode: gate.reasonCode });
  }
  if (!runner) {
    return heuristicResult({ kind: 'fallback', reason: 'no planning agent runtime available' });
  }

  const systemPrompt = buildPlannerSystemPrompt();
  let lastUsage: DecompositionAgentUsage | undefined;
  let totalElapsedMs = 0;

  const runOnce = async (attempt: 'initial' | 'repair', repairErrors?: string[]): Promise<DecompositionRunResult> => {
    const result = await runner.run({
      goal: request.goal,
      workingDir: request.workingDir,
      systemPrompt,
      userPrompt: buildUserPrompt(request, repairErrors),
      bounds: config.bounds,
      attempt,
    });
    lastUsage = result.usage ?? lastUsage;
    totalElapsedMs += result.elapsedMs;
    return result;
  };

  // --- initial attempt ---
  let run: DecompositionRunResult;
  try {
    run = await runOnce('initial');
  } catch (err) {
    return heuristicResult({ kind: 'fallback', reason: `spawn error: ${(err as Error).message}`, usage: lastUsage, elapsedMs: totalElapsedMs });
  }
  if (run.status === 'cancelled') {
    return heuristicResult({ kind: 'fallback', reason: `cancelled${run.detail ? ` (${run.detail})` : ''}`, usage: lastUsage, elapsedMs: totalElapsedMs });
  }
  if (run.status === 'failed') {
    return heuristicResult({ kind: 'fallback', reason: `agent error: ${run.detail ?? 'unknown'}`, usage: lastUsage, elapsedMs: totalElapsedMs });
  }

  const accept = (proposal: PlanProposal, issues: PlanProposalIssue[], repaired: boolean): DecomposeGoalResult => {
    const costUsd = lastUsage ? deps.estimateCostUsd?.(lastUsage) : undefined;
    const decorated: PlanProposal = {
      ...proposal,
      decomposedBy: 'agent',
      elapsedMs: totalElapsedMs,
      ...(lastUsage ? { agentUsage: lastUsage } : {}),
      ...(costUsd !== undefined ? { agentCostUsd: costUsd } : {}),
    };
    const outcome: DecompositionOutcome = {
      kind: 'agent',
      itemCount: decorated.workItems.length,
      repaired,
      ...(lastUsage ? { usage: lastUsage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      elapsedMs: totalElapsedMs,
    };
    deps.onOutcome?.(outcome);
    return { proposal: decorated, gate, issues, outcome };
  };

  // --- validate the initial output ---
  const first = parseDecomposition(run.output);
  if (first.ok && first.raw) {
    const { proposal, issues } = assemblePlanProposal(request.goal, gate.strategy, first.raw);
    if (issues.length === 0) return accept(proposal, issues, false);
    // Not clean — fall through to a single repair with the assembler's issues.
    const repairErrors = issues.map((i) => i.message);
    const repaired = await tryRepair(repairErrors);
    if (repaired) return repaired;
    return heuristicResult({ kind: 'fallback', reason: `invalid agent decomposition after repair: ${issues.map((i) => i.kind).join(', ')}`, usage: lastUsage, elapsedMs: totalElapsedMs });
  }

  // Malformed structure — one repair attempt with the parser's errors.
  const repaired = await tryRepair(first.errors);
  if (repaired) return repaired;
  return heuristicResult({ kind: 'fallback', reason: `malformed agent output after repair: ${first.errors.slice(0, 3).join('; ')}`, usage: lastUsage, elapsedMs: totalElapsedMs });

  // --- one repair attempt: returns an accepted result, or null to fall back ---
  async function tryRepair(repairErrors: string[]): Promise<DecomposeGoalResult | null> {
    let repairRun: DecompositionRunResult;
    try {
      repairRun = await runOnce('repair', repairErrors);
    } catch {
      return null;
    }
    if (repairRun.status !== 'completed') return null;
    const parsed = parseDecomposition(repairRun.output);
    if (!parsed.ok || !parsed.raw) return null;
    const { proposal, issues } = assemblePlanProposal(request.goal, gate.strategy, parsed.raw);
    if (issues.length !== 0) return null;
    return accept(proposal, issues, true);
  }
}
