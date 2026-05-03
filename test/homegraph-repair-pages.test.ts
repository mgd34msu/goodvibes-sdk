import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import {
  HomeGraphService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { extractKnowledgeArtifact } from '../packages/sdk/src/platform/knowledge/extractors.js';
import { refreshDevicePagesForHomeGraphAsk } from '../packages/sdk/src/platform/knowledge/home-graph/ask-page-refresh.js';
import { HOME_GRAPH_PAGE_POLICY_VERSION } from '../packages/sdk/src/platform/knowledge/home-graph/generated-pages.js';
import type { HomeGraphAskResult } from '../packages/sdk/src/platform/knowledge/home-graph/types.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph repair and generated pages', () => {
  test('rejects PDFs when no readable text can be extracted', async () => {
    const compressed = deflateSync(Buffer.from([0, 1, 2, 3, 255, 254, 253, 128, 127, 16, 24, 31]));
    const buffer = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'binary'),
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'binary'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'binary'),
    ]);

    await expect(extractKnowledgeArtifact({
      id: 'bad-pdf',
      mimeType: 'application/pdf',
      filename: 'bad.pdf',
    }, buffer)).rejects.toThrow('PDF extraction failed');
  });

  test('reindexes existing manuals, auto-links them to matching devices, and regenerates source-backed pages', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'living-room', name: 'Living Room' }],
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA', areaId: 'living-room' }],
      entities: [{
        entity_id: 'media_player.lg_webos_smart_tv',
        name: 'LG webOS Smart TV',
        device_id: 'lg-tv',
        area_id: 'living-room',
        platform: 'webostv',
      }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const artifact = await artifactStore.createFromStream({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'LG-86NANO90UNA-manual.pdf',
      stream: [createCompressedPdfBuffer('LG 86NANO90UNA TV features include Dolby Vision IQ, HDR10, HDMI eARC, Filmmaker Mode, Game Optimizer, and Magic Remote voice control.')],
      metadata,
    });
    const manual = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'manual',
      title: 'LG 86NANO90UNA owner manual',
      canonicalUri: 'homegraph://house-1/lg-86nano90una-manual',
      tags: ['homeassistant', 'home-graph', 'manual', 'tv'],
      status: 'indexed',
      artifactId: artifact.id,
      metadata,
    });
    await store.upsertExtraction({
      sourceId: manual.id,
      artifactId: artifact.id,
      extractorId: 'pdf',
      format: 'pdf',
      title: 'PDF document',
      summary: 'PDF extraction produced limited text; OCR is not used in-core.',
      sections: [],
      links: [],
      estimatedTokens: 1,
      structure: { extractedStringCount: 0 },
      metadata,
    });

    const reindex = await service.reindex({ installationId: 'house-1' });
    const ask = await service.ask({ installationId: 'house-1', query: 'what features does the LG TV have?' });
    const passport = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });
    const pages = await service.listPages({ installationId: 'house-1' });
    const issues = await service.listIssues({ installationId: 'house-1', status: 'open', limit: 100 });

    expect(reindex.reparsed).toBe(1);
    expect(reindex.changedSourceCount).toBeGreaterThanOrEqual(1);
    expect(reindex.forcedSourceCount).toBe(0);
    expect(reindex.skippedGeneratedPageArtifactCount).toBeGreaterThan(0);
    expect(reindex.refreshedGeneratedPageCount).toBeGreaterThanOrEqual(1);
    expect(reindex.generatedPagePolicyVersion).toBe(HOME_GRAPH_PAGE_POLICY_VERSION);
    expect(reindex.linked?.[0]?.node.title).toBe('LG webOS Smart TV');
    expect(reindex.linked?.[0]?.relation).toBe('has_manual');
    expect(reindex.generated?.devicePassports).toBeGreaterThanOrEqual(1);
    expect(passport.missingFields).not.toContain('battery type');
    expect(issues.issues.some((issue) => issue.code === 'homegraph.device.missing_manual' && issue.message.includes('LG webOS Smart TV'))).toBe(false);
    expect(issues.issues.some((issue) => issue.code === 'homegraph.device.unknown_battery' && issue.message.includes('LG webOS Smart TV'))).toBe(false);
    expect(ask.answer.text).toContain('Dolby Vision');
    expect(ask.answer.text).toContain('HDMI eARC');
    expect(passport.markdown).toContain('## Verified Device Facts');
    expect(passport.markdown).toContain('Dolby Vision');
    expect(passport.markdown).not.toContain('SpeakerCompare');
    expect(passport.markdown).not.toContain('equal power mode');
    expect(passport.markdown).not.toContain('has no linked manual or source');
    expect(pages.pages.some((page) => page.markdown?.includes('Dolby Vision'))).toBe(true);

    const passportPage = pages.pages.find((page) => page.source.title === 'LG webOS Smart TV passport');
    expect(passportPage).toBeDefined();
    await store.upsertSource({
      ...passportPage!.source,
      metadata: {
        ...passportPage!.source.metadata,
        pagePolicyVersion: 'old-test-policy',
      },
    });
    const policyReindex = await service.reindex({ installationId: 'house-1' });
    expect(policyReindex.reparsed).toBe(0);
    expect(policyReindex.generated?.devicePassports).toBeGreaterThanOrEqual(1);
  });

  test('keeps commercial and manual safety boilerplate out of generated device pages', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const metadata = {
      knowledgeSpaceId: spaceId,
      namespace: spaceId,
      homeGraph: true,
      homeAssistant: { installationId: 'house-1' },
    };
    const text = [
      'SpeakerCompare simulates the sound of speakers through headphones.',
      'In equal power mode, you hear loudness differences between speakers.',
      'Do not place the TV and/or remote control in direct sunlight.',
      'If you do not use a certified HDMI cable, the screen may not display or a connection error may occur.',
      'ULTRA HD broadcast standards have not been confirmed and may vary by region.',
      'External Devices Supported USB to Serial SERVICE ONLY.',
      'Shake the Magic Remote to make the pointer appear on the screen.',
      'The LG 86NANO90UNA supports Dolby Vision HDR, HDMI eARC, and Game Optimizer.',
      'DTV Audio Supported Codec: MPEG and Dolby Digital.',
    ].join('\n');
    const artifact = await artifactStore.create({
      kind: 'document',
      mimeType: 'text/plain',
      filename: 'lg-specs.txt',
      text,
      metadata,
    });
    const source = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'LG 86NANO90UNA specs',
      canonicalUri: 'homegraph://house-1/lg-specs',
      tags: ['homeassistant', 'home-graph', 'manual'],
      status: 'indexed',
      artifactId: artifact.id,
      metadata,
    });
    await store.upsertExtraction({
      sourceId: source.id,
      artifactId: artifact.id,
      extractorId: 'text',
      format: 'text',
      summary: 'LG specs',
      structure: { searchText: text },
      metadata,
    });
    const remoteGap = await store.upsertNode({
      id: 'remote-gap',
      kind: 'knowledge_gap',
      slug: 'remote-gap',
      title: 'Does the TV support Magic Remote voice recognition?',
      summary: 'Accessory-specific semantic refinement gap.',
      aliases: [],
      confidence: 70,
      metadata: {
        ...metadata,
        semanticKind: 'gap',
        gapKind: 'answer',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: remoteGap.id,
      relation: 'has_gap',
      metadata,
    });
    await store.upsertIssue({
      id: 'remote-gap-issue',
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: 'Does the TV support Magic Remote voice recognition?',
      status: 'open',
      sourceId: source.id,
      nodeId: remoteGap.id,
      metadata,
    });
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: source.id,
      target: { kind: 'device', id: 'lg-tv', relation: 'has_manual' },
    });

    const passport = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(passport.markdown).toContain('Display and picture specifications');
    expect(passport.markdown).toContain('Dolby Vision');
    expect(passport.markdown).toContain('Audio capabilities');
    expect(passport.markdown).toContain('Dolby audio formats');
    expect(passport.markdown).not.toContain('SpeakerCompare');
    expect(passport.markdown).not.toContain('equal power mode');
    expect(passport.markdown).not.toContain('Do not place the TV');
    expect(passport.markdown).not.toContain('certified HDMI cable');
    expect(passport.markdown).not.toContain('ULTRA HD broadcast standards');
    expect(passport.markdown).not.toContain('USB to Serial');
    expect(passport.markdown).not.toContain('Magic Remote');
    expect(passport.markdown).not.toContain('voice recognition');
    expect(passport.markdown).not.toContain('knowledge.answer_gap');
  });

  test('generated device pages render canonical facts without raw duplicated evidence lines', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const browse = await service.browse({ installationId: 'house-1' });
    const device = browse.nodes.find((node) => node.kind === 'ha_device' && node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: device!.id,
      relation: 'source_for',
      metadata: { knowledgeSpaceId: spaceId },
    });
    for (const entry of [
      {
        slug: 'display-picture-specs',
        title: 'Display and picture specifications',
        summary: 'Display and picture specifications: 4K UHD resolution, HDR10, and Dolby Vision.',
        value: '4K UHD resolution, HDR10, Dolby Vision',
      },
      {
        slug: 'duplicate-display-picture-specs',
        title: 'Display and picture specifications',
        summary: 'Display and picture specifications: 4K UHD resolution, HDR10, and Dolby Vision.',
        value: '4K UHD resolution, HDR10, Dolby Vision',
      },
      {
        slug: 'raw-port-fragment',
        title: '01 x Ethernet RJ45 Audio Audio Speakers 2 x 10W Built-in Subwoofer 2 x 10 Features OS webOS 5',
        summary: '01 x Ethernet RJ45 Audio Audio Speakers 2 x 10W Built-in Subwoofer 2 x 10 Features OS webOS 5',
      },
      {
        slug: 'commercial-comparison',
        title: 'This gives you a more direct comparison',
        summary: 'This gives you a more direct comparison of speaker output.',
      },
      {
        slug: 'truncated-freesync-fragment',
        title: 'AMD Freesync Premium and HGiG mode…',
        summary: 'AMD Freesync Premium and HGiG mode… AMD Freesync Premium and HGiG mode for smoother gameplay.',
      },
      {
        slug: 'selected-features-marketing',
        title: 'Selected Features Nano Cell Technology',
        summary: 'Selected Features Nano Cell Technology and webOS marketing copy.',
      },
      {
        slug: 'affiliate-ranking-junk',
        title: 'Amazon affiliate ranking system',
        summary: 'Amazon affiliate ranking system and latest price comparison.',
      },
      {
        slug: 'marketplace-url-junk',
        title: 'Amazon product listing',
        summary: 'https://www.amazon.com/example-product Sponsored marketplace seller listing.',
      },
      {
        slug: 'routing-fragment',
        title: 'Source-backed facts identify semantic-gap-repair',
        summary: 'Source-backed facts identify semantic-gap-repair route fragments instead of a device feature.',
      },
      {
        slug: 'speaker-channel-fragment',
        title: 'Compatibility line 40W/WF:20W/10W per Channel',
        summary: 'Compatibility line 40W/WF:20W/10W per Channel from a source table.',
      },
      {
        slug: 'audio-speaker-spec',
        title: 'Audio capabilities',
        summary: 'Audio capabilities: 2 x 10W speakers.',
        value: '2 x 10W speakers',
      },
    ] as const) {
      const fact = await store.upsertNode({
        kind: 'fact',
        slug: entry.slug,
        title: entry.title,
        summary: entry.summary,
        aliases: [],
        status: 'active',
        confidence: 90,
        sourceId: source.id,
        metadata: {
          knowledgeSpaceId: spaceId,
          semanticKind: 'fact',
          factKind: 'specification',
          ...(entry.value ? { value: entry.value } : {}),
          sourceId: source.id,
          subject: device!.title,
          subjectIds: [device!.id],
          linkedObjectIds: [device!.id],
          targetHints: [{ id: device!.id, kind: device!.kind, title: device!.title }],
          extractor: 'repair-promotion',
          sourceAuthority: 'official-vendor',
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
      await store.upsertEdge({
        fromKind: 'node',
        fromId: fact.id,
        toKind: 'node',
        toId: device!.id,
        relation: 'describes',
        metadata: { knowledgeSpaceId: spaceId },
      });
    }

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(page.markdown).toContain('Display and picture specifications: 4K UHD resolution, HDR10, Dolby Vision');
    expect(page.markdown).toContain('Audio capabilities: 2 x 10W speakers');
    expect(page.markdown.match(/Display and picture specifications/g)?.length).toBe(1);
    expect(page.markdown).not.toContain('01 x Ethernet RJ45');
    expect(page.markdown).not.toContain('This gives you a more direct comparison');
    expect(page.markdown).not.toContain('AMD Freesync Premium and HGiG mode');
    expect(page.markdown).not.toContain('Selected Features');
    expect(page.markdown).not.toContain('Amazon affiliate');
    expect(page.markdown).not.toContain('Amazon product listing');
    expect(page.markdown).not.toContain('semantic-gap-repair');
    expect(page.markdown).not.toContain('40W/WF');
  });

  test('generated device pages include sources attached through promoted subject facts', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const browse = await service.browse({ installationId: 'house-1' });
    const device = browse.nodes.find((node) => node.kind === 'ha_device' && node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-speaker-spec',
      title: 'Audio capabilities',
      summary: 'Audio capabilities: 2 x 10W speakers.',
      aliases: ['audio'],
      status: 'active',
      confidence: 90,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '2 x 10W speakers',
        sourceId: source.id,
        subject: device!.title,
        subjectIds: [device!.id],
        linkedObjectIds: [device!.id],
        targetHints: [{ id: device!.id, kind: device!.kind, title: device!.title }],
        extractor: 'repair-promotion',
        sourceAuthority: 'official-vendor',
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
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: device!.id,
      relation: 'describes',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(page.markdown).toContain('The Home Graph links this device to 0 Home Assistant entity record(s) and 1 source(s).');
    expect(page.markdown).toContain('LG 86NANO90UNA official specifications');
    expect(page.markdown).toContain('Audio capabilities: 2 x 10W speakers');
    expect(page.markdown).not.toContain('0 source(s)');
    expect(page.markdown).not.toContain('manual/source');
  });

  test('ask page refresh persists response-only subject fact links before rendering pages', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const browse = await service.browse({ installationId: 'house-1' });
    const device = browse.nodes.find((node) => node.kind === 'ha_device' && node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA official specifications',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      sourceUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    const secondarySource = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'LG 86NANO90UNA secondary specifications',
      canonicalUri: 'https://example.test/lg-86nano90una-specifications',
      sourceUri: 'https://example.test/lg-86nano90una-specifications',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'secondary-source, model:86NANO90UNA', sourceRank: 4 },
      },
    });
    const marketplaceSource = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Amazon affiliate LG listing',
      canonicalUri: 'https://www.amazon.com/example-lg-86nano90una',
      sourceUri: 'https://www.amazon.com/example-lg-86nano90una',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'marketplace, price comparison', sourceRank: 2 },
      },
    });
    const pendingSource = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Pending LG candidate source',
      canonicalUri: 'https://pending.example.test/lg-86nano90una',
      sourceUri: 'https://pending.example.test/lg-86nano90una',
      tags: ['semantic-gap-repair'],
      status: 'pending',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'secondary-source, model:86NANO90UNA', sourceRank: 3 },
      },
    });
    const responseOnlyOfficialSourceId = 'source-lg-official-response-only';
    await store.upsertSource({
      id: responseOnlyOfficialSourceId,
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Pending stale official candidate',
      canonicalUri: 'https://pending.example.test/stale-lg-86nano90una',
      sourceUri: 'https://pending.example.test/stale-lg-86nano90una',
      tags: ['semantic-gap-repair'],
      status: 'pending',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    const sourceWithoutUris = (({ sourceUri, canonicalUri, ...rest }) => {
      void sourceUri;
      void canonicalUri;
      return rest;
    })(source);
    const responseOnlyOfficialSource = {
      ...sourceWithoutUris,
      id: responseOnlyOfficialSourceId,
      title: 'LG 86NANO90UNA official specifications',
      url: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
    };
    const responseOnlyMarketplaceSourceId = 'source-amazon-response-only';
    const responseOnlyMarketplaceSource = {
      ...source,
      id: responseOnlyMarketplaceSourceId,
      title: 'Amazon affiliate LG listing',
      sourceUri: 'https://www.amazon.com/example-lg-86nano90una',
      canonicalUri: 'https://www.amazon.com/example-lg-86nano90una',
    };
    const storedFact = await store.upsertNode({
      kind: 'fact',
      slug: 'lg-display-audio-specs',
      title: 'Display and audio specifications',
      summary: 'Display and audio specifications: 4K UHD NanoCell display, HDR10, Dolby Vision, 120 Hz refresh rate, and 2 x 10W speakers.',
      aliases: [],
      status: 'active',
      confidence: 92,
      sourceId: secondarySource.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        value: '4K UHD NanoCell display, HDR10, Dolby Vision, 120 Hz, 2 x 10W speakers',
        sourceId: secondarySource.id,
        extractor: 'repair-promotion',
      },
    });
    const stalePage = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });
    expect(stalePage.markdown).toContain('0 source(s)');
    expect(stalePage.markdown).not.toContain('2 x 10W speakers');

    const answer: HomeGraphAskResult = {
      ok: true,
      spaceId,
      query: 'What features does the LG TV have?',
      answer: {
        text: 'The LG TV supports 4K UHD NanoCell video, HDR10, Dolby Vision, 120 Hz refresh, and 2 x 10W speakers.',
        mode: 'standard',
        confidence: 92,
        sources: [marketplaceSource, pendingSource, { ...secondarySource, status: 'pending' as const }, responseOnlyOfficialSource, responseOnlyMarketplaceSource],
        linkedObjects: [device!],
        facts: [{
          ...storedFact,
          subject: device!.title,
          subjectIds: [device!.id],
          linkedObjectIds: [device!.id],
          targetHints: [{ id: device!.id, kind: device!.kind, title: device!.title }],
        }],
        gaps: [],
        synthesized: true,
      },
      results: [],
    };

    const refresh = await refreshDevicePagesForHomeGraphAsk({
      store,
      artifactStore,
      spaceId,
      installationId: 'house-1',
      answer,
    });
    const pages = await service.listPages({ installationId: 'house-1', limit: 20, includeMarkdown: true });
    const listedPage = pages.pages.find((entry) => entry.source.title === 'LG webOS Smart TV passport');

    expect(refresh).toEqual({ requested: true, refreshed: 1 });
    expect(listedPage?.markdown).toContain('The Home Graph links this device to 0 Home Assistant entity record(s) and 2 source(s).');
    expect(listedPage?.markdown).toContain('LG 86NANO90UNA official specifications');
    expect(listedPage?.markdown).toContain('LG 86NANO90UNA secondary specifications');
    expect(store.getSource(secondarySource.id)?.status).toBe('indexed');
    expect(store.getSource(responseOnlyMarketplaceSourceId)).toBeNull();
    expect(listedPage?.markdown).not.toContain('Amazon affiliate');
    expect(listedPage?.markdown).not.toContain('Pending LG candidate source');
    expect(listedPage?.markdown).not.toContain('Pending stale official candidate');
    expect(listedPage?.markdown).toContain('2 x 10W speakers');
    expect(listedPage?.markdown).not.toContain('0 source(s)');
    expect(listedPage?.markdown).not.toContain('manual/source');
  });

  test('generated device pages ignore sources attached only through stale promoted facts', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const browse = await service.browse({ installationId: 'house-1' });
    const device = browse.nodes.find((node) => node.kind === 'ha_device' && node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Stale LG specification source',
      canonicalUri: 'https://www.lg.com/us/tvs/lg-86nano90una-4k-uhd-tv',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: spaceId,
        sourceDiscovery: { trustReason: 'official-vendor-domain, model:86NANO90UNA', sourceRank: 1 },
      },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'stale-lg-speaker-spec',
      title: 'Audio capabilities',
      summary: 'Audio capabilities: 2 x 10W speakers.',
      aliases: [],
      status: 'stale',
      confidence: 90,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: source.id,
        linkedObjectIds: [device!.id],
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
    await store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: device!.id,
      relation: 'describes',
      metadata: { knowledgeSpaceId: spaceId },
    });

    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(page.markdown).toContain('0 source(s)');
    expect(page.markdown).not.toContain('Stale LG specification source');
    expect(page.markdown).not.toContain('Audio capabilities: 2 x 10W speakers');
  });

  test('ask page refresh does not persist unlinked answer facts onto the only device', async () => {
    const { service, store, artifactStore } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      devices: [{ id: 'lg-tv', name: 'LG webOS Smart TV', manufacturer: 'LG', model: '86NANO90UNA' }],
    });
    const spaceId = homeAssistantKnowledgeSpaceId('house-1');
    const browse = await service.browse({ installationId: 'house-1' });
    const device = browse.nodes.find((node) => node.kind === 'ha_device' && node.title === 'LG webOS Smart TV');
    expect(device).toBeDefined();
    const source = await store.upsertSource({
      connectorId: 'semantic-gap-repair',
      sourceType: 'url',
      title: 'Unlinked TV comparison notes',
      canonicalUri: 'https://example.test/tv-comparison',
      sourceUri: 'https://example.test/tv-comparison',
      tags: ['semantic-gap-repair'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'unlinked-page-refresh-fact',
      title: 'Display and picture specifications',
      summary: 'Display and picture specifications: 4K UHD resolution, HDR10, Dolby Vision, and 120 Hz refresh rate.',
      aliases: [],
      status: 'active',
      confidence: 90,
      sourceId: source.id,
      metadata: {
        knowledgeSpaceId: spaceId,
        semanticKind: 'fact',
        factKind: 'specification',
        sourceId: source.id,
        extractor: 'repair-promotion',
      },
    });
    const answer: HomeGraphAskResult = {
      ok: true,
      spaceId,
      query: 'What features does the LG TV have?',
      answer: {
        text: 'The LG TV supports 4K UHD, HDR10, Dolby Vision, and 120 Hz refresh.',
        mode: 'standard',
        confidence: 92,
        sources: [source],
        linkedObjects: [device!],
        facts: [fact],
        gaps: [],
        synthesized: true,
      },
      results: [],
    };

    await refreshDevicePagesForHomeGraphAsk({
      store,
      artifactStore,
      spaceId,
      installationId: 'house-1',
      answer,
    });
    const page = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(page.markdown).not.toContain('Display and picture specifications: 4K UHD resolution');
    expect(store.getNode(fact.id)?.metadata.linkedObjectIds).toBeUndefined();
    expect(store.getNode(fact.id)?.metadata.subjectIds).toBeUndefined();
  });
});

function createHomeGraphService(): {
  readonly root: string;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-repair-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifactStore);
  return { root, store, artifactStore, service };
}

function createCompressedPdfBuffer(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const compressed = deflateSync(Buffer.from(content, 'utf-8'));
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const add = (chunk: string | Buffer): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
    chunks.push(buffer);
    size += buffer.length;
  };
  const object = (id: number, body: string | Buffer): void => {
    offsets[id] = size;
    add(`${id} 0 obj\n`);
    add(body);
    add('\nendobj\n');
  };

  add('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  object(5, Buffer.concat([
    Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'binary'),
    compressed,
    Buffer.from('\nendstream', 'binary'),
  ]));
  const xrefOffset = size;
  add('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) {
    add(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
