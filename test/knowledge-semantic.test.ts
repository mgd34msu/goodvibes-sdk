import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import {
  createProviderBackedKnowledgeSemanticLlm,
  HomeGraphService,
  KnowledgeSemanticService,
  homeAssistantKnowledgeSpaceId,
  type KnowledgeSemanticLlm,
} from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('semantic knowledge/wiki enrichment', () => {
  test('persists source-grounded facts, wiki pages, and synthesized answers', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Device manual',
      canonicalUri: 'manual://device',
      tags: ['manual'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      summary: 'Device manual.',
      excerpt: 'The device supports Dolby Vision and includes four HDMI ports.',
      sections: ['Features'],
      structure: { searchText: 'The device supports Dolby Vision and includes four HDMI ports.' },
    });

    const enriched = await semantic.enrichSource(source.id);
    const answer = await semantic.answer({ query: 'what features does the device have?', includeSources: true });
    const nodes = store.listNodes(100);

    expect(enriched?.facts.map((fact) => fact.title)).toContain('HDMI inputs');
    expect(nodes.some((node) => node.kind === 'wiki_page' && String(node.metadata.markdown ?? '').includes('Dolby Vision'))).toBe(true);
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('four HDMI ports');
    expect(answer.answer.sources.map((entry) => entry.id)).toContain(source.id);
    expect(answer.answer.facts.some((fact) => fact.title === 'HDMI inputs')).toBe(true);
  });

  test('falls back to deterministic facts when no LLM is configured', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Fallback manual',
      canonicalUri: 'manual://fallback',
      tags: ['manual'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'test',
      format: 'text',
      excerpt: 'The controller includes local control mode. The controller supports Wi-Fi configuration. The controller has USB-C power.',
      sections: ['Features'],
      structure: {
        searchText: 'The controller includes local control mode. The controller supports Wi-Fi configuration. The controller has USB-C power.',
      },
    });

    const enriched = await semantic.enrichSource(source.id);
    const answer = await semantic.answer({ query: 'controller features', includeSources: true });

    expect(enriched?.facts.length).toBeGreaterThan(0);
    expect(enriched?.wikiPage?.kind).toBe('wiki_page');
    expect(answer.answer.synthesized).toBe(false);
    expect(answer.answer.text).toContain('local control mode');
  });

  test('strict candidate answers exclude unrelated sources and off-intent facts', async () => {
    const { store } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const tv = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'LG TV manual',
      canonicalUri: 'manual://tv',
      tags: ['manual', 'tv'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: tv.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: [
        'The TV supports Dolby Vision.',
        'Ultra High Speed HDMI cables are optional extras and may be purchased separately.',
        'HDMI and USB devices should have bezels less than 10 mm so they fit the TV port.',
        'Use a USB extension cable if the USB flash drive does not fit your TV USB port.',
        'Fasten the stand screws to prevent the TV from overturning during setup.',
        'Product specifications or contents of this manual may be changed without prior notice.',
        'The items supplied with your product may vary depending upon the model.',
        'Warning: do not use uncertified HDMI cables.',
        ].join(' '),
      },
    });
    const plug = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Kasa plug manual',
      canonicalUri: 'manual://plug',
      tags: ['manual', 'plug'],
      status: 'indexed',
    });
    await store.upsertExtraction({
      sourceId: plug.id,
      extractorId: 'test',
      format: 'text',
      structure: {
        searchText: 'The smart plug features energy monitoring and scheduling.',
      },
    });
    await semantic.reindex({ force: true });

    const answer = await semantic.answer({
      query: 'what features does the TV have?',
      candidateSourceIds: [tv.id],
      strictCandidates: true,
      includeSources: true,
      includeLinkedObjects: true,
    });

    expect(answer.answer.sources.map((source) => source.id)).toEqual([tv.id]);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).not.toContain('Kasa');
    expect(answer.answer.text).not.toContain('uncertified HDMI cables');
    expect(answer.answer.text).not.toContain('prior notice');
    expect(answer.answer.text).not.toContain('items supplied');
    expect(answer.answer.facts.every((fact) => fact.sourceId === tv.id)).toBe(true);
    expect(answer.answer.linkedObjects).toHaveLength(0);
    const factText = answer.answer.facts.map((fact) => `${fact.title} ${fact.summary ?? ''}`).join('\n');
    expect(factText).not.toContain('prior notice');
    expect(factText).not.toContain('optional extras');
    expect(factText).not.toContain('bezels');
    expect(factText).not.toContain('USB extension cable');
    expect(factText).not.toContain('overturning');
  });

  test('Home Graph ask uses the shared semantic layer instead of raw snippets', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store, { llm: new FakeKnowledgeLlm() });
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'tv', name: 'Living Room TV', areaId: 'living-room', model: 'MODEL-1' }],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Living Room TV manual',
      body: 'The Living Room TV supports Dolby Vision and includes four HDMI ports.',
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the living room tv have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });

    expect(answer.spaceId).toBe(homeAssistantKnowledgeSpaceId('house'));
    expect(answer.answer.synthesized).toBe(true);
    expect(answer.answer.text).toContain('Dolby Vision');
    expect(answer.answer.text).toContain('four HDMI ports');
    expect(answer.answer.sources.some((source) => source.title === 'Living Room TV manual')).toBe(true);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toEqual(['Living Room TV']);
    expect(answer.answer.linkedObjects.every((node) => typeof node.metadata.semanticKind !== 'string')).toBe(true);
    expect(page.markdown).toContain('Extracted Device Facts');
    expect(page.markdown).toContain('HDMI inputs');
  });

  test('Home Graph semantic ask does not let unrelated semantic pages become object anchors', async () => {
    const { store, artifactStore } = createStores();
    const semantic = new KnowledgeSemanticService(store);
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    await service.syncSnapshot({
      installationId: 'house',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [
        { id: 'tv', name: 'LG webOS Smart TV', areaId: 'living-room', manufacturer: 'LG', model: '86NANO90UNA' },
        { id: 'plug', name: 'Kasa Smart Wi-Fi Plug', areaId: 'living-room', manufacturer: 'Kasa', model: 'KP125M' },
      ],
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'LG 86NANO90UNA manual',
      body: [
        'The LG TV supports HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.',
        'Ultra High Speed HDMI cables are optional extras and may be purchased separately.',
        'Fasten the stand screws to prevent the TV from overturning during setup.',
      ].join(' '),
      tags: ['manual', 'tv'],
      target: { kind: 'device', id: 'tv', relation: 'has_manual' },
    });
    await service.ingestNote({
      installationId: 'house',
      title: 'Kasa Smart Wi-Fi Plug Slim with Energy Monitoring',
      body: 'Features include energy monitoring, Matter support, scheduling, and away mode.',
      tags: ['manual', 'plug'],
      target: { kind: 'device', id: 'plug', relation: 'has_manual' },
    });
    await semantic.reindex({
      knowledgeSpaceId: homeAssistantKnowledgeSpaceId('house'),
      force: true,
    });

    const answer = await service.ask({
      installationId: 'house',
      query: 'what features does the TV have?',
      includeSources: true,
      includeLinkedObjects: true,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house', deviceId: 'tv' });
    const answerText = [
      answer.answer.text,
      ...answer.answer.sources.map((source) => source.title ?? ''),
      ...answer.answer.linkedObjects.map((node) => node.title),
      ...answer.answer.facts.map((fact) => `${fact.title} ${fact.summary ?? ''}`),
      page.markdown,
    ].join('\n');

    expect(answer.answer.text).toContain('HDR10');
    expect(answer.answer.text).toContain('HDMI eARC');
    expect(answer.answer.sources.map((source) => source.title)).toEqual(['LG 86NANO90UNA manual']);
    expect(answer.answer.linkedObjects.map((node) => node.title)).toContain('LG webOS Smart TV');
    expect(answer.answer.linkedObjects.every((node) => typeof node.metadata.semanticKind !== 'string')).toBe(true);
    expect(answerText).not.toContain('Kasa');
    expect(answerText).not.toContain('energy monitoring');
    expect(answerText).not.toContain('optional extras');
    expect(answerText).not.toContain('overturning');
  });

  test('provider-backed semantic LLM calls time out and abort provider requests', async () => {
    let aborted = false;
    const semanticLlm = createProviderBackedKnowledgeSemanticLlm({
      getCurrentModel: () => ({ id: 'model', provider: 'test' }),
      getForModel: () => ({
        name: 'test',
        models: ['model'],
        chat: ({ signal }: { readonly signal?: AbortSignal }) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve({
              content: '',
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: 'error',
            });
          }, { once: true });
        }),
      }),
    } as never, { timeoutMs: 25 });

    const startedAt = Date.now();
    const result = await semanticLlm.completeText({
      purpose: 'test-timeout',
      systemPrompt: 'test',
      prompt: 'test',
      timeoutMs: 25,
    });

    expect(result).toBeNull();
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

class FakeKnowledgeLlm implements KnowledgeSemanticLlm {
  async completeJson(input: { readonly purpose: string }): Promise<unknown | null> {
    if (input.purpose === 'knowledge-semantic-enrichment') {
      return {
        summary: 'Manual describing display and input features.',
        entities: [{ title: 'Device', kind: 'device', aliases: ['TV'], summary: 'The described device.', confidence: 80 }],
        facts: [
          {
            kind: 'feature',
            title: 'Dolby Vision support',
            summary: 'The device supports Dolby Vision.',
            evidence: 'supports Dolby Vision',
            confidence: 92,
            labels: ['display'],
            targetHints: ['Device'],
          },
          {
            kind: 'specification',
            title: 'HDMI inputs',
            value: 'four HDMI ports',
            summary: 'The device includes four HDMI ports.',
            evidence: 'includes four HDMI ports',
            confidence: 94,
            labels: ['hdmi'],
            targetHints: ['Device'],
          },
        ],
        relations: [],
        gaps: [],
        wikiPage: {
          title: 'Device knowledge page',
          markdown: '# Device\n\n## Features\n\n- Supports Dolby Vision.\n- Includes four HDMI ports.\n',
        },
      };
    }
    return {
      answer: 'The device supports Dolby Vision and has four HDMI ports.',
      confidence: 91,
      usedSourceIds: [],
      usedNodeIds: [],
      gaps: [],
    };
  }

  async completeText(): Promise<string | null> {
    return null;
  }
}

function createStores(): { readonly store: KnowledgeStore; readonly artifactStore: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-semantic-'));
  tmpRoots.push(root);
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  };
}
