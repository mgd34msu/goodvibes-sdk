import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticEntityInput,
  KnowledgeSemanticExtraction,
  KnowledgeSemanticFactInput,
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticRelationInput,
} from './types.js';
import {
  MAX_SEMANTIC_SOURCE_CHARS,
  applySourceMetadata,
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  semanticHash,
  semanticMetadata,
  semanticSlug,
  sourceKnowledgeSpace,
  sourceSemanticHash,
  sourceSemanticText,
  splitSentences,
  uniqueStrings,
} from './utils.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { hasConcreteFeatureSignal, isLowValueFeatureOrSpecText } from './fact-quality.js';
import { deriveRepairProfileFacts } from './repair-profile.js';

export interface KnowledgeSemanticEnrichmentContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
}

export interface EnrichKnowledgeSourceOptions {
  readonly force?: boolean | undefined;
  readonly knowledgeSpaceId?: string | undefined;
}

export interface PersistedSemanticExtraction {
  readonly source: KnowledgeSourceRecord;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly extractor?: 'llm' | 'deterministic' | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly wikiPage?: KnowledgeNodeRecord | undefined;
  readonly gaps: readonly KnowledgeNodeRecord[];
}

export async function enrichKnowledgeSource(
  context: KnowledgeSemanticEnrichmentContext,
  source: KnowledgeSourceRecord,
  options: EnrichKnowledgeSourceOptions = {},
): Promise<PersistedSemanticExtraction> {
  const extraction = context.store.getExtractionBySourceId(source.id);
  const text = sourceSemanticText(source, extraction);
  const textHash = sourceSemanticHash(source, extraction);
  const existingSemantic = readRecord(source.metadata.semanticEnrichment);
  const currentExtractor = readString(existingSemantic.extractor);
  const shouldUpgradeDeterministic = Boolean(context.llm && existingSemantic.textHash === textHash && currentExtractor !== 'llm');
  if (!options.force && existingSemantic.textHash === textHash && !shouldUpgradeDeterministic) {
    return emptyResult(source, true, 'semantic enrichment is current');
  }
  if (text.length < 40) {
    await markSourceSemanticState(context.store, source, textHash, {
      skippedReason: 'source has too little extracted text',
    });
    return emptyResult(source, true, 'source has too little extracted text');
  }

  const llmExtraction = await extractSemanticsWithLlm(context.llm ?? null, source, extraction, text);
  const semantic = normalizeSemanticExtraction(llmExtraction)
    ?? deterministicSemanticExtraction(source, extraction, text);
  const persisted = await persistSemanticExtraction(context.store, source, extraction, semantic, {
    knowledgeSpaceId: options.knowledgeSpaceId,
    textHash,
  });
  await markSourceSemanticState(context.store, source, textHash, {
    extractor: semantic.extractor,
    factCount: persisted.facts.length,
    entityCount: persisted.entities.length,
    gapCount: persisted.gaps.length,
  });
  return persisted;
}

async function extractSemanticsWithLlm(
  llm: KnowledgeSemanticLlm | null,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
): Promise<unknown | null> {
  if (!llm) return null;
  return llm.completeJson({
    purpose: 'knowledge-semantic-enrichment',
    maxTokens: 2600,
    timeoutMs: 20_000,
    systemPrompt: [
      'You extract a durable semantic knowledge graph from source material.',
      'Return only JSON. Do not invent facts. Every fact must be grounded in the supplied source text.',
      'Capture capabilities, features, specifications, procedures, warnings, maintenance items, compatibility, configuration, and troubleshooting facts when present.',
      'Prefer precise facts over broad summaries. Preserve numbers, model names, ports, version names, constraints, and useful procedures.',
    ].join(' '),
    prompt: JSON.stringify({
      source: {
        id: source.id,
        title: source.title,
        sourceType: source.sourceType,
        tags: source.tags,
        uri: source.canonicalUri ?? source.sourceUri,
        metadata: source.metadata,
      },
      extraction: {
        format: extraction?.format,
        title: extraction?.title,
        summary: extraction?.summary,
        sections: extraction?.sections.slice(0, 80),
      },
      instructions: {
        outputShape: {
          summary: 'short source summary',
          entities: [{ title: 'entity name', kind: 'entity type', aliases: ['alternate names'], summary: 'one sentence', confidence: 0 }],
          facts: [{
            kind: 'feature|capability|specification|identity|procedure|warning|maintenance|compatibility|configuration|troubleshooting|relationship|note',
            title: 'short fact title',
            value: 'precise value when applicable',
            summary: 'source-grounded explanation',
            evidence: 'short quote or close paraphrase from source',
            confidence: 0,
            labels: ['optional labels'],
            targetHints: ['entities this fact describes'],
          }],
          relations: [{ from: 'entity/fact title', relation: 'relation label', to: 'entity/fact title', evidence: 'source-grounded evidence', confidence: 0 }],
          gaps: [{ question: 'missing useful question', reason: 'why source does not answer it', subject: 'optional subject', severity: 'info|warning|error' }],
          wikiPage: { title: 'living page title', markdown: 'concise markdown page synthesized only from extracted facts' },
        },
      },
      text: clampText(text, MAX_SEMANTIC_SOURCE_CHARS),
    }),
  });
}

function normalizeSemanticExtraction(value: unknown): KnowledgeSemanticExtraction | null {
  const record = readRecord(value);
  const facts = readArray(record.facts).map(normalizeFact).filter(isFact);
  const entities = readArray(record.entities).map(normalizeEntity).filter(isEntity);
  const relations = readArray(record.relations).map(normalizeRelation).filter(isRelation);
  const gaps = readArray(record.gaps).map(normalizeGap).filter(isGap);
  const wikiRecord = readRecord(record.wikiPage);
  const markdown = readString(wikiRecord.markdown);
  const title = readString(wikiRecord.title);
  if (facts.length === 0 && entities.length === 0 && !markdown) return null;
  return {
    summary: readString(record.summary),
    entities,
    facts,
    relations,
    gaps,
    ...(markdown || title ? { wikiPage: { ...(title ? { title } : {}), ...(markdown ? { markdown } : {}) } } : {}),
    extractor: 'llm',
  };
}

function deterministicSemanticExtraction(
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
): KnowledgeSemanticExtraction {
  const factText = cleanDeterministicSourceText(deterministicFactSourceText(extraction) || text);
  const sentences = splitSentences(factText);
  const profileFacts = deriveRepairProfileFacts({
    query: 'complete features specifications capabilities',
    source,
    text: factText,
  }).map((fact) => ({
    kind: fact.kind,
    title: fact.title,
    value: fact.value,
    summary: fact.summary,
    evidence: fact.evidence,
    confidence: 72,
    labels: fact.labels,
  }));
  const facts = [
    ...profileFacts,
    ...sentences
    .map((sentence) => classifySentenceFact(sentence))
    .filter((fact): fact is KnowledgeSemanticFactInput => Boolean(fact)),
  ].slice(0, 80);
  const entities = uniqueStrings([
    source.title,
    extraction?.title,
    ...source.tags,
  ]).slice(0, 12).map((title) => ({
    title,
    kind: title === source.title ? source.sourceType : 'topic',
    summary: `Entity inferred from ${source.title ?? source.id}.`,
    confidence: 45,
  }));
  return {
    summary: extraction?.summary ?? source.summary ?? clampText(factText || text, 360),
    entities,
    facts,
    relations: [],
    gaps: facts.length === 0
      ? [{ question: `What useful facts should be extracted from ${source.title ?? source.id}?`, reason: 'No high-confidence semantic facts were detected.', severity: 'info' }]
      : [],
    wikiPage: {
      title: source.title ? `${source.title} knowledge page` : 'Knowledge page',
      markdown: renderDeterministicWikiPage(source, facts),
    },
    extractor: 'deterministic',
  };
}

function deterministicFactSourceText(extraction: KnowledgeExtractionRecord | null): string {
  const structure = readRecord(extraction?.structure);
  const nestedStructure = readRecord(structure.structure);
  const metadata = readRecord(extraction?.metadata);
  const nestedMetadata = readRecord(structure.metadata);
  return uniqueStrings([
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
    readString(structure.searchText),
    readString(structure.text),
    readString(structure.content),
    readString(nestedStructure.searchText),
    readString(nestedStructure.text),
    readString(nestedStructure.content),
    readString(metadata.searchText),
    readString(metadata.text),
    readString(nestedMetadata.searchText),
    readString(nestedMetadata.text),
  ]).join('\n\n');
}

function cleanDeterministicSourceText(text: string): string {
  return normalizeWhitespace(text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bhomegraph:\/\/\S+/gi, ' ')
    .replace(/\b(?:manual|file|artifact):\/\/\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' '));
}

function classifySentenceFact(sentence: string): KnowledgeSemanticFactInput | null {
  const text = normalizeWhitespace(sentence);
  if (text.length < 28) return null;
  const lower = text.toLowerCase();
  const kind = (() => {
    if (/\b(warning|caution|do not|never|risk|hazard|important)\b/.test(lower)) return 'warning';
    if (/\b(reset|press|hold|select|open|install|pair|configure|enable|disable|connect|setup|set up)\b/.test(lower)) return 'procedure';
    if (/\b(clean|replace|battery|filter|firmware|update|service|maintenance|warranty)\b/.test(lower)) return 'maintenance';
    if (/\b(compatible|works with|requires|supports?|supported|connects? to|integrates? with)\b/.test(lower)) return 'compatibility';
    if (/\b(feature|features|capabilit|function|mode|built-in|includes?|provides?|allows?|can )\b/.test(lower)) return 'feature';
    if (/\b(specification|specifications|model|serial|version|hdmi|usb|port|ports|resolution|volt|watt|hz|inch|mm|gb|mb|ip[0-9])\b/.test(lower)) return 'specification';
    return null;
  })();
  if (!kind) return null;
  return {
    kind,
    title: titleFromSentence(text),
    summary: text,
    evidence: text,
    confidence: 55,
    labels: inferLabels(text),
  };
}

async function persistSemanticExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  semantic: KnowledgeSemanticExtraction,
  options: {
    readonly knowledgeSpaceId?: string | undefined;
    readonly textHash: string;
  },
): Promise<PersistedSemanticExtraction> {
  const spaceId = options.knowledgeSpaceId ?? sourceKnowledgeSpace(source);
  const entities: KnowledgeNodeRecord[] = [];
  const facts: KnowledgeNodeRecord[] = [];
  const gaps: KnowledgeNodeRecord[] = [];

  for (const entity of semantic.entities.slice(0, 60)) {
    const node = await store.upsertNode({
      id: `sem-entity-${semanticHash(spaceId, source.id, entity.title)}`,
      kind: 'knowledge_entity',
      slug: semanticSlug(`${spaceId}-${entity.title}`),
      title: entity.title,
      summary: entity.summary,
      aliases: entity.aliases,
      confidence: entity.confidence ?? 65,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        ...(entity.metadata ?? {}),
        semanticKind: 'entity',
        entityKind: entity.kind ?? 'entity',
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash: options.textHash,
      }),
    });
    entities.push(node);
    await linkSourceToNode(store, source.id, node.id, 'mentions_entity', spaceId, semantic.extractor);
  }

  const sourceLinkedObjects = linkedObjectsForSource(store, source);
  for (const fact of semantic.facts.slice(0, 160)) {
    if (!shouldPersistSemanticFact(fact)) continue;
    const factLinkedObjects = sourceLinkedObjectsForFact(sourceLinkedObjects, fact);
    const sourceLinkedObjectIds = factLinkedObjects.map((node) => node.id);
    const sourceTargetHints = factLinkedObjects.map((node) => ({ id: node.id, kind: node.kind, title: node.title }));
    const targetHints = fact.targetHints?.length ? fact.targetHints : sourceTargetHints;
    const node = await store.upsertNode({
      id: `sem-fact-${semanticHash(spaceId, source.id, fact.kind, fact.title, fact.value ?? fact.summary)}`,
      kind: 'fact',
      slug: semanticSlug(`${spaceId}-${fact.kind}-${fact.title}-${fact.value ?? ''}`),
      title: fact.title,
      summary: fact.summary ?? fact.value ?? fact.evidence,
      aliases: fact.labels,
      confidence: fact.confidence ?? 70,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        semanticKind: 'fact',
        factKind: fact.kind,
        value: fact.value,
        evidence: fact.evidence,
        labels: fact.labels ?? [],
        targetHints,
        ...(sourceLinkedObjectIds.length > 0 ? {
          subject: sourceLinkedObjects[0]?.title,
          subjectIds: sourceLinkedObjectIds,
          linkedObjectIds: sourceLinkedObjectIds,
        } : {}),
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash: options.textHash,
      }),
    });
    facts.push(node);
    await linkSourceToNode(store, source.id, node.id, 'supports_fact', spaceId, semantic.extractor);
    await linkFactToSourceLinkedObjects(store, source.id, node, factLinkedObjects, spaceId, semantic.extractor);
    await linkFactToEntities(store, node, entities, fact, spaceId, semantic.extractor);
  }

  for (const relation of semantic.relations.slice(0, 80)) {
    await linkRelation(store, entities, facts, relation, spaceId, semantic.extractor);
  }

  for (const gap of semantic.gaps.slice(0, 32)) {
    const id = `sem-gap-${semanticHash(spaceId, source.id, gap.question)}`;
    const existing = store.getNode(id);
    const node = await store.upsertNode({
      id,
      kind: 'knowledge_gap',
      slug: semanticSlug(`${spaceId}-gap-${gap.question}`),
      title: gap.question,
      summary: gap.reason,
      confidence: gap.severity === 'error' ? 85 : gap.severity === 'warning' ? 70 : 50,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        semanticKind: 'gap',
        subject: gap.subject,
        severity: gap.severity ?? 'info',
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash: options.textHash,
        repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
        visibility: 'refinement',
        displayRole: 'knowledge-gap',
      }),
    });
    gaps.push(node);
    await linkSourceToNode(store, source.id, node.id, 'has_gap', spaceId, semantic.extractor);
    await store.upsertIssue({
      id: `sem-issue-${semanticHash(spaceId, source.id, gap.question)}`,
      severity: gap.severity ?? 'info',
      code: 'knowledge.semantic_gap',
      message: gap.question,
      status: 'open',
      sourceId: source.id,
      nodeId: node.id,
      metadata: semanticMetadata(spaceId, {
        reason: gap.reason,
        subject: gap.subject,
        namespace: `knowledge:${spaceId}:semantic`,
      }),
    });
  }

  const wikiPage = await persistWikiPage(store, source, semantic, spaceId, options.textHash);
  await markPreviousSemanticNodesStale(store, source.id, spaceId, new Set([
    ...entities.map((node) => node.id),
    ...facts.map((node) => node.id),
    ...gaps.map((node) => node.id),
    ...(wikiPage ? [wikiPage.id] : []),
  ]));
  return { source, skipped: false, extractor: semantic.extractor, facts, entities, gaps, ...(wikiPage ? { wikiPage } : {}) };
}

function shouldPersistSemanticFact(fact: KnowledgeSemanticFactInput): boolean {
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(fact.kind)) return true;
  const signalText = semanticInputFactText([
    fact.title,
    fact.summary,
    fact.value,
    fact.evidence,
    ...(fact.labels ?? []),
  ]);
  const qualityText = semanticInputFactText([
    fact.summary,
    fact.value,
    fact.evidence,
    ...(fact.labels ?? []),
  ]) || signalText;
  return hasConcreteFeatureSignal(signalText) && !isLowValueFeatureOrSpecText(qualityText);
}

function semanticInputFactText(parts: readonly (string | undefined)[]): string {
  const uniqueParts: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const normalized = part.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) continue;
    if (uniqueParts.some((existing) => {
      const existingNormalized = existing.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return existingNormalized === normalized
        || normalized.startsWith(`${existingNormalized} `)
        || existingNormalized.startsWith(`${normalized} `);
    })) continue;
    uniqueParts.push(part);
  }
  return uniqueParts.join(' ');
}

function sourceLinkedObjectsForFact(
  linkedObjects: readonly KnowledgeNodeRecord[],
  fact: KnowledgeSemanticFactInput,
): readonly KnowledgeNodeRecord[] {
  if (linkedObjects.length === 0) return [];
  const hints = uniqueStrings(fact.targetHints ?? []);
  if (hints.length === 0) return linkedObjects;
  return linkedObjects.filter((object) => hints.some((hint) => entityMatchesHint(object, hint)));
}

async function markPreviousSemanticNodesStale(
  store: KnowledgeStore,
  sourceId: string,
  spaceId: string,
  activeIds: ReadonlySet<string>,
): Promise<void> {
  const supersededAt = Date.now();
  const semanticNodes = store.listNodesInSpace(spaceId).filter((node) => (
    node.sourceId === sourceId
    && typeof node.metadata.semanticKind === 'string'
    && node.status !== 'stale'
    && !activeIds.has(node.id)
  ));
  await store.batch(async () => {
    for (const node of semanticNodes) {
      await store.upsertNode({
        id: node.id,
        kind: node.kind,
        slug: node.slug,
        title: node.title,
        summary: node.summary,
        aliases: node.aliases,
        status: 'stale',
        confidence: node.confidence,
        ...(node.sourceId ? { sourceId: node.sourceId } : {}),
        metadata: {
          ...node.metadata,
          supersededAt,
          supersededInSpaceId: spaceId,
        },
      });
    }
  });
}

async function persistWikiPage(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  semantic: KnowledgeSemanticExtraction,
  spaceId: string,
  textHash: string,
): Promise<KnowledgeNodeRecord | undefined> {
  const markdown = semantic.wikiPage?.markdown ?? renderDeterministicWikiPage(source, semantic.facts);
  if (!markdown.trim()) return undefined;
  const page = await store.upsertNode({
    id: `sem-page-${semanticHash(spaceId, source.id)}`,
    kind: 'wiki_page',
    slug: semanticSlug(`${spaceId}-${source.title ?? source.id}-page`),
    title: semantic.wikiPage?.title ?? `${source.title ?? source.id} knowledge page`,
    summary: semantic.summary ?? source.summary,
    aliases: source.title ? [source.title] : [],
    confidence: semantic.extractor === 'llm' ? 80 : 55,
    sourceId: source.id,
    metadata: semanticMetadata(spaceId, {
      semanticKind: 'wiki_page',
      markdown,
      sourceId: source.id,
      extractor: semantic.extractor,
      textHash,
    }),
  });
  await linkSourceToNode(store, source.id, page.id, 'compiled_into_page', spaceId, semantic.extractor);
  return page;
}

async function markSourceSemanticState(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  textHash: string,
  details: Record<string, unknown>,
): Promise<void> {
  await store.upsertSource(applySourceMetadata(source, {
    semanticEnrichment: {
      textHash,
      enrichedAt: Date.now(),
      ...details,
    },
  }));
}

async function linkSourceToNode(
  store: KnowledgeStore,
  sourceId: string,
  nodeId: string,
  relation: string,
  spaceId: string,
  extractor: string,
): Promise<void> {
  await store.upsertEdge({
    fromKind: 'source',
    fromId: sourceId,
    toKind: 'node',
    toId: nodeId,
    relation,
    weight: extractor === 'llm' ? 1 : 0.6,
    metadata: semanticMetadata(spaceId, { extractor }),
  });
}

async function linkFactToEntities(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[],
  input: KnowledgeSemanticFactInput,
  spaceId: string,
  extractor: string,
): Promise<void> {
  const hints = uniqueStrings(input.targetHints ?? []);
  const candidates = hints.length === 0
    ? entities.slice(0, 1)
    : entities.filter((entity) => hints.some((hint) => entityMatchesHint(entity, hint)));
  for (const entity of candidates.slice(0, 6)) {
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: entity.id,
      relation: 'describes',
      metadata: semanticMetadata(spaceId, { extractor }),
    });
  }
}

async function linkFactToSourceLinkedObjects(
  store: KnowledgeStore,
  sourceId: string,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
  spaceId: string,
  extractor: string,
): Promise<void> {
  for (const object of linkedObjects.slice(0, 8)) {
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: object.id,
      relation: 'describes',
      weight: extractor === 'llm' ? 0.88 : 0.72,
      metadata: semanticMetadata(spaceId, { extractor, sourceId }),
    });
  }
}

async function linkRelation(
  store: KnowledgeStore,
  entities: readonly KnowledgeNodeRecord[],
  facts: readonly KnowledgeNodeRecord[],
  relation: KnowledgeSemanticRelationInput,
  spaceId: string,
  extractor: string,
): Promise<void> {
  const from = findSemanticNode([...entities, ...facts], relation.from);
  const to = findSemanticNode([...entities, ...facts], relation.to);
  if (!from || !to || from.id === to.id) return;
  await store.upsertEdge({
    fromKind: 'node',
    fromId: from.id,
    toKind: 'node',
    toId: to.id,
    relation: semanticSlug(relation.relation).replace(/-/g, '_') || 'related_to',
    weight: Math.max(0.1, Math.min(1, (relation.confidence ?? 70) / 100)),
    metadata: semanticMetadata(spaceId, {
      evidence: relation.evidence,
      extractor,
    }),
  });
}

function renderDeterministicWikiPage(
  source: KnowledgeSourceRecord,
  facts: readonly KnowledgeSemanticFactInput[],
): string {
  const grouped = new Map<string, KnowledgeSemanticFactInput[]>();
  for (const fact of facts) {
    grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  }
  const sections = [...grouped.entries()].flatMap(([kind, entries]) => [
    `## ${titleCase(kind)}`,
    '',
    ...entries.slice(0, 24).map((fact) => `- ${fact.title}${fact.value ? `: ${fact.value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}`),
    '',
  ]);
  return [
    `# ${source.title ?? source.id}`,
    '',
    source.summary ?? '',
    '',
    ...sections,
  ].filter((line) => line !== undefined).join('\n').trim();
}

function normalizeFact(value: unknown): KnowledgeSemanticFactInput | null {
  const record = readRecord(value);
  const kind = normalizeFactKind(readString(record.kind));
  const title = readString(record.title);
  if (!kind || !title) return null;
  return {
    kind,
    title,
    ...(readString(record.value) ? { value: readString(record.value) } : {}),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    labels: readStringArray(record.labels),
    targetHints: readStringArray(record.targetHints),
  };
}

function normalizeEntity(value: unknown): KnowledgeSemanticEntityInput | null {
  const record = readRecord(value);
  const title = readString(record.title);
  if (!title) return null;
  return {
    title,
    ...(readString(record.kind) ? { kind: readString(record.kind) } : {}),
    aliases: readStringArray(record.aliases),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    metadata: readRecord(record.metadata),
  };
}

function normalizeRelation(value: unknown): KnowledgeSemanticRelationInput | null {
  const record = readRecord(value);
  const from = readString(record.from);
  const relation = readString(record.relation);
  const to = readString(record.to);
  if (!from || !relation || !to) return null;
  return {
    from,
    relation,
    to,
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
  };
}

function normalizeGap(value: unknown): KnowledgeSemanticGapInput | null {
  const record = readRecord(value);
  const question = readString(record.question);
  if (!question) return null;
  const severity = readString(record.severity);
  return {
    question,
    ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
    ...(readString(record.subject) ? { subject: readString(record.subject) } : {}),
    severity: severity === 'warning' || severity === 'error' ? severity : 'info',
  };
}

function normalizeFactKind(value: string | undefined): KnowledgeSemanticFactInput['kind'] | null {
  switch (value) {
    case 'feature':
    case 'capability':
    case 'specification':
    case 'identity':
    case 'procedure':
    case 'warning':
    case 'maintenance':
    case 'compatibility':
    case 'configuration':
    case 'troubleshooting':
    case 'relationship':
    case 'note':
      return value;
    default:
      return value ? 'note' : null;
  }
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function linkedObjectsForSource(store: KnowledgeStore, source: KnowledgeSourceRecord): KnowledgeNodeRecord[] {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const sourceSpaceId = sourceKnowledgeSpace(source);
  const ids = uniqueStrings([
    ...readStringArray(discovery.linkedObjectIds),
    ...store.listEdges()
      .filter((edge) => edge.fromKind === 'source' && edge.fromId === source.id)
      .filter((edge) => edge.toKind === 'node' && edge.relation === 'source_for')
      .filter((edge) => {
        const edgeSpaceId = readString(edge.metadata.knowledgeSpaceId);
        return !edgeSpaceId || edgeSpaceId === sourceSpaceId;
      })
      .map((edge) => edge.toId),
  ]);
  const nodes: KnowledgeNodeRecord[] = [];
  for (const id of ids) {
    const node = store.getNode(id);
    if (node && node.status !== 'stale') nodes.push(node);
  }
  return canonicalRepairSubjectNodes({
    nodes,
    text: `${source.title ?? ''} ${source.summary ?? ''} ${source.description ?? ''}`,
  });
}

function isFact(value: KnowledgeSemanticFactInput | null): value is KnowledgeSemanticFactInput {
  return Boolean(value);
}

function isEntity(value: KnowledgeSemanticEntityInput | null): value is KnowledgeSemanticEntityInput {
  return Boolean(value);
}

function isRelation(value: KnowledgeSemanticRelationInput | null): value is KnowledgeSemanticRelationInput {
  return Boolean(value);
}

function isGap(value: KnowledgeSemanticGapInput | null): value is KnowledgeSemanticGapInput {
  return Boolean(value);
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function titleFromSentence(sentence: string): string {
  const withoutLead = sentence.replace(/^(the|this|these|it)\s+/i, '');
  return clampText(withoutLead, 96).replace(/[.:;,\s]+$/g, '');
}

function inferLabels(text: string): readonly string[] {
  const lower = text.toLowerCase();
  return uniqueStrings([
    /\bhdmi\b/.test(lower) ? 'hdmi' : undefined,
    /\busb\b/.test(lower) ? 'usb' : undefined,
    /\bbattery\b/.test(lower) ? 'battery' : undefined,
    /\bfirmware\b/.test(lower) ? 'firmware' : undefined,
    /\bwarranty\b/.test(lower) ? 'warranty' : undefined,
    /\bvoice\b/.test(lower) ? 'voice' : undefined,
    /\bnetwork|wi-?fi|ethernet|bluetooth\b/.test(lower) ? 'network' : undefined,
  ]);
}

function entityMatchesHint(entity: KnowledgeNodeRecord, hint: string): boolean {
  const lower = hint.toLowerCase();
  const candidates = uniqueStrings([
    entity.title,
    entity.summary,
    ...entity.aliases,
    readString(entity.metadata.manufacturer),
    readString(entity.metadata.model),
    readString(entity.metadata.modelId),
    readString(entity.metadata.model_id),
  ]).map((entry) => entry.toLowerCase());
  const compactHint = lower.replace(/[\s_-]+/g, '');
  return candidates.some((candidate) => {
    const compactCandidate = candidate.replace(/[\s_-]+/g, '');
    return candidate.includes(lower)
      || lower.includes(candidate)
      || (compactCandidate.length >= 4 && compactHint.includes(compactCandidate))
      || (compactHint.length >= 4 && compactCandidate.includes(compactHint));
  });
}

function findSemanticNode(nodes: readonly KnowledgeNodeRecord[], label: string): KnowledgeNodeRecord | undefined {
  const lower = label.toLowerCase();
  return nodes.find((node) => node.title.toLowerCase() === lower)
    ?? nodes.find((node) => node.title.toLowerCase().includes(lower) || lower.includes(node.title.toLowerCase()));
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function emptyResult(source: KnowledgeSourceRecord, skipped: boolean, reason: string): PersistedSemanticExtraction {
  return { source, skipped, reason, facts: [], entities: [], gaps: [] };
}
