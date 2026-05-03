import { describe, expect, test } from 'bun:test';
import {
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  HomeGraphService,
  KnowledgeSemanticService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import {
  BoilerplateAnswerLlm,
  FakeKnowledgeLlm,
  ForegroundRepairLlm,
  GapRepairAnswerLlm,
  OrderedHomeGraphAskLlm,
  SlowKnowledgeLlm,
  WeakFeatureAnswerLlm,
  createStores,
  waitFor,
} from './_helpers/knowledge-semantic-fixtures.js';

describe('semantic knowledge/wiki enrichment: web repair and subject links', () => {
  test('web gap repair ingests at least two distinct sources for answer gaps', async () => {
    const ingested: Array<{ url: string; title?: string; tags?: readonly string[]; metadata?: Record<string, unknown> }> = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: [
              {
                rank: 1,
                url: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
                title: 'LG 86NANO90UNA specs',
                snippet: 'LG 86NANO90UNA product specifications.',
                domain: 'www.lg.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
              {
                rank: 2,
                url: 'https://www.displayspecifications.com/en/model/example',
                title: 'LG 86NANO90UNA display specifications',
                snippet: 'Display and input specifications for LG 86NANO90UNA.',
                domain: 'www.displayspecifications.com',
                type: 'organic',
                providerId: 'test-search',
                metadata: {},
              },
            ],
            metadata: {},
          };
        },
      },
      ingestService: {
        async ingestUrl(input) {
          ingested.push(input);
          return { source: { id: `source-${ingested.length}`, status: 'indexed' } };
        },
      },
    });

    const result = await repairer({
      spaceId: 'homeassistant:house',
      query: 'what features does the TV have?',
      gaps: [{
        id: 'gap-1',
        kind: 'knowledge_gap',
        slug: 'gap',
        title: 'What are the full TV display, smart platform, audio, and port specifications?',
        summary: 'The manual does not include the product spec sheet.',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [{
        id: 'manual-source',
        connectorId: 'artifact',
        sourceType: 'manual',
        title: 'LG-86NANO90UNA-manual.pdf',
        canonicalUri: 'file://manual.pdf',
        tags: ['manual', 'tv'],
        status: 'indexed',
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      linkedObjects: [{
        id: 'tv-node',
        kind: 'ha_device',
        slug: 'tv',
        title: 'LG webOS Smart TV',
        aliases: [],
        status: 'active',
        confidence: 90,
        metadata: { knowledgeSpaceId: 'homeassistant:house', manufacturer: 'LG', model: '86NANO90UNA' },
        createdAt: 1,
        updatedAt: 1,
      }],
      facts: [],
    });

    expect(result?.searched).toBe(true);
    expect(result?.ingestedSourceIds).toEqual(['source-1', 'source-2']);
    expect(result?.sourceAssessments?.[0]?.confidence).toBeGreaterThanOrEqual(70);
    expect(ingested).toHaveLength(2);
    expect(ingested[0]?.metadata?.sourceDiscovery).toBeDefined();
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).confidence).toBeGreaterThanOrEqual(70);
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).confidenceReasons).toContain('model:86NANO90UNA');
    expect(ingested[0]?.tags).toContain('semantic-gap-repair');
  });

  test('web gap repair escalates targeted searches and caps accepted sources at five', async () => {
    const queries: string[] = [];
    const ingested: Array<{ url: string; metadata?: Record<string, unknown> }> = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          queries.push(request.query);
          const broadResults = [{
            rank: 1,
            url: 'https://example.com/tv-buying-guide',
            title: 'TV buying guide',
            snippet: 'General television advice.',
            domain: 'example.com',
            type: 'organic' as const,
            providerId: 'test-search',
            metadata: {},
          }];
          const targetedResults = ['lg.com', 'manualsnet.com', 'zkelectronics.com', 'fullspecs.net', 'displayspecifications.com', 'tab-tv.com']
            .map((domain, index) => ({
              rank: index + 1,
              url: `https://${domain}/lg-86nano90una-specs-${index}`,
              title: `LG 86NANO90UNA specifications ${index}`,
              snippet: 'LG 86NANO90UNA ports, Bluetooth, HDR, refresh rate, audio, and smart TV specifications.',
              domain,
              type: 'organic' as const,
              providerId: 'test-search',
              metadata: {},
            }));
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: queries.length === 1 ? broadResults : targetedResults,
            metadata: {},
          };
        },
      },
      ingestService: {
        async ingestUrl(input) {
          ingested.push(input);
          return { source: { id: `source-${ingested.length}`, status: 'indexed' } };
        },
      },
      maxSources: 5,
    });

    const result = await repairer({
      spaceId: 'homeassistant:house',
      query: 'What ports and Bluetooth support does the TV have?',
      gaps: [{
        id: 'gap-ports',
        kind: 'knowledge_gap',
        slug: 'ports-gap',
        title: 'What other input/output ports are present on the LG 86NANO90UNA?',
        summary: 'The manual does not include a complete I/O specification list.',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [],
      linkedObjects: [{
        id: 'tv-node',
        kind: 'ha_device',
        slug: 'tv',
        title: 'LG webOS Smart TV',
        aliases: [],
        status: 'active',
        confidence: 90,
        metadata: { knowledgeSpaceId: 'homeassistant:house', manufacturer: 'LG', model: '86NANO90UNA' },
        createdAt: 1,
        updatedAt: 1,
      }],
      facts: [],
      maxSources: 5,
    });

    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(result?.ingestedSourceIds).toHaveLength(5);
    expect(ingested).toHaveLength(5);
    expect((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).checkedSourceLimit).toBe(5);
    expect(Array.isArray((ingested[0]?.metadata?.sourceDiscovery as Record<string, unknown>).searchQueries)).toBe(true);
  });

  test('web gap repair reuses pending official sources as accepted evidence', async () => {
    const ingested: unknown[] = [];
    const repairer = createWebKnowledgeGapRepairer({
      searchService: {
        async search(request) {
          return {
            providerId: 'test-search',
            providerLabel: 'Test Search',
            query: request.query,
            verbosity: 'snippets',
            results: [],
            metadata: {},
          };
        },
      },
      ingestService: {
        async ingestUrl(input) {
          ingested.push(input);
          return { source: { id: `source-${ingested.length}`, status: 'indexed' } };
        },
      },
    });

    const result = await repairer({
      spaceId: 'homeassistant:house',
      query: 'What Bluetooth and ports does the TV have?',
      gaps: [{
        id: 'gap-existing-source',
        kind: 'knowledge_gap',
        slug: 'existing-source-gap',
        title: 'What Bluetooth and port specifications does the LG 86NANO90UNA have?',
        summary: 'The local manual did not include a complete product spec list.',
        aliases: [],
        status: 'active',
        confidence: 70,
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      sources: [{
        id: 'lg-official-source',
        connectorId: 'semantic-gap-repair',
        sourceType: 'url',
        title: 'LG 86NANO90UNA official product specifications',
        canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
        summary: 'Official LG 86NANO90UNA product specifications.',
        tags: ['semantic-gap-repair'],
        status: 'pending',
        metadata: { knowledgeSpaceId: 'homeassistant:house' },
        createdAt: 1,
        updatedAt: 1,
      }],
      linkedObjects: [{
        id: 'tv-node',
        kind: 'ha_device',
        slug: 'tv',
        title: 'LG webOS Smart TV',
        aliases: [],
        status: 'active',
        confidence: 90,
        metadata: { knowledgeSpaceId: 'homeassistant:house', manufacturer: 'LG', model: '86NANO90UNA' },
        createdAt: 1,
        updatedAt: 1,
      }],
      facts: [],
    });

    expect(result?.evidenceSufficient).toBe(true);
    expect(result?.acceptedSourceIds).toEqual(['lg-official-source']);
    expect(result?.ingestedSourceIds).toEqual([]);
    expect(ingested).toHaveLength(0);
    expect(result?.sourceAssessments?.some((entry) => entry.accepted && entry.reasons.includes('already-indexed'))).toBe(true);
  });

  test('self-improvement promotes accepted repair evidence into typed subject facts', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      summary: 'Official LG 86NANO90UNA product specifications.',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: {
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    await store.upsertExtraction({
      sourceId: official.id,
      extractorId: 'web',
      format: 'html',
      structure: {
        searchText: 'LG 86NANO90UNA specifications include a 4K UHD NanoCell display, 120 Hz refresh rate, HDR10 and Dolby Vision support, HDMI eARC, webOS smart TV features, Wi-Fi, Bluetooth, and USB connectivity.',
      },
      metadata: { knowledgeSpaceId: spaceId },
    });
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-promote',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const passport = await store.upsertNode({
      kind: 'ha_device_passport',
      slug: 'lg-tv-passport',
      title: 'LG webOS Smart TV passport',
      aliases: [],
      confidence: 80,
      metadata: { knowledgeSpaceId: spaceId },
    });
    const integration = await store.upsertNode({
      kind: 'ha_integration',
      slug: 'webostv',
      title: 'LG webOS TV integration',
      aliases: ['webostv'],
      confidence: 80,
      metadata: { knowledgeSpaceId: spaceId },
    });
    const gap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'official-source-gap',
      title: 'What refresh rate, HDR formats, HDMI 2.1 or gaming features, and smart TV features does the LG 86NANO90UNA have?',
      aliases: [],
      confidence: 75,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'gap',
        gapKind: 'answer',
        sourceIds: [official.id],
        linkedObjectIds: [passport.id, integration.id, device.id],
      },
    });
    const semantic = new KnowledgeSemanticService(store, {
      gapRepairer: async () => ({
        searched: true,
        evidenceSufficient: true,
        acceptedSourceIds: [official.id],
        ingestedSourceIds: [],
        skippedUrls: [],
      }),
    });

    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const facts = store.listNodes(100).filter((node) => node.kind === 'fact' && node.metadata.extractor === 'repair-promotion');
    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'what features does the LG 86NANO90UNA have?',
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(result.closedGaps).toBe(1);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((fact) => fact.metadata.sourceAuthority === 'official-vendor')).toBe(true);
    expect(facts.every((fact) => JSON.stringify(fact.metadata.linkedObjectIds) === JSON.stringify([device.id]))).toBe(true);
    expect(facts.every((fact) => JSON.stringify(fact.metadata.subjectIds) === JSON.stringify([device.id]))).toBe(true);
    expect(facts.every((fact) => fact.metadata.subject === 'LG webOS Smart TV')).toBe(true);
    expect(facts.every((fact) => Array.isArray(fact.metadata.targetHints) && fact.metadata.targetHints.length === 1)).toBe(true);
    expect(store.listEdges().some((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === device.id && edge.relation === 'describes')).toBe(true);
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('120 Hz');
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('evidence');
    expect(answer.answer.text.trim().startsWith('-')).toBe(false);
    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.linkedObjects.map((node) => node.id)).toEqual([device.id]);
    expect(answer.answer.facts.some((fact) => fact.metadata.extractor === 'repair-promotion')).toBe(true);
    expect(answer.answer.facts.some((fact) => fact.title === 'Display and picture specifications')).toBe(true);
    expect(answer.answer.facts.some((fact) => fact.title === 'Smart TV platform and integrations')).toBe(true);
  });

  test('strict Home Graph answers admit repaired sources linked to the subject', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-tv-strict',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const generated = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG webOS Smart TV passport',
      canonicalUri: 'homegraph://passport/lg-tv',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId, homeGraphGeneratedPage: true },
    });
    const official = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: {
          trustReason: 'official-vendor-domain, model:86NANO90UNA',
          sourceRank: 1,
        },
      },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-display-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution, 100/120 Hz refresh rate, HDR10, and Dolby Vision.',
      aliases: ['display', 'picture'],
      status: 'active',
      confidence: 90,
      sourceId: official.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD resolution, 100/120 Hz refresh rate, HDR10, Dolby Vision',
        sourceId: official.id,
        linkedObjectIds: [device.id],
        extractor: 'repair-promotion',
        sourceAuthority: 'official-vendor',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: official.id,
      toKind: 'node',
      toId: device.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId, linkedBy: 'semantic-gap-repair' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: official.id,
      toKind: 'node',
      toId: fact.id,
      relation: 'supports_fact',
      metadata: { knowledgeSpaceId: spaceId },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: device.id,
      relation: 'describes',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'What refresh rate and HDR features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      strictCandidates: true,
      candidateSourceIds: [generated.id],
      linkedObjects: [device],
    });

    expect(answer.answer.sources[0]?.id).toBe(official.id);
    expect(answer.answer.sources.map((source) => source.id)).not.toContain(generated.id);
    expect(answer.answer.linkedObjects.map((node) => node.id)).toEqual([device.id]);
    expect(answer.answer.facts.map((entry) => entry.id)).toContain(fact.id);
    const returnedFact = answer.answer.facts.find((entry) => entry.id === fact.id);
    expect(returnedFact?.subject).toBe('LG webOS Smart TV');
    expect(returnedFact?.subjectIds).toEqual([device.id]);
    expect(returnedFact?.linkedObjectIds).toEqual([device.id]);
    expect(returnedFact?.targetHints?.[0]).toMatchObject({ id: device.id, kind: 'ha_device', title: 'LG webOS Smart TV' });
    expect(returnedFact?.metadata.targetHints).toEqual(returnedFact?.targetHints);
  });

  test('answer fact subject contract does not infer links from the only linked object', async () => {
    const { store } = createStores();
    const spaceId = homeAssistantKnowledgeSpaceId('house');
    const semantic = new KnowledgeSemanticService(store);
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-unlinked-answer-tv',
      title: 'LG webOS Smart TV',
      aliases: ['LG TV'],
      confidence: 90,
      metadata: { knowledgeSpaceId: spaceId, manufacturer: 'LG', model: '86NANO90UNA' },
    });
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Unlinked TV comparison notes',
      canonicalUri: 'https://example.test/tv-comparison',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'unlinked-tv-comparison-fact',
      title: 'Display features',
      summary: 'Display features: 4K UHD resolution, HDR10, Dolby Vision, and 120 Hz refresh rate.',
      aliases: [],
      confidence: 88,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: source.id,
        extractor: 'repair-promotion',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: fact.id,
      relation: 'supports_fact',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const answer = await semantic.answer({
      knowledgeSpaceId: spaceId,
      query: 'What refresh rate and HDR features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
      strictCandidates: true,
      candidateSourceIds: [source.id],
      linkedObjects: [device],
    });
    const returnedFact = answer.answer.facts.find((entry) => entry.id === fact.id);

    expect(returnedFact).toBeDefined();
    expect(returnedFact?.linkedObjectIds).toBeUndefined();
    expect(returnedFact?.subjectIds).toBeUndefined();
    expect(returnedFact?.metadata.linkedObjectIds).toBeUndefined();
    expect(returnedFact?.metadata.subjectIds).toBeUndefined();
  });

});
