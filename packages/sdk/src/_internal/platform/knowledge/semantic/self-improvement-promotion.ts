import { sleep, yieldEvery, yieldToEventLoop } from '../cooperative.js';
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
  readStringArray,
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

export interface PromoteRepairSourcesResult {
  readonly promotedFactCount: number;
  readonly repairComplete: boolean;
  readonly promotedSourceIds: readonly string[];
}

const REPAIR_SOURCE_TEXT_WAIT_MS = 1_500;

export async function promoteRepairSources(
  context: SelfImprovePromotionContext,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  task: KnowledgeRefinementTaskRecord,
  deadlineAt: number,
): Promise<PromoteRepairSourcesResult> {
  const targetUsableFactCount = repairTargetUsableFactCount(gap);
  const subjects = linkedRepairSubjects(context.store, spaceId, gap);
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const processedSourceIds: string[] = [];
  if (context.enrichSource) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await yieldEvery(index, 2);
      processedSourceIds.push(sourceId);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs < 1_000) break;
      try {
        await withTimeout(
          context.enrichSource(sourceId, { knowledgeSpaceId: spaceId, force: true }),
          Math.min(remainingMs, 20_000),
          'Semantic repair source enrichment exceeded its run budget.',
        );
      } catch (error) {
        await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
        await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
        await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
        await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Repair source enrichment did not finish for one accepted source.', {
          sourceId,
          enrichmentError: error instanceof Error ? error.message : String(error),
          promotedSourceIds: processedSourceIds,
          promotedFactCount: countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds),
        });
        if (deadlineAt - Date.now() < 1_000) break;
        continue;
      }
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      await yieldToEventLoop();
    }
  }
  const promotionSourceIds = processedSourceIds.length > 0 ? uniqueStrings(processedSourceIds) : sourceIds;
  const promotedFactCount = processedSourceIds.length > 0
    ? 0
    : await promoteRepairEvidenceFacts(context.store, spaceId, gap, sourceIds);
  await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, promotionSourceIds);
  const usableFactCount = promotedFactCount > 0
    ? promotedFactCount
    : countUsableRepairFacts(context.store, spaceId, promotionSourceIds, subjectIds);
  const repairComplete = usableFactCount >= targetUsableFactCount;
  if (repairComplete) {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'verified', 'Accepted repair sources were semantically enriched.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
    });
  } else if (usableFactCount > 0) {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources yielded partial subject-linked facts.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
      targetPromotedFactCount: targetUsableFactCount,
    });
  } else {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources did not yield usable subject-linked facts.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
    });
  }
  return { promotedFactCount: usableFactCount, repairComplete, promotedSourceIds: promotionSourceIds };
}

function repairTargetUsableFactCount(gap: KnowledgeNodeRecord): number {
  const text = `${gap.title} ${gap.summary ?? ''}`.toLowerCase();
  if (/\b(complete|full|features?|capabilities|specifications?|profile)\b/.test(text)) return 3;
  return 1;
}

async function waitForRepairSourceText(
  store: KnowledgeStore,
  sourceId: string,
  deadlineAt: number,
): Promise<void> {
  while (deadlineAt - Date.now() >= 1_000) {
    const source = store.getSource(sourceId);
    if (!source) return;
    const extraction = store.getExtractionBySourceId(source.id);
    if (extractedSemanticText(extraction).length >= 40) return;
    if (!source.url && !source.sourceUri && !source.canonicalUri && sourceSemanticText(source, extraction).length >= 80) return;
    await yieldToEventLoop();
    await sleep(100);
  }
}

function extractedSemanticText(extraction: ReturnType<KnowledgeStore['getExtractionBySourceId']>): string {
  const structure = readRecord(extraction?.structure);
  const metadata = readRecord(extraction?.metadata);
  return normalizeWhitespace([
    extraction?.excerpt,
    ...(extraction?.sections ?? []),
    readString(structure.searchText),
    readString(structure.text),
    readString(structure.content),
    readString(metadata.searchText),
    readString(metadata.text),
  ].filter(Boolean).join(' '));
}

function sourceRequiresExtractedEvidence(source: KnowledgeSourceRecord): boolean {
  return Boolean(source.url || source.sourceUri || source.canonicalUri);
}

function repairSourceEvidenceText(
  source: KnowledgeSourceRecord,
  extraction: ReturnType<KnowledgeStore['getExtractionBySourceId']>,
): string {
  const extracted = extractedSemanticText(extraction);
  return sourceRequiresExtractedEvidence(source) ? extracted : sourceSemanticText(source, extraction);
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
    if (sourceRequiresExtractedEvidence(source) && extractedSemanticText(extraction).length < 40) continue;
    const authority = sourceAuthority(source);
    const text = repairSourceEvidenceText(source, extraction);
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
  const targetHints = repairSubjectHints(subjects);
  const edges = store.listEdges();
  const nodesById = new Map(store.listNodes(10_000).filter((node) => getKnowledgeSpaceId(node) === spaceId).map((node) => [node.id, node]));
  for (const sourceId of sourceIds) {
    for (const fact of factsForSource(sourceId, edges, nodesById)) {
      if (!isUsableRepairFact(fact) || !isRepairFactCompatibleWithSubjects(fact, subjects)) continue;
      await store.upsertNode({
        id: fact.id,
        kind: fact.kind,
        slug: fact.slug,
        title: fact.title,
        summary: fact.summary,
        aliases: fact.aliases,
        status: fact.status,
        confidence: fact.confidence,
        sourceId: fact.sourceId ?? sourceId,
        metadata: semanticMetadata(spaceId, {
          ...fact.metadata,
          subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
          subjectIds: uniqueStrings([...readStringArray(fact.metadata.subjectIds), ...linkedObjectIds]),
          linkedObjectIds: uniqueStrings([...readStringArray(fact.metadata.linkedObjectIds), ...linkedObjectIds]),
          targetHints: uniqueTargetHints([
            ...readTargetHints(fact.metadata.targetHints),
            ...targetHints,
          ]),
          sourceId: fact.sourceId ?? sourceId,
          linkedBy: readString(fact.metadata.linkedBy) ?? 'semantic-gap-repair',
        }),
      });
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
  if (/\b(resolution|4k|8k|uhd|display|screen|panel|lcd|led|oled|qled|mini[- ]?led|refresh|hz|hdr|dolby vision|hlg)\b/.test(lower)) {
    return buildRepairFactClassification('specification', 'Display and picture specifications', ['display', 'picture'], ['display', 'picture'], sentence, [
      ['4K UHD resolution', /\b4k\b|\buhd\b|\b3840\s*(?:x|×)\s*2160\b/i],
      ['display panel technology', /\boled\b|\bqled\b|\bmini[- ]?led\b|\bled\b|\blcd\b/i],
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
      ['speaker wattage', /\b\d+\s*x\s*\d+\s*w\b|\b\d+(?:\.\d+)?\s*w\b/i],
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
  if (/\b(display|screen|resolution|panel|lcd|led|oled|qled|mini[- ]?led)\b/.test(lower)) patterns.push(/\b(display|screen|resolution|4k|uhd|lcd|led|oled|qled|panel)\b/);
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
  const trust = [
    readString(discovery.trustReason),
    readString(discovery.sourceDomain),
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bofficial-vendor-domain\b/.test(trust)) return 'official-vendor';
  if (/\bofficial\b/.test(trust) && /\b(support|specifications?|manual|product|docs?|datasheet)\b/.test(trust) && !isCommercialLowValueSourceText(trust)) {
    return 'official-vendor';
  }
  if (/\bmanufacturer-domain\b/.test(trust)) return 'vendor';
  return 'secondary';
}

function isCommercialLowValueSourceText(text: string): boolean {
  return /\b(shopping|shop now|affiliate|associate program|buy now|add to cart|price comparison|marketplace|retailer|store listing|seller listing|sponsored listing|latest price|compare prices)\b/.test(text)
    || /(^|\.)amazon\.[a-z.]+\b|(^|\.)ebay\.[a-z.]+\b|(^|\.)walmart\.[a-z.]+\b|(^|\.)bestbuy\.[a-z.]+\b|(^|\.)target\.[a-z.]+\b/.test(text);
}

function countUsableRepairFacts(
  store: KnowledgeStore,
  spaceId: string,
  sourceIds: readonly string[],
  subjectIds: ReadonlySet<string>,
): number {
  const sources = new Set(sourceIds);
  return store.listNodes(10_000)
    .filter((node) => node.kind === 'fact' && node.status !== 'stale')
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .filter((node) => node.sourceId && sources.has(node.sourceId))
    .filter(isUsableRepairFact)
    .filter((node) => {
      if (subjectIds.size === 0) return true;
      const linkedIds = uniqueStrings([
        ...readStringArray(node.metadata.linkedObjectIds),
        ...readStringArray(node.metadata.subjectIds),
      ]);
      return linkedIds.some((id) => subjectIds.has(id));
    })
    .length;
}

function isUsableRepairFact(node: KnowledgeNodeRecord): boolean {
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(readString(node.metadata.factKind) ?? '')) {
    return false;
  }
  const text = `${node.title} ${node.summary ?? ''} ${readString(node.metadata.value) ?? ''} ${readString(node.metadata.evidence) ?? ''}`;
  return hasConcreteFeatureSignal(text) && !isLowValueFeatureOrSpecText(text);
}

function isRepairFactCompatibleWithSubjects(fact: KnowledgeNodeRecord, subjects: readonly KnowledgeNodeRecord[]): boolean {
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const existingIds = uniqueStrings([
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  if (existingIds.length > 0) return existingIds.some((id) => subjectIds.has(id));
  const subject = readString(fact.metadata.subject);
  if (subject && !subjects.some((node) => textMatchesSubject(subject, node))) return false;
  const factModels = modelLikeTokens(`${fact.title} ${fact.summary ?? ''} ${readString(fact.metadata.value) ?? ''} ${readString(fact.metadata.evidence) ?? ''}`);
  if (factModels.length === 0) return true;
  const subjectModels = uniqueStrings(subjects.flatMap((node) => modelLikeTokens(`${node.title} ${node.aliases.join(' ')} ${readString(node.metadata.model) ?? ''}`)));
  return subjectModels.length === 0 || factModels.some((model) => subjectModels.includes(model));
}

function textMatchesSubject(value: string, subject: KnowledgeNodeRecord): boolean {
  const text = normalizeWhitespace(value).toLowerCase();
  const candidates = uniqueStrings([
    subject.title,
    ...subject.aliases,
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
  ]).map((entry) => entry.toLowerCase());
  return candidates.some((candidate) => candidate.length >= 3 && (text.includes(candidate) || candidate.includes(text)));
}

function modelLikeTokens(value: string): readonly string[] {
  return uniqueStrings([
    ...(value.match(/\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/g) ?? []),
    ...(value.match(/\b[0-9]{2,}[A-Z][A-Z0-9._-]{2,}\b/g) ?? []),
  ]
    .map((token) => token.replace(/[\s_-]+/g, '').toLowerCase())
    .filter((token) => !/^(hdr10|hdmi2(?:\.\d)?|usb[0-9]|wifi[0-9]|wi-fi[0-9]|atsc[0-9]?|ntsc|qam)$/.test(token)));
}

function readTargetHints(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function uniqueTargetHints(values: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    const id = readString(value.id);
    const key = id ?? JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
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
