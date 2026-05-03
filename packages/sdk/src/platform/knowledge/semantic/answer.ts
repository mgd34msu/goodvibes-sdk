import type {
  KnowledgeNodeRecord,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { normalizeKnowledgeSpaceId } from '../spaces.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticLlmAnswer,
} from './types.js';
import {
  readRecord,
  readString,
  readStringArray,
  uniqueStrings,
} from './utils.js';
import {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  isSemanticAnswerLinkedObject,
} from './fact-quality.js';
import { concreteAnswerGapSpaceId } from './answer-space.js';
import { answerNeedsFeatureGap, cleanSynthesizedAnswer } from './answer-quality.js';
import { renderFallbackAnswer } from './answer-fallback.js';
import { rankAnswerSources } from './answer-source-ranking.js';
import {
  type AnswerFactRecord,
  type EvidenceItem,
  type KnowledgeAnswerContext,
} from './answer-common.js';
import {
  filterFactsForQuery,
  hasFeatureIntentForQuery,
} from './answer-fact-selection.js';
import {
  collectAnswerEvidence,
  filterAnswerLinkedObjects,
  includeOfficialLinkedEvidence,
  includeOfficialLinkedSources,
  inferObjectLinkedObjects,
  shouldUseEvidenceLinkedObjects,
  toSearchResult,
  uniqueNodes,
  withAnswerSourceAliases,
} from './answer-evidence.js';
import {
  isRepairedAnswerGap,
  persistAnswerGap,
  persistAnswerGaps,
  shouldPersistNoMatchGap,
} from './answer-gaps.js';
import { answerConfidence, synthesizeAnswer } from './answer-llm.js';

export async function answerKnowledgeQuery(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
): Promise<KnowledgeSemanticAnswerResult> {
  const spaceId = normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const mode = input.mode ?? 'standard';
  const limit = Math.max(1, input.limit ?? 8);
  const objectProfiles = context.objectProfiles ?? [];
  const evidenceResolution = await resolveAnswerEvidence(context, input, spaceId, mode, limit, objectProfiles);
  if (evidenceResolution.kind === 'no-match') return evidenceResolution.result;

  let evidence = evidenceResolution.evidence;
  let rawFacts = collectRawAnswerFacts(input.query, evidence);
  const linkedObjects = resolveAnswerLinkedObjects(context, input, spaceId, evidence, rawFacts, objectProfiles);
  evidence = includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit);
  rawFacts = collectRawAnswerFacts(input.query, evidence);
  const llmAnswer = await synthesizeAnswer(context.llm ?? null, input.query, mode, evidence, input.timeoutMs);
  const rankedSources = rankAnswerSources(evidence, rawFacts);
  const facts = withAnswerFactContract(context.store, rawFacts, linkedObjects);
  const sources = includeOfficialLinkedSources(context.store, spaceId, rankedSources, linkedObjects)
    .slice(0, limit)
    .map(withAnswerSourceAliases);
  const gapSpaceId = concreteAnswerGapSpaceId(spaceId, evidence, sources, linkedObjects);
  const featureIntent = hasFeatureIntentForQuery(input.query);
  const llmGapCount = llmAnswer?.gaps?.length ?? 0;
  const hasConcreteAnswerFacts = facts.length > 0 && sources.length > 0;
  const needsFeatureEvidenceGap = featureIntent && answerNeedsFeatureGap({
    query: input.query,
    text: llmAnswer?.answer,
    facts,
    sources,
    linkedObjects,
  }) && llmGapCount === 0;
  const shouldSuppressLlmGaps = featureIntent && hasConcreteAnswerFacts && !answerNeedsFeatureGap({
    query: input.query,
    text: llmAnswer?.answer,
    facts,
    sources,
    linkedObjects,
  });
  const shouldPersistLlmGaps = llmGapCount > 0 && !shouldSuppressLlmGaps;
  const gaps = shouldPersistLlmGaps
    ? await persistAnswerGaps(context.store, gapSpaceId, input.query, llmAnswer?.gaps ?? [], {
      sources,
      linkedObjects,
    })
    : [];
  const evidenceGap = needsFeatureEvidenceGap
    ? await persistAnswerGap(context.store, gapSpaceId, input.query, 'Evidence matched the subject but did not include enough concrete source-backed feature or specification facts.', {
        sources,
        linkedObjects,
      })
    : null;
  const answerText = chooseAnswerText({
    input,
    mode,
    featureIntent,
    evidence,
    facts,
    sources,
    linkedObjects,
    llmAnswer,
  });
  return {
    ok: true,
    spaceId,
    query: input.query,
    answer: {
      text: answerText.text,
      mode,
      confidence: answerText.confidence,
      sources: input.includeSources === false ? [] : sources,
      linkedObjects,
      facts,
      gaps: evidenceGap && !isRepairedAnswerGap(evidenceGap) ? uniqueNodes([...gaps, evidenceGap]) : gaps,
      synthesized: answerText.synthesized,
    },
    results: evidence.map(toSearchResult),
  };
}

type ObjectProfiles = NonNullable<KnowledgeAnswerContext['objectProfiles']>;

type AnswerEvidenceResolution =
  | { readonly kind: 'matched'; readonly evidence: readonly EvidenceItem[] }
  | { readonly kind: 'no-match'; readonly result: KnowledgeSemanticAnswerResult };

async function resolveAnswerEvidence(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  mode: string,
  limit: number,
  objectProfiles: ObjectProfiles,
): Promise<AnswerEvidenceResolution> {
  const evidence = collectAnswerEvidence(context.store, input, spaceId, limit, objectProfiles);
  if (evidence.length > 0) return { kind: 'matched', evidence };

  const linkedObjects = input.includeLinkedObjects === false
    ? []
    : filterAnswerLinkedObjects(spaceId, input.query, [...(input.linkedObjects ?? [])], objectProfiles);
  const linkedEvidence = includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit);
  if (linkedEvidence.length > 0) return { kind: 'matched', evidence: linkedEvidence };

  const gap = shouldPersistNoMatchGap(spaceId, input.query, linkedObjects)
    ? await persistAnswerGap(context.store, concreteAnswerGapSpaceId(spaceId, [], [], linkedObjects), input.query, 'No indexed evidence matched the question.', {
      linkedObjects,
    })
    : null;
  return {
    kind: 'no-match',
    result: {
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
    },
  };
}

function collectRawAnswerFacts(query: string, evidence: readonly EvidenceItem[]): readonly KnowledgeNodeRecord[] {
  return filterFactsForQuery(query, uniqueNodes(evidence.flatMap((item) => item.facts))).slice(0, 24);
}

function resolveAnswerLinkedObjects(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  evidence: readonly EvidenceItem[],
  rawFacts: readonly KnowledgeNodeRecord[],
  objectProfiles: ObjectProfiles,
): readonly KnowledgeNodeRecord[] {
  if (input.includeLinkedObjects === false) return [];
  const inferredObjectLinkedObjects = inferObjectLinkedObjects(context.store, spaceId, input.query, objectProfiles);
  const evidenceLinkedObjects = shouldUseEvidenceLinkedObjects(spaceId, input, inferredObjectLinkedObjects)
    ? evidence.flatMap((item) => item.node ? [item.node] : [])
    : [];
  const rawLinkedObjects = uniqueNodes([
    ...(input.linkedObjects ?? []),
    ...evidenceLinkedObjects,
    ...inferredObjectLinkedObjects,
    ...linkedObjectsFromFacts(context.store, rawFacts),
  ])
    .filter(isSemanticAnswerLinkedObject)
    .slice(0, 24);
  return filterAnswerLinkedObjects(spaceId, input.query, rawLinkedObjects, objectProfiles);
}

function chooseAnswerText(options: {
  readonly input: KnowledgeSemanticAnswerInput;
  readonly mode: string;
  readonly featureIntent: boolean;
  readonly evidence: readonly EvidenceItem[];
  readonly facts: readonly AnswerFactRecord[];
  readonly sources: readonly unknown[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly llmAnswer: KnowledgeSemanticLlmAnswer | null;
}): { readonly text: string; readonly synthesized: boolean; readonly confidence: number } {
  const llmText = options.llmAnswer?.answer?.trim();
  const cleanedLlmText = llmText ? cleanSynthesizedAnswer(llmText, options.featureIntent) : undefined;
  const dropLowValueLlmAnswer = options.featureIntent && Boolean(cleanedLlmText) && isLowValueFeatureOrSpecText(cleanedLlmText ?? '');
  const fallback = renderFallbackAnswer(options.input.query, options.mode, options.evidence, options.facts);
  const hasZeroSourceBackedFeatureFacts = options.featureIntent
    && options.linkedObjects.length > 0
    && options.sources.length > 0
    && options.facts.length === 0
    && !fallback.synthesized;
  const preferFallback = shouldPreferFallbackAnswer(options.featureIntent, cleanedLlmText, fallback.text);
  const useFallback = hasZeroSourceBackedFeatureFacts || dropLowValueLlmAnswer || preferFallback || !cleanedLlmText;
  const text = cleanSynthesizedAnswer((useFallback ? fallback.text : cleanedLlmText) || '', options.featureIntent, {
    fallbackText: fallback.text,
  });
  const synthesized = useFallback ? fallback.synthesized : Boolean(cleanedLlmText);
  const confidence = options.input.includeConfidence === false
    ? 0
    : hasZeroSourceBackedFeatureFacts || dropLowValueLlmAnswer || (useFallback && !fallback.synthesized)
      ? 0
      : answerConfidence(preferFallback ? null : options.llmAnswer, options.evidence);
  return { text, synthesized, confidence };
}

function withAnswerFactContract(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly AnswerFactRecord[] {
  if (facts.length === 0) return [];
  const linkedObjectIds = new Set(linkedObjects.map((node) => node.id));
  const result: AnswerFactRecord[] = [];
  for (const fact of facts) {
    const source = fact.sourceId ? store.getSource(fact.sourceId) : null;
    const discovery = readRecord(source?.metadata.sourceDiscovery);
    const metadataLinkedIds = uniqueStrings([
      ...readStringArray(fact.metadata.linkedObjectIds),
      ...readStringArray(fact.metadata.subjectIds),
      ...readStringArray(discovery.linkedObjectIds),
    ]);
    const subjectIds = uniqueStrings([
      ...metadataLinkedIds.filter((id) => linkedObjectIds.has(id)),
      ...factSubjectIdsFromGraph(store, fact, linkedObjects),
    ]);
    const subjects = subjectIds
      .map((id) => linkedObjects.find((node) => node.id === id) ?? store.getNode(id))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node && node.status !== 'stale'));
    if (subjects.length === 0) {
      result.push(fact as AnswerFactRecord);
      continue;
    }
    const targetHints = answerTargetHints(subjects);
    const metadata = {
      ...fact.metadata,
      subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
      subjectIds: subjects.map((node) => node.id),
      linkedObjectIds: subjects.map((node) => node.id),
      targetHints,
    };
    result.push({
      ...fact,
      metadata,
      subject: metadata.subject as string | undefined,
      subjectIds: metadata.subjectIds as readonly string[],
      linkedObjectIds: metadata.linkedObjectIds as readonly string[],
      targetHints,
    });
  }
  return result;
}

function linkedObjectsFromFacts(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
): KnowledgeNodeRecord[] {
  if (facts.length === 0) return [];
  const factIds = new Set(facts.map((fact) => fact.id));
  const objectIds = new Set<string>();
  for (const fact of facts) {
    for (const id of [
      ...readStringArray(fact.metadata.linkedObjectIds),
      ...readStringArray(fact.metadata.subjectIds),
    ]) {
      objectIds.add(id);
    }
  }
  for (const edge of store.listEdges()) {
    if (edge.fromKind === 'node' && edge.toKind === 'node' && factIds.has(edge.fromId) && edge.relation === 'describes') {
      objectIds.add(edge.toId);
    }
  }
  return [...objectIds]
    .map((id) => store.getNode(id))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node && node.status !== 'stale'));
}

function factSubjectIdsFromGraph(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
): string[] {
  if (linkedObjects.length === 0) return [];
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const factSourceId = readString(fact.metadata.sourceId) ?? fact.sourceId;
  const sourcesSupportingFact = new Set<string>();
  const sourcesLinkedToSubject = new Map<string, Set<string>>();
  const directSubjectIds = new Set<string>();
  for (const edge of store.listEdges()) {
    if (edge.fromKind === 'node' && edge.fromId === fact.id && edge.toKind === 'node' && linkedIds.has(edge.toId) && edge.relation === 'describes') {
      directSubjectIds.add(edge.toId);
    }
    if (edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === fact.id && edge.relation === 'supports_fact') {
      sourcesSupportingFact.add(edge.fromId);
    }
    if (edge.fromKind === 'source' && edge.toKind === 'node' && linkedIds.has(edge.toId)) {
      const current = sourcesLinkedToSubject.get(edge.fromId) ?? new Set<string>();
      current.add(edge.toId);
      sourcesLinkedToSubject.set(edge.fromId, current);
    }
    if (edge.fromKind === 'node' && linkedIds.has(edge.fromId) && edge.toKind === 'source') {
      const current = sourcesLinkedToSubject.get(edge.toId) ?? new Set<string>();
      current.add(edge.fromId);
      sourcesLinkedToSubject.set(edge.toId, current);
    }
  }
  if (factSourceId) sourcesSupportingFact.add(factSourceId);
  for (const sourceId of sourcesSupportingFact) {
    for (const subjectId of sourcesLinkedToSubject.get(sourceId) ?? []) directSubjectIds.add(subjectId);
  }
  return [...directSubjectIds];
}

function answerTargetHints(nodes: readonly KnowledgeNodeRecord[]): readonly Record<string, unknown>[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(node.summary ? { summary: node.summary } : {}),
  }));
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
    /\b(4k|8k|uhd|resolution|refresh|120\s*hz|100\s*hz|display|screen|panel)\b/,
    /\b(webos|apps?|streaming|airplay|homekit|chromecast|smart tv)\b/,
    /\b(wi-?fi|bluetooth|wireless lan)\b/,
    /\b(audio|speakers?|dolby atmos|sound)\b/,
    /\b(game|gaming|vrr|allm|freesync|g-sync)\b/,
    /\b(tuner|atsc|qam|ntsc|broadcast)\b/,
  ].filter((pattern) => pattern.test(lower)).length;
}
