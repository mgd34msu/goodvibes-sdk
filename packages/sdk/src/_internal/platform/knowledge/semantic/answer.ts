import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  getKnowledgeSpaceId,
  isHomeAssistantKnowledgeSpace,
  isInKnowledgeSpace,
  normalizeKnowledgeSpaceId,
} from '../spaces.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticLlmAnswer,
} from './types.js';
import {
  MAX_ANSWER_EVIDENCE_CHARS,
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  scoreSemanticText,
  semanticHash,
  semanticMetadata,
  sourceSemanticText,
  splitSentences,
  tokenizeSemanticQuery,
  uniqueStrings,
} from './utils.js';
import {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  isSemanticAnswerLinkedObject,
  semanticFactText,
} from './fact-quality.js';
import {
  inferHomeAssistantAnswerScope,
  nodeInHomeAssistantAnswerScope,
  sourceInHomeAssistantAnswerScope,
} from './homeassistant-scope.js';
import { concreteAnswerGapSpaceId } from './answer-space.js';
import { answerNeedsFeatureGap, cleanSynthesizedAnswer } from './answer-quality.js';
import { clampTimeoutMs, withTimeoutOrNull } from './timeouts.js';
import { renderFallbackAnswer } from './answer-fallback.js';
import { rankAnswerSources, sourceAuthorityBoostForAnswer } from './answer-source-ranking.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';

interface KnowledgeAnswerContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null;
}

interface EvidenceItem {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly title: string;
  readonly score: number;
  readonly source?: KnowledgeSourceRecord;
  readonly node?: KnowledgeNodeRecord;
  readonly excerpt?: string;
  readonly facts: readonly KnowledgeNodeRecord[];
}

const GENERIC_ANSWER_INTENT_TOKENS = new Set([
  'capabilities',
  'capability',
  'configuration',
  'configure',
  'device',
  'feature',
  'features',
  'function',
  'functions',
  'install',
  'mode',
  'modes',
  'procedure',
  'setting',
  'settings',
  'setup',
  'spec',
  'specification',
  'specifications',
  'specs',
  'object',
  'support',
  'supported',
  'supports',
  'thing',
]);

export async function answerKnowledgeQuery(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
): Promise<KnowledgeSemanticAnswerResult> {
  const spaceId = normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const mode = input.mode ?? 'standard';
  const limit = Math.max(1, input.limit ?? 8);
  let evidence = collectAnswerEvidence(context.store, input, spaceId, limit);
  if (evidence.length === 0) {
    const linkedObjects = input.includeLinkedObjects === false ? [] : filterAnswerLinkedObjects(spaceId, input.query, [...(input.linkedObjects ?? [])]);
    const linkedEvidence = includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit);
    if (linkedEvidence.length > 0) {
      evidence = linkedEvidence;
    } else {
      const gap = shouldPersistNoMatchGap(spaceId, input.query, linkedObjects)
        ? await persistAnswerGap(context.store, concreteAnswerGapSpaceId(spaceId, [], [], linkedObjects), input.query, 'No indexed evidence matched the question.', {
            linkedObjects,
          })
        : null;
      return {
        ok: true,
        spaceId,
        query: input.query,
        answer: {
          text: input.noMatchMessage ?? `No knowledge matched "${input.query}".`,
          mode,
          confidence: 0,
          sources: [],
          linkedObjects,
          facts: [],
          gaps: gap ? [gap] : [],
          synthesized: false,
        },
        results: [],
      };
    }
  }

  let rawFacts = filterFactsForQuery(input.query, uniqueNodes(evidence.flatMap((item) => item.facts))).slice(0, 24);
  const inferredHomeAssistantLinkedObjects = input.includeLinkedObjects === false
    ? []
    : inferHomeAssistantLinkedObjects(context.store, spaceId, input.query);
  const evidenceLinkedObjects = shouldUseEvidenceLinkedObjects(spaceId, input, inferredHomeAssistantLinkedObjects)
    ? evidence.flatMap((item) => item.node ? [item.node] : [])
    : [];
  const rawLinkedObjects = input.includeLinkedObjects === false
    ? []
    : uniqueNodes([
      ...(input.linkedObjects ?? []),
      ...evidenceLinkedObjects,
      ...inferredHomeAssistantLinkedObjects,
    ])
      .filter(isSemanticAnswerLinkedObject)
      .slice(0, 24);
  const linkedObjects = filterAnswerLinkedObjects(spaceId, input.query, rawLinkedObjects);
  evidence = includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit);
  rawFacts = filterFactsForQuery(input.query, uniqueNodes(evidence.flatMap((item) => item.facts))).slice(0, 24);
  const llmAnswer = await synthesizeAnswer(context.llm ?? null, input.query, mode, evidence, input.timeoutMs);
  const rankedSources = rankAnswerSources(evidence, rawFacts);
  const facts = withAnswerFactContract(context.store, rawFacts, linkedObjects);
  const sources = includeOfficialLinkedSources(context.store, spaceId, rankedSources, linkedObjects)
    .slice(0, limit)
    .map(withAnswerSourceAliases);
  const gapSpaceId = concreteAnswerGapSpaceId(spaceId, evidence, sources, linkedObjects);
  const gaps = await persistAnswerGaps(context.store, gapSpaceId, input.query, llmAnswer?.gaps ?? [], {
    sources,
    linkedObjects,
  });
  const featureIntent = hasFeatureIntentForQuery(input.query);
  const evidenceGap = featureIntent && answerNeedsFeatureGap({
    query: input.query,
    text: llmAnswer?.answer,
    facts,
    sources,
    linkedObjects,
  })
    ? await persistAnswerGap(context.store, gapSpaceId, input.query, 'Evidence matched the subject but did not include enough concrete source-backed feature or specification facts.', {
        sources,
        linkedObjects,
      })
    : null;
  const llmText = llmAnswer?.answer?.trim();
  const cleanedLlmText = llmText ? cleanSynthesizedAnswer(llmText, featureIntent) : undefined;
  const dropLowValueLlmAnswer = featureIntent && Boolean(cleanedLlmText) && isLowValueFeatureOrSpecText(cleanedLlmText ?? '');
  const fallback = renderFallbackAnswer(input.query, mode, evidence, facts);
  const preferFallback = shouldPreferFallbackAnswer(featureIntent, cleanedLlmText, fallback.text);
  const useFallback = dropLowValueLlmAnswer || preferFallback || !cleanedLlmText;
  const text = cleanSynthesizedAnswer((useFallback ? fallback.text : cleanedLlmText) || '', featureIntent);
  const synthesized = useFallback ? fallback.synthesized : Boolean(cleanedLlmText);
  const confidence = input.includeConfidence === false
    ? 0
    : dropLowValueLlmAnswer || (useFallback && !fallback.synthesized) ? 0 : answerConfidence(preferFallback ? null : llmAnswer, evidence);
  return {
    ok: true,
    spaceId,
    query: input.query,
    answer: {
      text,
      mode,
      confidence,
      sources: input.includeSources === false ? [] : sources,
      linkedObjects,
      facts,
      gaps: evidenceGap ? uniqueNodes([...gaps, evidenceGap]) : gaps,
      synthesized,
    },
    results: evidence.map(toSearchResult),
  };
}

function shouldPersistNoMatchGap(
  spaceId: string,
  query: string,
  linkedObjects: readonly KnowledgeNodeRecord[],
): boolean {
  if (linkedObjects.length > 0) return true;
  if (normalizeKnowledgeSpaceId(spaceId) !== 'homeassistant') return true;
  const subjectTokens = tokenizeSemanticQuery(query).filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  return subjectTokens.length > 0;
}

function collectAnswerEvidence(
  store: KnowledgeStore,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  limit: number,
): EvidenceItem[] {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(input.query));
  if (tokens.length === 0) return [];
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  const candidateSourceIds = new Set(input.candidateSourceIds ?? []);
  const candidateNodeIds = new Set(input.candidateNodeIds ?? []);
  const linkedObjectIds = new Set((input.linkedObjects ?? []).map((node) => node.id));
  const strictCandidates = input.strictCandidates === true && (candidateSourceIds.size > 0 || candidateNodeIds.size > 0);
  const sourceFacts = buildSourceFactIndex(store, spaceId);
  const linkedSourceIds = sourceIdsLinkedToNodes(store, new Set([...candidateNodeIds, ...linkedObjectIds]), spaceId);
  const broadHomeAssistantAlias = normalizeKnowledgeSpaceId(spaceId) === 'homeassistant' && !strictCandidates;
  if (broadHomeAssistantAlias && subjectTokens.length === 0 && linkedObjectIds.size === 0) return [];
  const homeAssistantScope = !strictCandidates
    ? inferHomeAssistantAnswerScope(store, spaceId, input.query, subjectTokens)
    : null;

  const sourceItems = store.listSources(10_000)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceInHomeAssistantAnswerScope(store, source, homeAssistantScope))
    .filter((source) => !strictCandidates || candidateSourceIds.has(source.id) || linkedSourceIds.has(source.id))
    .map((source) => {
      const extraction = store.getExtractionBySourceId(source.id);
      const facts = filterFactsForQuery(input.query, sourceFacts.get(source.id) ?? []);
      const text = sourceSemanticText(source, extraction);
      const scoringText = [
        source.title,
        source.summary,
        source.description,
        source.tags.join(' '),
        text,
        facts.map(renderFactForScoring).join(' '),
      ].join('\n');
      const baseScore = scoreSemanticText(scoringText, tokens);
      const subjectScore = subjectTokens.length > 0 ? scoreSemanticText(scoringText, subjectTokens) : 0;
      const homeAssistantPenalty = broadHomeAssistantAlias && subjectScore === 0 ? 120 : 0;
      const candidateBoost = candidateSourceIds.has(source.id) ? 220 : 0;
      const linkedBoost = linkedSourceIds.has(source.id) ? 160 : 0;
      const genericOnly = subjectTokens.length > 0 && subjectScore === 0;
      const weakStrictCandidate = strictCandidates
        && candidateSourceIds.size > 1
        && candidateSourceIds.has(source.id)
        && !linkedSourceIds.has(source.id)
        && genericOnly;
      const weakBroadMatch = !strictCandidates && genericOnly;
      const score = weakStrictCandidate || weakBroadMatch
        ? 0
        : baseScore + candidateBoost + linkedBoost + Math.min(60, facts.length * 6) - homeAssistantPenalty;
      return {
        kind: 'source' as const,
        id: source.id,
        title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
        score,
        source,
        excerpt: selectEvidenceExcerpt(input.query, text, facts),
        facts,
      };
    });

  const nodeItems = store.listNodes(10_000)
    .filter((node) => belongsToAnswerSpace(node, spaceId) && node.status !== 'stale')
    .filter((node) => nodeInHomeAssistantAnswerScope(node, homeAssistantScope))
    .filter((node) => !strictCandidates
      || candidateNodeIds.has(node.id)
      || linkedObjectIds.has(node.id)
      || (typeof node.sourceId === 'string' && candidateSourceIds.has(node.sourceId)))
    .map((node) => {
      const scoringText = [
        node.title,
        node.summary,
        node.aliases.join(' '),
        JSON.stringify(node.metadata),
      ].join('\n');
      const baseScore = scoreSemanticText(scoringText, tokens);
      const subjectScore = subjectTokens.length > 0 ? scoreSemanticText(scoringText, subjectTokens) : 0;
      const homeAssistantPenalty = broadHomeAssistantAlias && subjectScore === 0 ? 100 : 0;
      const genericOnly = subjectTokens.length > 0 && subjectScore === 0;
      const candidateOrLinked = candidateNodeIds.has(node.id) || linkedObjectIds.has(node.id);
      const score = genericOnly && !candidateOrLinked
        ? 0
        : baseScore + (candidateOrLinked ? 120 : 0) + semanticKindBoost(node) - homeAssistantPenalty;
      return {
        kind: 'node' as const,
        id: node.id,
        title: node.title,
        score,
        node,
        excerpt: renderNodeEvidence(node),
        facts: node.metadata.semanticKind === 'fact' ? [node] : [],
      };
    });

  const items = [...sourceItems, ...nodeItems]
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return pruneEvidence(items, limit, broadHomeAssistantAlias);
}

function inferHomeAssistantLinkedObjects(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
): KnowledgeNodeRecord[] {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  const scope = inferHomeAssistantAnswerScope(store, spaceId, query, subjectTokens);
  if (!scope || scope.anchorNodeIds.size === 0) return [];
  return store.listNodes(10_000)
    .filter((node) => scope.anchorNodeIds.has(node.id))
    .filter((node) => belongsToAnswerSpace(node, spaceId))
    .filter(isSemanticAnswerLinkedObject);
}

function filterAnswerLinkedObjects(
  spaceId: string,
  query: string,
  nodes: readonly KnowledgeNodeRecord[],
): readonly KnowledgeNodeRecord[] {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (normalized !== 'homeassistant' && !isHomeAssistantKnowledgeSpace(normalized)) return nodes;
  const canonical = canonicalRepairSubjectNodes({ nodes, text: query });
  if (canonical.length > 0) return canonical.slice(0, 24);
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(query);
  return nodes.filter((node) => integrationIntent || node.kind !== 'ha_integration').slice(0, 24);
}

function shouldUseEvidenceLinkedObjects(
  spaceId: string,
  input: KnowledgeSemanticAnswerInput,
  inferredHomeAssistantLinkedObjects: readonly KnowledgeNodeRecord[],
): boolean {
  if (input.linkedObjects?.length) return true;
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (normalized === 'homeassistant' || isHomeAssistantKnowledgeSpace(normalized)) {
    return inferredHomeAssistantLinkedObjects.length > 0;
  }
  return true;
}

type AnswerFactRecord = KnowledgeNodeRecord & {
  readonly subject?: string;
  readonly subjectIds?: readonly string[];
  readonly targetHints?: readonly Record<string, unknown>[];
  readonly linkedObjectIds?: readonly string[];
};

function withAnswerFactContract(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly AnswerFactRecord[] {
  if (facts.length === 0) return [];
  const linkedObjectIds = new Set(linkedObjects.map((node) => node.id));
  return facts.map((fact) => {
    const source = fact.sourceId ? store.getSource(fact.sourceId) : null;
    const discovery = readRecord(source?.metadata.sourceDiscovery);
    const metadataLinkedIds = uniqueStrings([
      ...readStringArray(fact.metadata.linkedObjectIds),
      ...readStringArray(fact.metadata.subjectIds),
      ...readStringArray(discovery.linkedObjectIds),
    ]);
    const subjectIds = metadataLinkedIds.filter((id) => linkedObjectIds.has(id));
    const fallbackSubjectIds = subjectIds.length > 0
      ? subjectIds
      : linkedObjects.length === 1 ? [linkedObjects[0]!.id] : [];
    const subjects = fallbackSubjectIds
      .map((id) => linkedObjects.find((node) => node.id === id) ?? store.getNode(id))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node && node.status !== 'stale'));
    if (subjects.length === 0) return fact as AnswerFactRecord;
    const targetHints = answerTargetHints(subjects);
    const metadata = {
      ...fact.metadata,
      subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
      subjectIds: subjects.map((node) => node.id),
      linkedObjectIds: subjects.map((node) => node.id),
      targetHints,
    };
    return {
      ...fact,
      metadata,
      subject: metadata.subject as string | undefined,
      subjectIds: metadata.subjectIds as readonly string[],
      linkedObjectIds: metadata.linkedObjectIds as readonly string[],
      targetHints,
    };
  });
}

function answerTargetHints(nodes: readonly KnowledgeNodeRecord[]): readonly Record<string, unknown>[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(node.summary ? { summary: node.summary } : {}),
  }));
}

function includeOfficialLinkedSources(
  store: KnowledgeStore,
  spaceId: string,
  rankedSources: readonly KnowledgeSourceRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly KnowledgeSourceRecord[] {
  if (linkedObjects.length === 0) return rankedSources;
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const linkedSourceIds = sourceIdsLinkedToNodes(store, linkedIds, spaceId);
  const official = store.listSources(10_000)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceAuthorityBoostForAnswer(source) > 0)
    .filter((source) => {
      const discovery = readRecord(source.metadata.sourceDiscovery);
      return linkedSourceIds.has(source.id)
        || readStringArray(discovery.linkedObjectIds).some((id) => linkedIds.has(id));
    })
    .sort((left, right) => sourceAuthorityBoostForAnswer(right) - sourceAuthorityBoostForAnswer(left));
  return uniqueSources([...official, ...rankedSources]);
}

function includeOfficialLinkedEvidence(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  evidence: readonly EvidenceItem[],
  linkedObjects: readonly KnowledgeNodeRecord[],
  limit: number,
): EvidenceItem[] {
  if (linkedObjects.length === 0) return [...evidence];
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const linkedSourceIds = sourceIdsLinkedToNodes(store, linkedIds, spaceId);
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const sourceFacts = buildSourceFactIndex(store, spaceId);
  const officialItems = store.listSources(10_000)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceAuthorityBoostForAnswer(source) > 0)
    .filter((source) => linkedSourceIds.has(source.id) || readStringArray(readRecord(source.metadata.sourceDiscovery).linkedObjectIds).some((id) => linkedIds.has(id)))
    .map((source) => {
      const extraction = store.getExtractionBySourceId(source.id);
      const facts = filterFactsForQuery(query, sourceFacts.get(source.id) ?? []);
      const text = sourceSemanticText(source, extraction);
      const scoringText = [
        source.title,
        source.summary,
        source.description,
        source.tags.join(' '),
        text,
        facts.map(renderFactForScoring).join(' '),
      ].join('\n');
      const semanticScore = scoreSemanticText(scoringText, tokens);
      return {
        kind: 'source' as const,
        id: source.id,
        title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
        score: semanticScore + sourceAuthorityBoostForAnswer(source) + Math.min(80, facts.length * 10),
        source,
        excerpt: selectEvidenceExcerpt(query, text, facts),
        facts,
      };
    })
    .filter((item) => item.score > 0);
  if (officialItems.length === 0) return [...evidence];
  return uniqueEvidenceItems([...officialItems, ...evidence]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)))
    .slice(0, Math.max(limit, evidence.length, 1));
}

function shouldPreferFallbackAnswer(featureIntent: boolean, llmText: string | undefined, fallbackText: string): boolean {
  if (!featureIntent || !fallbackText) return false;
  if (!llmText) return true;
  const lower = llmText.toLowerCase();
  if (isLowValueFeatureOrSpecText(llmText)) return true;
  if (/\b(source-backed facts identify|available source-backed details include|matching sources exist|not enough source-backed facts|not enough concrete source-backed)\b/.test(lower)) {
    return hasConcreteFeatureSignal(fallbackText);
  }
  if (/\bevidence\b/.test(lower) && featureFamilyCount(fallbackText) >= 2) return true;
  if (featureFamilyCount(llmText) < 2 && featureFamilyCount(fallbackText) >= 2) return true;
  return false;
}

function featureFamilyCount(text: string): number {
  const lower = text.toLowerCase();
  return [
    /\b(hdmi|earc|arc|ports?|usb|ethernet|optical|rf|antenna|rs-?232c?)\b/,
    /\b(hdr|hdr10|dolby vision|hlg|filmmaker)\b/,
    /\b(4k|8k|uhd|resolution|refresh|120\s*hz|100\s*hz|nanocell|display|screen)\b/,
    /\b(webos|apps?|streaming|airplay|homekit|chromecast|smart tv|thinq)\b/,
    /\b(wi-?fi|bluetooth|wireless lan)\b/,
    /\b(audio|speakers?|dolby atmos|sound)\b/,
    /\b(game|gaming|vrr|allm|freesync|g-sync)\b/,
    /\b(tuner|atsc|qam|ntsc|broadcast)\b/,
  ].filter((pattern) => pattern.test(lower)).length;
}

async function synthesizeAnswer(
  llm: KnowledgeSemanticLlm | null,
  query: string,
  mode: string,
  evidence: readonly EvidenceItem[],
  requestedTimeoutMs: number | undefined,
): Promise<KnowledgeSemanticLlmAnswer | null> {
  if (!llm) return null;
  const timeoutMs = clampTimeoutMs(requestedTimeoutMs, 15_000, 1_000, 15_000);
  const controller = new AbortController();
  const response = await withTimeoutOrNull(llm.completeJson({
    purpose: 'knowledge-answer-synthesis',
    maxTokens: mode === 'detailed' ? 2200 : mode === 'concise' ? 700 : 1400,
    signal: controller.signal,
    timeoutMs,
    systemPrompt: [
      'You answer questions from a GoodVibes self-improving knowledge wiki.',
      'Use only the supplied evidence. Synthesize the answer for the user intent rather than dumping snippets.',
      'If evidence is insufficient, say what is missing. Prefer concrete features, specs, procedures, and relationships.',
      'For feature or specification questions, ignore manual boilerplate about accessories, cable recommendations, USB/HDMI physical-fit guidance, button maps, remote aiming instructions, batteries, cleaning, servicing, safety, furniture, wall mounting, and future product changes unless the user asks about those topics.',
      'Do not mention future features, specifications changing without notice, cable fit, USB extension cables, remote sensor aiming, service personnel, or child-safety/furniture/platform guidance in a feature/spec answer.',
      'Return only JSON with answer, confidence, usedSourceIds, usedNodeIds, and optional gaps.',
    ].join(' '),
    prompt: JSON.stringify({
      query,
      mode,
      evidence: renderEvidenceForPrompt(evidence),
      outputShape: {
        answer: 'source-backed natural language answer',
        confidence: 0,
        usedSourceIds: ['source ids used'],
        usedNodeIds: ['node ids used'],
        gaps: [{ question: 'unanswered follow-up gap', reason: 'missing evidence', severity: 'info' }],
      },
    }),
  }), timeoutMs);
  controller.abort();
  return normalizeLlmAnswer(response);
}

function renderEvidenceForPrompt(evidence: readonly EvidenceItem[]): readonly Record<string, unknown>[] {
  let budget = MAX_ANSWER_EVIDENCE_CHARS;
  const rendered: Record<string, unknown>[] = [];
  for (const item of evidence.slice(0, 12)) {
    if (budget <= 0) break;
    const factText = item.facts.slice(0, 16).map(renderFactForPrompt).join('\n');
    const excerpt = clampText(item.excerpt, Math.min(1600, budget));
    const record = {
      kind: item.kind,
      id: item.id,
      title: item.title,
      sourceId: item.source?.id,
      nodeId: item.node?.id,
      sourceType: item.source?.sourceType,
      nodeKind: item.node?.kind,
      excerpt,
      facts: factText,
    };
    budget -= JSON.stringify(record).length;
    rendered.push(record);
  }
  return rendered;
}

function filterFactsForQuery(query: string, facts: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const tokens = tokenizeSemanticQuery(query);
  const intent = factIntent(tokens);
  const matching = intent
    ? facts.filter((fact) => intent.has(readString(fact.metadata.factKind) ?? 'note'))
    : [...facts];
  return matching
    .filter((fact) => fact.status !== 'stale' && !isLowValueFactForQuery(tokens, intent, fact))
    .sort(compareFactQuality);
}

function factIntent(tokens: readonly string[]): ReadonlySet<string> | null {
  const tokenSet = new Set(tokens);
  if (hasAny(tokenSet, ['feature', 'features', 'capability', 'capabilities', 'function', 'functions', 'support', 'supports', 'spec', 'specs', 'specification', 'specifications'])) {
    return new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity']);
  }
  if (hasAny(tokenSet, ['reset', 'setup', 'install', 'configure', 'pair'])) {
    return new Set(['procedure', 'configuration', 'troubleshooting']);
  }
  if (hasAny(tokenSet, ['battery', 'filter', 'maintenance', 'warranty', 'replace', 'clean'])) {
    return new Set(['maintenance', 'specification', 'warning']);
  }
  if (hasAny(tokenSet, ['warning', 'caution', 'risk', 'hazard'])) return new Set(['warning']);
  return null;
}

function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function isLowValueFactForQuery(
  tokens: readonly string[],
  intent: ReadonlySet<string> | null,
  fact: KnowledgeNodeRecord,
): boolean {
  if (!intent || !hasFeatureIntent(intent)) return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity'].includes(kind)) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text)) return true;
  const extractor = readString(fact.metadata.extractor);
  const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0;
  if (extractor !== 'deterministic' || confidence > 60) return false;
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  return subjectTokens.length > 0 && !hasConcreteFeatureSignal(text);
}

function hasFeatureIntent(intent: ReadonlySet<string>): boolean {
  return intent.has('feature') || intent.has('capability') || intent.has('specification') || intent.has('compatibility');
}

function hasFeatureIntentForQuery(query: string): boolean {
  const intent = factIntent(tokenizeSemanticQuery(query));
  return Boolean(intent && hasFeatureIntent(intent));
}

function compareFactQuality(left: KnowledgeNodeRecord, right: KnowledgeNodeRecord): number {
  return factQuality(right) - factQuality(left) || left.title.localeCompare(right.title);
}

function factQuality(fact: KnowledgeNodeRecord): number {
  const extractor = readString(fact.metadata.extractor);
  const kind = readString(fact.metadata.factKind);
  const value = readString(fact.metadata.value);
  const authority = readString(fact.metadata.sourceAuthority);
  return (extractor === 'llm' ? 40 : 0)
    + (extractor === 'repair-promotion' ? 34 : 0)
    + (authority === 'official-vendor' ? 24 : authority === 'vendor' ? 14 : 0)
    + (value ? 12 : 0)
    + (kind === 'capability' || kind === 'feature' ? 8 : kind === 'specification' ? 6 : 0)
    + Math.round(fact.confidence / 10);
}

async function persistAnswerGap(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  reason: string,
  context: {
    readonly subject?: string;
    readonly sources?: readonly KnowledgeSourceRecord[];
    readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  } = {},
): Promise<KnowledgeNodeRecord> {
  const linkedObjects = context.linkedObjects ?? [];
  const sources = context.sources ?? [];
  const subject = context.subject ?? linkedObjects[0]?.title;
  const fingerprint = answerGapFingerprint(spaceId, query, subject, linkedObjects[0]?.id);
  const id = `sem-answer-gap-${fingerprint}`;
  const existing = store.getNode(id);
  const node = await store.upsertNode({
    id,
    kind: 'knowledge_gap',
    slug: `answer-gap-${fingerprint}`,
    title: query,
    summary: reason,
    confidence: 70,
    ...(sources[0] ? { sourceId: sources[0].id } : {}),
    metadata: semanticMetadata(spaceId, {
      semanticKind: 'gap',
      gapKind: 'answer',
      query,
      reason,
      subject,
      subjectFingerprint: fingerprint,
      sourceIds: sources.map((source) => source.id),
      linkedObjectIds: linkedObjects.map((node) => node.id),
      repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
      visibility: 'refinement',
      displayRole: 'knowledge-gap',
    }),
  });
  for (const source of sources) {
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { gapKind: 'answer' }),
    });
  }
  for (const object of linkedObjects) {
    await store.upsertEdge({
      fromKind: 'node',
      fromId: object.id,
      toKind: 'node',
      toId: node.id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { gapKind: 'answer' }),
    });
  }
  if (!isRepairedAnswerGap(node)) {
    await store.upsertIssue({
      id: `sem-answer-gap-issue-${fingerprint}`,
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: `No knowledge answer available for: ${query}`,
      status: 'open',
      ...(sources[0] ? { sourceId: sources[0].id } : {}),
      nodeId: node.id,
      metadata: semanticMetadata(spaceId, {
        namespace: `knowledge:${spaceId}:answers`,
        query,
        reason,
        subject,
        subjectFingerprint: fingerprint,
        sourceIds: sources.map((source) => source.id),
        linkedObjectIds: linkedObjects.map((entry) => entry.id),
      }),
    });
  } else {
    await resolveAnswerGapIssues(store, spaceId, node.id);
  }
  return node;
}

async function persistAnswerGaps(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  gaps: readonly KnowledgeSemanticGapInput[],
  context: {
    readonly sources?: readonly KnowledgeSourceRecord[];
    readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  } = {},
): Promise<readonly KnowledgeNodeRecord[]> {
  const nodes: KnowledgeNodeRecord[] = [];
  for (const gap of gaps.slice(0, 8)) {
    const node = await persistAnswerGap(store, spaceId, gap.question || query, gap.reason ?? 'Answer synthesis identified a missing knowledge gap.', {
      ...context,
      ...(gap.subject ? { subject: gap.subject } : {}),
    });
    if (!isRepairedAnswerGap(node)) nodes.push(node);
  }
  return nodes;
}

function isRepairedAnswerGap(node: KnowledgeNodeRecord): boolean {
  const repairStatus = readString(node.metadata.repairStatus);
  return node.status === 'stale' || repairStatus === 'repaired' || repairStatus === 'not_applicable';
}

async function resolveAnswerGapIssues(store: KnowledgeStore, spaceId: string, nodeId: string): Promise<void> {
  for (const issue of store.listIssues(10_000).filter((entry) => entry.nodeId === nodeId && entry.status === 'open')) {
    await store.upsertIssue({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      status: 'resolved',
      sourceId: issue.sourceId,
      nodeId: issue.nodeId,
      metadata: semanticMetadata(spaceId, {
        ...issue.metadata,
        resolution: {
          reason: 'Answer gap already has accepted repair evidence.',
          resolvedBy: 'knowledge-answer',
          resolvedAt: Date.now(),
        },
      }),
    });
  }
}

function answerGapFingerprint(spaceId: string, query: string, subject?: string, subjectId?: string): string {
  return semanticHash(spaceId, subjectId ?? normalizeGapSubject(subject), answerGapIntent(query));
}

function normalizeGapSubject(subject: string | undefined): string {
  return normalizeWhitespace(subject ?? 'unscoped').toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unscoped';
}

function answerGapIntent(query: string): string {
  const tokens = new Set(tokenizeSemanticQuery(query));
  if (hasAny(tokens, ['feature', 'features', 'capability', 'capabilities', 'function', 'functions', 'spec', 'specs', 'specification', 'specifications'])) {
    return 'features-specifications';
  }
  if (hasAny(tokens, ['battery', 'batteries'])) return 'battery';
  if (hasAny(tokens, ['manual', 'documentation', 'source', 'sources'])) return 'source-documentation';
  return uniqueStrings([...tokens].filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token)).sort()).slice(0, 8).join('-') || 'general';
}

function buildSourceFactIndex(store: KnowledgeStore, spaceId: string): Map<string, KnowledgeNodeRecord[]> {
  const facts = store.listNodes(10_000).filter((node) => (
    node.status !== 'stale' && node.metadata.semanticKind === 'fact' && belongsToAnswerSpace(node, spaceId)
  ));
  const bySource = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of facts) {
    const sourceId = readString(fact.metadata.sourceId) ?? fact.sourceId;
    if (!sourceId) continue;
    bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), fact]);
  }
  return bySource;
}

function sourceIdsLinkedToNodes(store: KnowledgeStore, nodeIds: ReadonlySet<string>, spaceId: string): Set<string> {
  const sourceIds = new Set<string>();
  if (nodeIds.size === 0) return sourceIds;
  const edges = store.listEdges();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source') sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && nodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && factIds.has(edge.toId) && edge.relation === 'supports_fact') {
      sourceIds.add(edge.fromId);
    }
  }
  return sourceIds;
}

function selectEvidenceExcerpt(
  query: string,
  text: string,
  facts: readonly KnowledgeNodeRecord[],
): string {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const intent = factIntent(tokenizeSemanticQuery(query));
  const featureIntent = Boolean(intent && hasFeatureIntent(intent));
  const evidenceText = stripEvidenceRoutingFragments(text);
  const factLines = facts
    .map(renderFactForPrompt)
    .filter((line) => scoreSemanticText(line, tokens) > 0)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 12);
  const windows = evidenceWindows(evidenceText, tokens)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 4);
  const fallback = featureIntent && (factLines.length > 0 || windows.length > 0) ? [] : [clampText(evidenceText, 720)];
  return uniqueStrings([...factLines, ...windows, ...fallback]).join('\n');
}

function stripEvidenceRoutingFragments(text: string): string {
  return normalizeWhitespace(text
    .replace(/homegraph:\/\/\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bgenerated-page\b/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' '));
}

function evidenceWindows(text: string, tokens: readonly string[]): string[] {
  const normalized = normalizeWhitespace(text);
  const sentences = splitSentences(normalized, 420);
  const sentenceMatches = sentences.filter((sentence) => scoreSemanticText(sentence, tokens) > 0);
  if (sentenceMatches.length > 0) return uniqueStrings(sentenceMatches).slice(0, 12);
  const lower = normalized.toLowerCase();
  const windows: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = lower.indexOf(token);
    if (index < 0) continue;
    const start = Math.max(0, normalized.lastIndexOf('.', index - 1) + 1, index - 160);
    const nextPeriod = normalized.indexOf('.', index + token.length);
    const end = nextPeriod >= 0 ? Math.min(normalized.length, nextPeriod + 1) : Math.min(normalized.length, index + 360);
    windows.push(`${start > 0 ? '...' : ''}${normalized.slice(start, end).trim()}${end < normalized.length ? '...' : ''}`);
  }
  return uniqueStrings(windows);
}

function expandQueryTokens(tokens: readonly string[]): string[] {
  const expansions: Record<string, readonly string[]> = {
    capabilities: ['capability', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    capability: ['capabilities', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    feature: ['features', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    features: ['feature', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    settings: ['configuration', 'configure', 'options'],
    setup: ['install', 'configure', 'pair'],
  };
  return uniqueStrings(tokens.flatMap((token) => [token, ...(expansions[token] ?? [])]));
}

function pruneEvidence(items: readonly EvidenceItem[], limit: number, strictTopCluster = false): EvidenceItem[] {
  const sourceSeen = new Set<string>();
  const nodeSeen = new Set<string>();
  const out: EvidenceItem[] = [];
  const topScore = items[0]?.score ?? 0;
  const minScore = strictTopCluster ? Math.max(1, topScore - 90) : 1;
  for (const item of items) {
    if (item.score < minScore) continue;
    if (item.kind === 'source') {
      if (sourceSeen.has(item.id)) continue;
      sourceSeen.add(item.id);
    } else {
      if (nodeSeen.has(item.id)) continue;
      nodeSeen.add(item.id);
    }
    out.push(item);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

function toSearchResult(item: EvidenceItem): KnowledgeSearchResult {
  return {
    kind: item.kind,
    id: item.id,
    score: item.score,
    reason: 'semantic evidence match',
    ...(item.source ? { source: item.source } : {}),
    ...(item.node ? { node: item.node } : {}),
  };
}

function normalizeLlmAnswer(value: unknown): KnowledgeSemanticLlmAnswer | null {
  const record = readRecord(value);
  const answer = readString(record.answer);
  if (!answer) return null;
  return {
    answer,
    ...(typeof record.confidence === 'number' ? { confidence: Math.max(0, Math.min(100, Math.round(record.confidence))) } : {}),
    usedSourceIds: readStringArray(record.usedSourceIds),
    usedNodeIds: readStringArray(record.usedNodeIds),
    gaps: readGapArray(record.gaps),
  };
}

function answerConfidence(answer: KnowledgeSemanticLlmAnswer | null, evidence: readonly EvidenceItem[]): number {
  if (typeof answer?.confidence === 'number') return answer.confidence;
  const top = evidence[0]?.score ?? 0;
  const factBoost = Math.min(35, uniqueNodes(evidence.flatMap((item) => item.facts)).length * 4);
  return Math.max(10, Math.min(92, Math.round(top / 5) + factBoost));
}

function renderFactForScoring(fact: KnowledgeNodeRecord): string {
  return [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    readString(fact.metadata.evidence),
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function renderFactForPrompt(fact: KnowledgeNodeRecord): string {
  const kind = readString(fact.metadata.factKind) ?? 'fact';
  const value = readString(fact.metadata.value);
  const evidence = readString(fact.metadata.evidence);
  return `${kind}: ${fact.title}${value ? ` = ${value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}${evidence ? ` Evidence: ${evidence}` : ''}`;
}

function renderNodeEvidence(node: KnowledgeNodeRecord): string {
  if (node.metadata.semanticKind === 'fact') return renderFactForPrompt(node);
  if (node.metadata.semanticKind === 'wiki_page') return readString(node.metadata.markdown) ?? node.summary ?? '';
  return [node.summary, node.aliases.join(', ')].filter(Boolean).join('\n');
}

function semanticKindBoost(node: KnowledgeNodeRecord): number {
  if (node.metadata.semanticKind === 'fact') return 45;
  if (node.metadata.semanticKind === 'wiki_page') return 24;
  if (node.metadata.semanticKind === 'entity') return 18;
  return 0;
}

function belongsToAnswerSpace(
  record: { readonly metadata?: Record<string, unknown> } | undefined | null,
  spaceId: string,
): boolean {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const recordSpaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(record));
  if (normalized === 'default') return recordSpaceId === 'default';
  if (normalized === 'homeassistant') return isHomeAssistantKnowledgeSpace(recordSpaceId);
  return isInKnowledgeSpace(record, normalized);
}

function uniqueNodes(nodes: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeNodeRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function uniqueSources(sources: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceRecord[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    out.push(source);
  }
  return out;
}

function uniqueEvidenceItems(items: readonly EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return {
    ...source,
    sourceId: source.id,
    url: source.sourceUri ?? source.canonicalUri,
  };
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((entry) => typeof entry === 'string' ? entry : undefined))
    : [];
}

function readGapArray(value: unknown): readonly KnowledgeSemanticGapInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const question = readString(record.question);
    if (!question) return [];
    const severity = readString(record.severity);
    return [{
      question,
      ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
      ...(readString(record.subject) ? { subject: readString(record.subject) } : {}),
      severity: severity === 'warning' || severity === 'error' ? severity : 'info',
    }];
  });
}
