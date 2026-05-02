import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { hasConcreteFeatureSignal, isLowValueFeatureOrSpecText } from './fact-quality.js';
import { updateRefinementTask } from './self-improvement-tasks.js';
import { withTimeout } from './timeouts.js';
import {
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  semanticHash,
  semanticMetadata,
  semanticSlug,
  sourceSemanticText,
  splitSentences,
  uniqueStrings,
} from './utils.js';

export interface SelfImprovePromotionContext {
  readonly store: KnowledgeStore;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string }) => Promise<unknown>;
}

export async function promoteRepairSources(
  context: SelfImprovePromotionContext,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  task: KnowledgeRefinementTaskRecord,
  deadlineAt: number,
): Promise<void> {
  if (context.enrichSource) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await yieldEvery(index, 2);
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs < 1_000) break;
      await withTimeout(
        context.enrichSource(sourceId, { knowledgeSpaceId: spaceId, force: true }),
        Math.min(remainingMs, 20_000),
        'Semantic repair source enrichment exceeded its run budget.',
      );
      await yieldToEventLoop();
    }
  }
  const promotedFactCount = await promoteRepairEvidenceFacts(context.store, spaceId, gap, sourceIds);
  await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, sourceIds);
  await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'verified', 'Accepted repair sources were semantically enriched.', {
    promotedSourceIds: sourceIds,
    promotedFactCount,
  });
}

async function promoteRepairEvidenceFacts(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
): Promise<number> {
  const subjects = linkedRepairSubjects(store, spaceId, gap);
  if (subjects.length === 0) return 0;
  let promoted = 0;
  for (const sourceId of sourceIds) {
    const source = store.getSource(sourceId);
    if (!source) continue;
    const extraction = store.getExtractionBySourceId(source.id);
    const authority = sourceAuthority(source);
    const sentences = selectRepairFactSentences({
      query: gap.title,
      source,
      text: sourceSemanticText(source, extraction),
    });
    for (const [index, sentence] of sentences.entries()) {
      const classification = classifyRepairFact(sentence);
      const fact = await store.upsertNode({
        id: `sem-fact-${semanticHash(spaceId, source.id, gap.id, classification.title, sentence)}`,
        kind: 'fact',
        slug: semanticSlug(`${spaceId}-${classification.title}-${source.id}-${index}`),
        title: classification.title,
        summary: sentence,
        aliases: classification.aliases,
        status: 'active',
        confidence: authority === 'official-vendor' ? 88 : 76,
        sourceId: source.id,
        metadata: semanticMetadata(spaceId, {
          semanticKind: 'fact',
          factKind: classification.kind,
          value: classification.value,
          evidence: sentence,
          labels: classification.labels,
          sourceId: source.id,
          gapId: gap.id,
          linkedObjectIds: subjects.map((subject) => subject.id),
          extractor: 'repair-promotion',
          sourceAuthority: authority,
          sourceDiscovery: readRecord(source.metadata.sourceDiscovery),
        }),
      });
      await store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: fact.id,
        relation: 'supports_fact',
        weight: authority === 'official-vendor' ? 0.95 : 0.84,
        metadata: semanticMetadata(spaceId, {
          linkedBy: 'semantic-gap-repair',
          gapId: gap.id,
        }),
      });
      for (const subject of subjects) {
        await store.upsertEdge({
          fromKind: 'node',
          fromId: fact.id,
          toKind: 'node',
          toId: subject.id,
          relation: 'describes',
          weight: authority === 'official-vendor' ? 0.94 : 0.82,
          metadata: semanticMetadata(spaceId, {
            linkedBy: 'semantic-gap-repair',
            repairedAt: Date.now(),
            sourceId: source.id,
            gapId: gap.id,
          }),
        });
      }
      promoted += 1;
    }
  }
  return promoted;
}

async function linkPromotedFactsToRepairSubjects(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
): Promise<void> {
  const linkedObjectIds = readStringArray(gap.metadata.linkedObjectIds).filter((nodeId) => Boolean(store.getNode(nodeId)));
  if (linkedObjectIds.length === 0) return;
  const edges = store.listEdges();
  const nodesById = new Map(store.listNodes(10_000).filter((node) => getKnowledgeSpaceId(node) === spaceId).map((node) => [node.id, node]));
  for (const sourceId of sourceIds) {
    for (const fact of factsForSource(sourceId, edges, nodesById)) {
      for (const objectId of linkedObjectIds) {
        await store.upsertEdge({
          fromKind: 'node',
          fromId: fact.id,
          toKind: 'node',
          toId: objectId,
          relation: 'describes',
          weight: 0.82,
          metadata: semanticMetadata(spaceId, {
            linkedBy: 'semantic-gap-repair',
            repairedAt: Date.now(),
            sourceId,
          }),
        });
      }
    }
  }
}

function selectRepairFactSentences(input: {
  readonly query: string;
  readonly source: KnowledgeSourceRecord;
  readonly text: string;
}): readonly string[] {
  const wanted = repairIntentPatterns(input.query);
  const sourceText = normalizeWhitespace(input.text);
  const candidates = splitSentences(sourceText, 360)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 360)
    .filter((sentence) => !sentence.trim().endsWith('?'))
    .filter((sentence) => hasConcreteFeatureSignal(sentence))
    .filter((sentence) => !isLowValueFeatureOrSpecText(sentence));
  const scored = candidates.map((sentence) => ({
    sentence,
    score: repairSentenceScore(sentence, wanted, input.source),
  })).filter((entry) => entry.score > 0);
  return uniqueStrings(scored
    .sort((left, right) => right.score - left.score || left.sentence.localeCompare(right.sentence))
    .map((entry) => entry.sentence))
    .slice(0, 14);
}

function repairSentenceScore(sentence: string, wanted: readonly RegExp[], source: KnowledgeSourceRecord): number {
  const lower = sentence.toLowerCase();
  let score = sourceAuthority(source) === 'official-vendor' ? 12 : 0;
  if (wanted.some((pattern) => pattern.test(lower))) score += 20;
  if (hasConcreteFeatureSignal(lower)) score += 8;
  if (/\b(hdmi|usb|ethernet|wi-?fi|bluetooth|hdr|dolby|resolution|refresh|120\s*hz|speaker|tuner|atsc|qam|webos|airplay|homekit|freesync|vrr|allm|earc|arc)\b/.test(lower)) {
    score += 12;
  }
  if (/\b(specifications?|features?|connectivity|ports?|display|audio|network|smart tv|gaming)\b/.test(lower)) score += 6;
  if (/^\s*\d+\s/.test(lower) || /\b(question|answer|faq|click|price|review|manual\.nz)\b/.test(lower)) score -= 20;
  return score;
}

function classifyRepairFact(sentence: string): {
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly title: string;
  readonly value?: string;
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
} {
  const lower = sentence.toLowerCase();
  if (/\b(resolution|4k|8k|uhd|display|screen|nanocell|lcd|oled|qled|refresh|hz|hdr|dolby vision|hlg)\b/.test(lower)) {
    return { kind: 'specification', title: 'Display and picture specifications', labels: ['display', 'picture'], aliases: ['display', 'picture'] };
  }
  if (/\b(hdmi|usb|ethernet|optical|rf|antenna|rs-?232|composite|component|earc|arc|ports?|input|output)\b/.test(lower)) {
    return { kind: 'specification', title: 'Input and output ports', labels: ['ports', 'connectivity'], aliases: ['ports', 'inputs', 'outputs'] };
  }
  if (/\b(wi-?fi|bluetooth|wireless|airplay|homekit|miracast|chromecast|ethernet)\b/.test(lower)) {
    return { kind: 'capability', title: 'Network and wireless capabilities', labels: ['network', 'wireless'], aliases: ['network', 'wireless'] };
  }
  if (/\b(speaker|audio|dolby atmos|dolby audio|sound|watts?|channels?)\b/.test(lower)) {
    return { kind: 'specification', title: 'Audio capabilities', labels: ['audio'], aliases: ['audio', 'speakers'] };
  }
  if (/\b(game|gaming|vrr|allm|freesync|g-?sync|low latency)\b/.test(lower)) {
    return { kind: 'feature', title: 'Gaming features', labels: ['gaming'], aliases: ['gaming'] };
  }
  if (/\b(webos|smart tv|apps?|voice assistant|alexa|google assistant|streaming)\b/.test(lower)) {
    return { kind: 'feature', title: 'Smart TV features', labels: ['smart-tv'], aliases: ['smart tv', 'apps'] };
  }
  if (/\b(tuner|atsc|ntsc|qam|broadcast|clear qam)\b/.test(lower)) {
    return { kind: 'specification', title: 'Tuner support', labels: ['tuner'], aliases: ['tuner', 'broadcast'] };
  }
  return {
    kind: 'feature',
    title: clampText(sentence, 80),
    labels: ['source-backed'],
    aliases: [],
  };
}

function repairIntentPatterns(query: string): readonly RegExp[] {
  const lower = query.toLowerCase();
  const patterns: RegExp[] = [];
  if (/\b(port|ports|input|output|hdmi|usb|optical|rf|antenna|rs-?232|composite|component|i\/o)\b/.test(lower)) patterns.push(/\b(hdmi|usb|optical|rf|antenna|ethernet|rs-?232|composite|component|earc|arc|ports?|input|output)\b/);
  if (/\b(bluetooth|wifi|wi-fi|wireless|network)\b/.test(lower)) patterns.push(/\b(bluetooth|wi-?fi|wireless|network|ethernet|airplay|homekit)\b/);
  if (/\b(refresh|hz|hdr|dolby|vision|gaming|vrr|allm|freesync)\b/.test(lower)) patterns.push(/\b(refresh|hz|hdr|hdr10|dolby vision|hlg|game|vrr|allm|freesync|120\s*hz|100\s*hz)\b/);
  if (/\b(display|screen|resolution|panel|nanocell|lcd|oled)\b/.test(lower)) patterns.push(/\b(display|screen|resolution|4k|uhd|nanocell|lcd|oled|panel)\b/);
  if (patterns.length === 0) patterns.push(/\b(hdmi|usb|hdr|dolby|resolution|refresh|wi-?fi|bluetooth|speaker|audio|webos|smart tv|tuner|gaming|ports?)\b/);
  return patterns;
}

function linkedRepairSubjects(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord): KnowledgeNodeRecord[] {
  return uniqueById(readStringArray(gap.metadata.linkedObjectIds)
    .map((id) => store.getNode(id))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => getKnowledgeSpaceId(node) === spaceId && node.status !== 'stale'));
}

function factsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

function sourceAuthority(source: KnowledgeSourceRecord): 'official-vendor' | 'vendor' | 'secondary' {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const trust = `${readString(discovery.trustReason) ?? ''} ${readString(discovery.sourceDomain) ?? ''} ${source.sourceUri ?? ''} ${source.canonicalUri ?? ''}`.toLowerCase();
  if (/\bofficial-vendor-domain\b/.test(trust) || /(^|[/.])lg\.com\b|(^|[/.])sony\.com\b|(^|[/.])samsung\.com\b|(^|[/.])apple\.com\b/.test(trust)) {
    return 'official-vendor';
  }
  if (/\bmanufacturer-domain\b/.test(trust)) return 'vendor';
  return 'secondary';
}

function uniqueById<T extends { readonly id: string }>(items: readonly (T | undefined)[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => typeof entry === 'string' ? entry : undefined));
}
