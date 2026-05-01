import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import {
  HomeGraphService,
  homeAssistantKnowledgeSpaceId,
} from '../packages/sdk/src/_internal/platform/knowledge/index.js';
import { extractKnowledgeArtifact } from '../packages/sdk/src/_internal/platform/knowledge/extractors.js';
import { HOME_GRAPH_PAGE_POLICY_VERSION } from '../packages/sdk/src/_internal/platform/knowledge/home-graph/generated-pages.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Home Graph repair and generated pages', () => {
  test('does not index compressed PDF stream bytes as searchable text', async () => {
    const compressed = deflateSync(Buffer.from([0, 1, 2, 3, 255, 254, 253, 128, 127, 16, 24, 31]));
    const buffer = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n', 'binary'),
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'binary'),
      compressed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'binary'),
    ]);

    const extracted = await extractKnowledgeArtifact({
      id: 'bad-pdf',
      mimeType: 'application/pdf',
      filename: 'bad.pdf',
    }, buffer);

    expect(extracted.extractorId).toBe('pdf');
    expect(extracted.summary).toContain('limited text');
    expect(extracted.structure.searchText).toBeUndefined();
    expect(JSON.stringify(extracted)).not.toContain('/FlateDecode');
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
    expect(passport.markdown).toContain('## Source-Backed Features And Notes');
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
    await service.linkKnowledge({
      installationId: 'house-1',
      sourceId: source.id,
      target: { kind: 'device', id: 'lg-tv', relation: 'has_manual' },
    });

    const passport = await service.refreshDevicePassport({ installationId: 'house-1', deviceId: 'lg-tv' });

    expect(passport.markdown).toContain('Dolby Vision HDR');
    expect(passport.markdown).toContain('DTV Audio Supported Codec');
    expect(passport.markdown).not.toContain('SpeakerCompare');
    expect(passport.markdown).not.toContain('equal power mode');
    expect(passport.markdown).not.toContain('Do not place the TV');
    expect(passport.markdown).not.toContain('certified HDMI cable');
    expect(passport.markdown).not.toContain('ULTRA HD broadcast standards');
    expect(passport.markdown).not.toContain('USB to Serial');
    expect(passport.markdown).not.toContain('Magic Remote');
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
