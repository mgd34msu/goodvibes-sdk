import type { KnowledgeIssueRecord, KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { yieldEvery } from '../cooperative.js';
import { readRecord, readString, stableHash } from './helpers.js';
import { readHomeGraphState } from './state.js';
import { reviewHomeGraphFact } from './review.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import type { HomeGraphSpaceInput } from './types.js';

/**
 * Default auto-apply threshold for LLM triage decisions, expressed on the SDK's
 * 0-100 confidence scale. This mirrors the Home Assistant Python triage engine's
 * `0.85` gate and reuses the same "trust above a threshold" idiom as the semantic
 * gap-repair `minConfidence` precedent (`knowledge/semantic/gap-repair.ts`).
 */
export const HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE = 85;
/** Issues sent to the model per completion call. */
export const HOME_GRAPH_TRIAGE_DEFAULT_CHUNK_SIZE = 25;
/** Untriaged open issues examined in a single run by default. */
export const HOME_GRAPH_TRIAGE_DEFAULT_LIMIT = 25;

/** Ceiling on how many open issues are scanned before limit/skip filtering. */
const TRIAGE_ISSUE_SCAN_LIMIT = 1_000;
/** Issue-metadata key under which a triage decision + fingerprint is cached. */
const TRIAGE_METADATA_KEY = 'triage';
/** Provenance tag stamped on every triage decision and review value. */
const TRIAGE_SOURCE = 'homegraph-triage';

/**
 * One entry in the extensible issue-code → applicability-rule framework. Adding a
 * rule for a new `homegraph.*` issue code makes that code eligible for LLM triage
 * without touching the loop itself. This replaces the two hardcoded codes the
 * heuristic layer knows about.
 */
export interface HomeGraphTriageRule {
  /** The issue code this rule governs, e.g. `homegraph.device.unknown_battery`. */
  readonly code: string;
  /** Extra model guidance appended to the triage instruction for this code. */
  readonly promptGuidance?: string | undefined;
  /** Review category recorded when the model omits one for a reject. */
  readonly defaultCategory?: string | undefined;
}

/**
 * The built-in rules. These reproduce the applicability judgment the Python triage
 * prompt asked for, for exactly the two codes `quality.ts` raises today. The
 * `deriveIssueFacts` mapping in `review.ts` supplies the code-specific facts when a
 * reject is applied, so rules only carry the prompt guidance and default category.
 */
export const DEFAULT_HOME_GRAPH_TRIAGE_RULES: readonly HomeGraphTriageRule[] = [
  {
    code: 'homegraph.device.unknown_battery',
    defaultCategory: 'not_applicable',
    promptGuidance: [
      'For unknown battery type issues: reject software objects, integrations, automations,',
      'scripts, scenes, areas, helpers, the sun, weather, Home Assistant host/core/supervisor',
      'objects, servers, adapters, hubs, coordinators, bridges, and mains-powered media devices',
      'or appliances. Include fact {"batteryPowered":false,"batteryType":"none"} for those',
      'not-applicable rejects. Review sensors, locks, remotes, buttons, keypads, contact sensors,',
      'motion sensors, leak sensors, smoke detectors, thermostats, shades, blinds, and any',
      'ambiguous physical device that could plausibly be battery powered.',
    ].join(' '),
  },
  {
    code: 'homegraph.device.missing_manual',
    defaultCategory: 'not_applicable',
    promptGuidance: [
      'For missing manual issues that are not applicable to software, helpers, or generated Home',
      'Assistant objects, include fact {"manualRequired":false}.',
    ].join(' '),
  },
];

export interface HomeGraphTriageOptions {
  /** Auto-apply threshold on the 0-100 scale. Default 85. */
  readonly minConfidence?: number | undefined;
  /** Max untriaged open issues to examine this run. Default 25. */
  readonly limit?: number | undefined;
  /** Issues per model completion. Default 25. */
  readonly chunkSize?: number | undefined;
  /** Re-triage even issues whose cached fingerprint is unchanged. */
  readonly force?: boolean | undefined;
  /** Issue ids to leave untouched this run. */
  readonly skipIssueIds?: readonly string[] | undefined;
  /** Restrict triage to this subset of issue codes (must still have a rule). */
  readonly issueCodes?: readonly string[] | undefined;
  /** Extra rules merged over the built-ins (by code) — the extensibility hook. */
  readonly additionalRules?: readonly HomeGraphTriageRule[] | undefined;
  /** Per-completion model timeout in ms. */
  readonly timeoutMs?: number | undefined;
  /** Reviewer label recorded on applied decisions. */
  readonly reviewer?: string | undefined;
}

export interface HomeGraphTriageDecision {
  readonly issueId: string;
  readonly code: string;
  readonly action: 'reject' | 'review';
  readonly category?: string | undefined;
  readonly confidence: number;
  readonly reason?: string | undefined;
  /** True when the decision cleared the threshold and was auto-applied. */
  readonly applied: boolean;
  /** Facts written to the device node when applied. */
  readonly appliedFacts?: Record<string, unknown> | undefined;
  /** Provenance tag — always `homegraph-triage`. */
  readonly source: string;
}

export interface HomeGraphTriageResult {
  readonly ok: true;
  readonly spaceId: string;
  /** False when no semantic LLM is configured — the loop is a no-op. */
  readonly configured: boolean;
  readonly processed: number;
  /** Open triageable issues skipped because their cached fingerprint was unchanged. */
  readonly skipped: number;
  readonly applied: number;
  readonly reviewed: number;
  readonly decisions: readonly HomeGraphTriageDecision[];
  /** Open triageable issues still unresolved after this run. */
  readonly remaining: number;
  readonly minConfidence: number;
  readonly reason?: string | undefined;
}

interface TriageRecord {
  readonly issueId: string;
  readonly code: string;
  readonly severity: string;
  readonly status: string;
  readonly message: string;
  readonly nodeId?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly node?: Record<string, unknown> | undefined;
}

/**
 * LLM-driven triage over open Home Graph device-quality issues. Operates strictly
 * on the resolved Home Assistant knowledge space: it reads that space's issues and
 * nodes, prompts the configured semantic LLM to classify each open issue as
 * `reject` (safe to auto-dismiss) or `review` (needs a human), auto-applies rejects
 * at or above the confidence threshold via {@link reviewHomeGraphFact}, and caches
 * every decision on the issue so an unchanged issue is never re-sent to the model.
 *
 * This never reads or writes any other knowledge space — Home Graph shares this
 * code with the wiki/agent knowledge functions but never their data.
 */
export async function runHomeGraphIssueTriage(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly options?: HomeGraphTriageOptions | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<HomeGraphTriageResult> {
  await input.store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(input.store, input);
  const options = input.options ?? {};
  const minConfidence = clampConfidence(options.minConfidence ?? HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE);
  const llm = input.semanticService?.llm ?? null;

  const rulesByCode = mergeTriageRules(options.additionalRules);
  const codeFilter = options.issueCodes ? new Set(options.issueCodes) : null;
  const state = readHomeGraphState(input.store, spaceId);
  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  const openTriageable = state.issues.filter((issue) => (
    issue.status === 'open'
    && rulesByCode.has(issue.code)
    && (!codeFilter || codeFilter.has(issue.code))
  ));

  if (!llm) {
    return emptyResult(spaceId, minConfidence, openTriageable.length, false, 'triage-llm-not-configured');
  }

  const skipIssueIds = new Set(options.skipIssueIds ?? []);
  const scannable = openTriageable.slice(0, TRIAGE_ISSUE_SCAN_LIMIT);
  let cacheSkipped = 0;
  const candidates: KnowledgeIssueRecord[] = [];
  for (const issue of scannable) {
    if (skipIssueIds.has(issue.id)) continue;
    const node = issue.nodeId ? nodeById.get(issue.nodeId) : undefined;
    if (!options.force && isCachedTriage(issue, node)) {
      cacheSkipped += 1;
      continue;
    }
    candidates.push(issue);
  }

  const limit = Math.max(1, options.limit ?? HOME_GRAPH_TRIAGE_DEFAULT_LIMIT);
  const selected = candidates.slice(0, limit);
  if (selected.length === 0) {
    const reason = cacheSkipped > 0 ? 'no-untriaged-open-issues' : 'no-open-issues';
    return emptyResult(spaceId, minConfidence, openTriageable.length, true, reason, cacheSkipped);
  }

  const records = selected.map((issue) => buildTriageRecord(issue, issue.nodeId ? nodeById.get(issue.nodeId) : undefined));
  const chunkSize = Math.max(1, options.chunkSize ?? HOME_GRAPH_TRIAGE_DEFAULT_CHUNK_SIZE);
  const decisionByIssueId = new Map<string, ParsedDecision>();
  for (let index = 0; index < records.length; index += chunkSize) {
    if (input.signal?.aborted) break;
    const chunk = records.slice(index, index + chunkSize);
    const response = await llm.completeJson({
      purpose: 'homegraph-issue-triage',
      maxTokens: 2_000,
      systemPrompt: buildTriageSystemPrompt(rulesByCode, chunk),
      prompt: JSON.stringify({ issues: chunk }),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for (const decision of parseTriageDecisions(response)) {
      decisionByIssueId.set(decision.issueId, decision);
    }
    await yieldEvery(index, chunkSize);
  }

  const issueById = new Map(selected.map((issue) => [issue.id, issue]));
  const decisions: HomeGraphTriageDecision[] = [];
  let appliedCount = 0;
  for (const issue of selected) {
    const parsed = decisionByIssueId.get(issue.id);
    if (!parsed) continue;
    const rule = rulesByCode.get(issue.code);
    const category = parsed.category ?? rule?.defaultCategory;
    const shouldApply = parsed.action === 'reject' && parsed.confidence >= minConfidence;
    let appliedFacts: Record<string, unknown> | undefined;
    if (shouldApply) {
      const review = await reviewHomeGraphFact(input.store, spaceId, installationId, {
        knowledgeSpaceId: spaceId,
        issueId: issue.id,
        action: 'reject',
        reviewer: options.reviewer ?? `${TRIAGE_SOURCE}:auto`,
        value: buildReviewValue(category, parsed, rule),
      });
      appliedFacts = review.appliedFacts;
      appliedCount += 1;
    }
    const decision: HomeGraphTriageDecision = {
      issueId: issue.id,
      code: issue.code,
      action: parsed.action,
      ...(category ? { category } : {}),
      confidence: parsed.confidence,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      applied: shouldApply,
      ...(appliedFacts && Object.keys(appliedFacts).length > 0 ? { appliedFacts } : {}),
      source: TRIAGE_SOURCE,
    };
    decisions.push(decision);
    await recordTriageDecision(input.store, issue.id, issueById.get(issue.id) ?? issue, decision, nodeById);
  }

  const remaining = countOpenTriageable(input.store, spaceId, rulesByCode, codeFilter);
  return {
    ok: true,
    spaceId,
    configured: true,
    processed: selected.length,
    skipped: cacheSkipped,
    applied: appliedCount,
    reviewed: decisions.length - appliedCount,
    decisions,
    remaining,
    minConfidence,
  };
}

function emptyResult(
  spaceId: string,
  minConfidence: number,
  remaining: number,
  configured: boolean,
  reason: string,
  skipped = 0,
): HomeGraphTriageResult {
  return {
    ok: true,
    spaceId,
    configured,
    processed: 0,
    skipped,
    applied: 0,
    reviewed: 0,
    decisions: [],
    remaining,
    minConfidence,
    reason,
  };
}

function mergeTriageRules(
  additional: readonly HomeGraphTriageRule[] | undefined,
): Map<string, HomeGraphTriageRule> {
  const byCode = new Map<string, HomeGraphTriageRule>();
  for (const rule of DEFAULT_HOME_GRAPH_TRIAGE_RULES) byCode.set(rule.code, rule);
  for (const rule of additional ?? []) {
    if (typeof rule?.code === 'string' && rule.code.trim()) byCode.set(rule.code, rule);
  }
  return byCode;
}

function buildTriageRecord(issue: KnowledgeIssueRecord, node: KnowledgeNodeRecord | undefined): TriageRecord {
  const record: TriageRecord = {
    issueId: issue.id,
    code: issue.code,
    severity: issue.severity,
    status: issue.status,
    message: issue.message,
    ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    ...(issue.sourceId ? { sourceId: issue.sourceId } : {}),
  };
  if (!node) return record;
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const nodeSummary = pruneEmpty({
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    aliases: node.aliases.slice(0, 8),
    confidence: node.confidence,
    manufacturer: readString(node.metadata.manufacturer),
    model: readString(node.metadata.model),
    homeAssistant: pruneEmpty({
      objectKind: readString(homeAssistant.objectKind),
      objectId: readString(homeAssistant.objectId),
      entityId: readString(homeAssistant.entityId),
      deviceId: readString(homeAssistant.deviceId),
      areaId: readString(homeAssistant.areaId),
      integrationId: readString(homeAssistant.integrationId),
    }),
  });
  return { ...record, node: nodeSummary };
}

function buildTriageSystemPrompt(
  rulesByCode: Map<string, HomeGraphTriageRule>,
  records: readonly TriageRecord[],
): string {
  const activeCodes = new Set(records.map((record) => record.code));
  const guidance = [...rulesByCode.values()]
    .filter((rule) => activeCodes.has(rule.code))
    .map((rule) => rule.promptGuidance)
    .filter((line): line is string => Boolean(line));
  return [
    'You are GoodVibes Home Graph review triage for Home Assistant.',
    'Classify each issue so people only review uncertain cases.',
    'Return only strict JSON with this shape:',
    '{"decisions":[{"issueId":"...","action":"reject|review","category":"...","confidence":0,"reason":"...","fact":{}}]}.',
    'Echo the issueId exactly as supplied. confidence is a number from 0 to 100.',
    'Use action reject only when the issue is clearly not applicable or incorrect and can be safely',
    'dismissed. Use action review for anything uncertain, anything that may require household',
    'knowledge, or any physical device that could plausibly be affected.',
    ...guidance,
    'Do not invent facts. Do not choose accept, resolve, edit, or forget.',
  ].join('\n');
}

interface ParsedDecision {
  readonly issueId: string;
  readonly action: 'reject' | 'review';
  readonly category?: string | undefined;
  readonly confidence: number;
  readonly reason?: string | undefined;
  readonly fact?: Record<string, unknown> | undefined;
}

function parseTriageDecisions(value: unknown): readonly ParsedDecision[] {
  const record = readRecord(value);
  const raw = Array.isArray(record.decisions) ? record.decisions : Array.isArray(value) ? value : [];
  const parsed: ParsedDecision[] = [];
  for (const entry of raw) {
    const decision = readRecord(entry);
    const issueId = readString(decision.issueId) ?? readString(decision.id);
    if (!issueId) continue;
    const action = readString(decision.action)?.toLowerCase() === 'reject' ? 'reject' : 'review';
    const fact = readRecord(decision.fact);
    parsed.push({
      issueId,
      action,
      ...(readString(decision.category) ? { category: normalizeCategory(readString(decision.category)!) } : {}),
      confidence: normalizeConfidence(decision.confidence),
      ...(readString(decision.reason) ? { reason: readString(decision.reason) } : {}),
      ...(Object.keys(fact).length > 0 ? { fact } : {}),
    });
  }
  return parsed;
}

function buildReviewValue(
  category: string | undefined,
  parsed: ParsedDecision,
  rule: HomeGraphTriageRule | undefined,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    category: category ?? rule?.defaultCategory ?? 'not_applicable',
    confidence: parsed.confidence,
    reason: parsed.reason ?? 'LLM triage classified this issue as not applicable.',
    source: TRIAGE_SOURCE,
  };
  if (parsed.fact && Object.keys(parsed.fact).length > 0) value.fact = parsed.fact;
  return value;
}

async function recordTriageDecision(
  store: KnowledgeStore,
  issueId: string,
  fallback: KnowledgeIssueRecord,
  decision: HomeGraphTriageDecision,
  nodeById: Map<string, KnowledgeNodeRecord>,
): Promise<void> {
  // Re-read so an applied reject (which resolved the issue via reviewFact) keeps
  // its fresh status/metadata; upsertIssue shallow-merges metadata, preserving it.
  const current = store.getIssue(issueId) ?? fallback;
  const node = current.nodeId ? nodeById.get(current.nodeId) : undefined;
  await store.upsertIssue({
    id: current.id,
    severity: current.severity,
    code: current.code,
    message: current.message,
    status: current.status,
    ...(current.sourceId ? { sourceId: current.sourceId } : {}),
    ...(current.nodeId ? { nodeId: current.nodeId } : {}),
    metadata: {
      ...current.metadata,
      [TRIAGE_METADATA_KEY]: {
        fingerprint: triageFingerprint(current, node),
        action: decision.action,
        ...(decision.category ? { category: decision.category } : {}),
        confidence: decision.confidence,
        ...(decision.reason ? { reason: decision.reason } : {}),
        applied: decision.applied,
        source: TRIAGE_SOURCE,
        decidedAt: Date.now(),
      },
    },
  });
}

function isCachedTriage(issue: KnowledgeIssueRecord, node: KnowledgeNodeRecord | undefined): boolean {
  const cached = readRecord(issue.metadata[TRIAGE_METADATA_KEY]);
  const fingerprint = readString(cached.fingerprint);
  if (!fingerprint) return false;
  return fingerprint === triageFingerprint(issue, node);
}

function triageFingerprint(issue: KnowledgeIssueRecord, node: KnowledgeNodeRecord | undefined): string {
  const homeAssistant = node ? readRecord(node.metadata.homeAssistant) : {};
  return stableHash(JSON.stringify({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    nodeId: issue.nodeId ?? null,
    sourceId: issue.sourceId ?? null,
    title: node?.title ?? null,
    confidence: node?.confidence ?? null,
    manufacturer: node ? readString(node.metadata.manufacturer) ?? null : null,
    model: node ? readString(node.metadata.model) ?? null : null,
    objectKind: readString(homeAssistant.objectKind) ?? null,
    entityId: readString(homeAssistant.entityId) ?? null,
    deviceId: readString(homeAssistant.deviceId) ?? null,
  }));
}

function countOpenTriageable(
  store: KnowledgeStore,
  spaceId: string,
  rulesByCode: Map<string, HomeGraphTriageRule>,
  codeFilter: Set<string> | null,
): number {
  return readHomeGraphState(store, spaceId).issues.filter((issue) => (
    issue.status === 'open'
    && rulesByCode.has(issue.code)
    && (!codeFilter || codeFilter.has(issue.code))
  )).length;
}

function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 0;
  // Accept both the 0-1 fraction the Python engine used and the 0-100 SDK scale.
  const scaled = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return clampConfidence(scaled);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function pruneEmpty(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) continue;
    result[key] = value;
  }
  return result;
}
