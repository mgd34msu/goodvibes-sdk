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
import { deriveRepairProfileFacts, type RepairProfileFact } from './repair-profile.js';
import { updateRefinementTask } from './self-improvement-tasks.js';
import { withTimeout } from './timeouts.js';
import { canonicalRepairSubjectNodes, repairSubjectHints } from './repair-subjects.js';
import {
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
): Promise<number> {
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
  const usableFactCount = promotedFactCount > 0
    ? promotedFactCount
    : countUsableRepairFacts(context.store, spaceId, sourceIds);
  await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'verified', 'Accepted repair sources were semantically enriched.', {
    promotedSourceIds: sourceIds,
    promotedFactCount: usableFactCount,
  });
  return usableFactCount;
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
    const text = sourceSemanticText(source, extraction);
    const profileFacts = deriveRepairProfileFacts({
      query: gap.title,
      source,
      text,
    });
    for (const profileFact of profileFacts) {
      promoted += await upsertPromotedRepairFact({
        store,
        spaceId,
        gap,
        source,
        subjects,
        authority,
        title: profileFact.title,
        summary: profileFact.summary,
        classification: profileFact,
        evidence: profileFact.evidence,
      });
    }
    const sentences = selectRepairFactSentences({
      query: gap.title,
      source,
      text,
    });
    for (const sentence of sentences) {
      const classification = classifyRepairFact(sentence);
      if (!classification) continue;
      promoted += await upsertPromotedRepairFact({
        store,
        spaceId,
        gap,
        source,
        subjects,
        authority,
        title: classification.title,
        summary: classification.summary,
        classification,
        evidence: sentence,
      });
    }
  }
  return promoted;
}

async function upsertPromotedRepairFact(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly source: KnowledgeSourceRecord;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly authority: 'official-vendor' | 'vendor' | 'secondary';
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: RepairFactClassification | RepairProfileFact;
}): Promise<number> {
  const fact = await input.store.upsertNode({
    id: `sem-fact-${semanticHash(input.spaceId, input.source.id, input.gap.id, input.title, input.summary)}`,
    kind: 'fact',
    slug: semanticSlug(`${input.spaceId}-${input.title}-${input.source.id}`),
    title: input.title,
    summary: input.summary,
    aliases: input.classification.aliases,
    status: 'active',
    confidence: input.authority === 'official-vendor' ? 90 : input.authority === 'vendor' ? 82 : 76,
    sourceId: input.source.id,
    metadata: semanticMetadata(input.spaceId, {
      semanticKind: 'fact',
      factKind: input.classification.kind,
      value: input.classification.value,
      evidence: input.evidence,
      labels: input.classification.labels,
      sourceId: input.source.id,
      gapId: input.gap.id,
      subject: input.subjects[0]?.title,
      subjectIds: input.subjects.map((subject) => subject.id),
      targetHints: repairSubjectHints(input.subjects),
      linkedObjectIds: input.subjects.map((subject) => subject.id),
      extractor: 'repair-promotion',
      sourceAuthority: input.authority,
      sourceDiscovery: readRecord(input.source.metadata.sourceDiscovery),
    }),
  });
  await input.store.upsertEdge({
    fromKind: 'source',
    fromId: input.source.id,
    toKind: 'node',
    toId: fact.id,
    relation: 'supports_fact',
    weight: input.authority === 'official-vendor' ? 0.96 : 0.84,
    metadata: semanticMetadata(input.spaceId, {
      linkedBy: 'semantic-gap-repair',
      gapId: input.gap.id,
    }),
  });
  for (const subject of input.subjects) {
    await input.store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: subject.id,
      relation: 'describes',
      weight: input.authority === 'official-vendor' ? 0.95 : 0.82,
      metadata: semanticMetadata(input.spaceId, {
        linkedBy: 'semantic-gap-repair',
        repairedAt: Date.now(),
        sourceId: input.source.id,
        gapId: input.gap.id,
      }),
    });
  }
  return 1;
}

async function linkPromotedFactsToRepairSubjects(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
): Promise<void> {
  const subjects = linkedRepairSubjects(store, spaceId, gap);
  if (subjects.length === 0) return;
  const linkedObjectIds = subjects.map((subject) => subject.id);
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
    .filter((sentence) => !isSourceAddressFragment(sentence))
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

function isSourceAddressFragment(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return /homegraph:\/\//.test(lower)
    || /https?:\/\//.test(lower)
    || /\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)\/[a-z0-9/_?=&.#-]+/.test(lower)
    || /\b(?:series_url|canonicaluri|sourceuri|current page|loading)\b/.test(lower);
}

interface RepairFactClassification {
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly title: string;
  readonly value?: string;
  readonly summary: string;
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
}

function classifyRepairFact(sentence: string): RepairFactClassification | null {
  const lower = sentence.toLowerCase();
  if (/\b(resolution|4k|8k|uhd|display|screen|nanocell|lcd|oled|qled|refresh|hz|hdr|dolby vision|hlg)\b/.test(lower)) {
    return buildRepairFactClassification('specification', 'Display and picture specifications', ['display', 'picture'], ['display', 'picture'], sentence, [
      ['4K UHD resolution', /\b4k\b|\buhd\b|\b3840\s*(?:x|×)\s*2160\b/i],
      ['NanoCell display technology', /\bnanocell\b/i],
      ['LCD/LED display', /\blcd\b|\bled\b/i],
      ['100/120 Hz refresh rate', /\b(?:100|120)\s*hz\b|\btrumotion\s*240\b/i],
      ['HDR10', /\bhdr10\b/i],
      ['Dolby Vision', /\bdolby vision\b/i],
      ['HLG', /\bhlg\b/i],
    ]);
  }
  if (/\b(hdmi|usb|ethernet|optical|rf|antenna|rs-?232|composite|component|earc|arc|ports?|input|output)\b/.test(lower)) {
    return buildRepairFactClassification('specification', 'Input and output ports', ['ports', 'connectivity'], ['ports', 'inputs', 'outputs'], sentence, [
      ['HDMI inputs', /\bhdmi\b/i],
      ['HDMI ARC/eARC', /\bearc\b|\barc\b/i],
      ['USB ports', /\busb\b/i],
      ['Ethernet/LAN', /\bethernet\b|\blan\b|\brj-?45\b/i],
      ['Optical audio output', /\boptical\b|\btoslink\b/i],
      ['RF/antenna input', /\brf\b|\bantenna\b/i],
      ['Composite/component video', /\bcomposite\b|\bcomponent\b/i],
      ['RS-232C/external control', /\brs-?232c?\b|\bexternal control\b/i],
    ]);
  }
  if (/\b(wi-?fi|bluetooth|wireless|airplay|homekit|miracast|chromecast|ethernet)\b/.test(lower)) {
    return buildRepairFactClassification('capability', 'Network and wireless capabilities', ['network', 'wireless'], ['network', 'wireless'], sentence, [
      ['Wi-Fi/wireless LAN', /\bwi-?fi\b|\bwireless lan\b/i],
      ['Bluetooth', /\bbluetooth\b/i],
      ['Ethernet/LAN', /\bethernet\b|\blan\b/i],
      ['Apple AirPlay', /\bairplay\b/i],
      ['Apple HomeKit', /\bhomekit\b/i],
      ['Chromecast/Miracast support', /\bchromecast\b|\bmiracast\b/i],
    ]);
  }
  if (/\b(speaker|audio|dolby atmos|dolby audio|sound|watts?|channels?)\b/.test(lower)) {
    return buildRepairFactClassification('specification', 'Audio capabilities', ['audio'], ['audio', 'speakers'], sentence, [
      ['speaker/audio output', /\bspeakers?\b|\b(?:10|20|40)\s*w\b|\b2(?:\.0)?\s*ch\b/i],
      ['Dolby audio formats', /\bdolby atmos\b|\bdolby digital\b|\bdolby audio\b|\btruehd\b|\bpcm\b/i],
      ['HDMI ARC/eARC audio', /\bearc\b|\barc\b/i],
    ]);
  }
  if (/\b(game|gaming|vrr|allm|freesync|g-?sync|low latency)\b/.test(lower)) {
    return buildRepairFactClassification('feature', 'Gaming features', ['gaming'], ['gaming'], sentence, [
      ['FreeSync/VRR support', /\bfreesync\b|\bvrr\b/i],
      ['ALLM/low-latency support', /\ballm\b|\blow latency\b/i],
      ['Game Optimizer/game mode', /\bgame optimizer\b|\bgame mode\b|\bgaming\b/i],
      ['4K/120 Hz or high-bandwidth HDMI', /\bhdmi\s*2\.1\b|\b4k\s*(?:at|@)?\s*120\b|\b120\s*hz\b/i],
    ]);
  }
  if (/\b(webos|smart tv|apps?|voice assistant|alexa|google assistant|streaming)\b/.test(lower)) {
    return buildRepairFactClassification('feature', 'Smart TV features', ['smart-tv'], ['smart tv', 'apps'], sentence, [
      ['webOS smart TV platform', /\bwebos\b/i],
      ['voice assistant support', /\bvoice\b|\balexa\b|\bgoogle assistant\b/i],
      ['streaming app support', /\bapps?\b|\bstreaming\b/i],
    ]);
  }
  if (/\b(tuner|atsc|ntsc|qam|broadcast|clear qam)\b/.test(lower)) {
    return buildRepairFactClassification('specification', 'Tuner support', ['tuner'], ['tuner', 'broadcast'], sentence, [
      ['ATSC tuner support', /\batsc\b/i],
      ['NTSC analog tuner support', /\bntsc\b/i],
      ['Clear QAM support', /\bqam\b|\bclear qam\b/i],
      ['broadcast tuner support', /\btuner\b|\bbroadcast\b/i],
    ]);
  }
  return null;
}

function buildRepairFactClassification(
  kind: RepairFactClassification['kind'],
  title: string,
  labels: readonly string[],
  aliases: readonly string[],
  sentence: string,
  terms: readonly [string, RegExp][],
): RepairFactClassification | null {
  const values = uniqueStrings(terms
    .filter(([, pattern]) => pattern.test(sentence))
    .map(([label]) => label));
  if (values.length === 0) return null;
  return {
    kind,
    title,
    value: values.join(', '),
    summary: `${title}: ${joinValues(values)}.`,
    labels,
    aliases,
  };
}

function joinValues(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
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
  const edges = store.listEdges();
  const nodesById = new Map(store.listNodes(10_000)
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .map((node) => [node.id, node]));
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  return canonicalRepairSubjectNodes({
    text: `${gap.title} ${gap.summary ?? ''}`,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((id) => nodesById.get(id)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ],
  });
}

function linkedObjectsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.status !== 'stale')
    .filter((node) => node.metadata.semanticKind !== 'fact' && node.metadata.semanticKind !== 'gap' && node.kind !== 'wiki_page'));
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

function countUsableRepairFacts(store: KnowledgeStore, spaceId: string, sourceIds: readonly string[]): number {
  const sources = new Set(sourceIds);
  return store.listNodes(10_000)
    .filter((node) => node.kind === 'fact' && node.status !== 'stale')
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .filter((node) => node.sourceId && sources.has(node.sourceId))
    .filter((node) => ['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(readString(node.metadata.factKind) ?? ''))
    .length;
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
