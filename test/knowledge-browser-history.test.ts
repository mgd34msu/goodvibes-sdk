import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import { createDefaultKnowledgeConnectorRegistry } from '../packages/sdk/src/_internal/platform/knowledge/connectors.js';
import { discoverBrowserKnowledgeProfiles } from '../packages/sdk/src/_internal/platform/knowledge/browser-history/discover.js';
import { ingestBrowserKnowledge } from '../packages/sdk/src/_internal/platform/knowledge/browser-history/ingest.js';
import { readBrowserKnowledgeProfile } from '../packages/sdk/src/_internal/platform/knowledge/browser-history/readers.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';
import { extractKnowledgeArtifact } from '../packages/sdk/src/_internal/platform/knowledge/extractors.js';
import type { KnowledgeIngestContext } from '../packages/sdk/src/_internal/platform/knowledge/ingest-context.js';

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;
const tempDirs: string[] = [];

function chromiumMicros(ms: number): number {
  return Math.floor((ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'goodvibes-browser-history-'));
  tempDirs.push(dir);
  return dir;
}

async function createChromiumProfile(home: string): Promise<void> {
  const profile = join(home, '.config', 'chromium', 'Default');
  await mkdir(profile, { recursive: true });
  const historyPath = join(profile, 'History');
  const db = new Database(historyPath);
  db.run('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, visit_count INTEGER NOT NULL)');
  db.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER NOT NULL)');
  db.run('INSERT INTO urls (id, url, title, visit_count) VALUES (?, ?, ?, ?)', [
    1,
    'https://example.com/articles/browser-knowledge?utm_source=test',
    'Browser Knowledge Article',
    3,
  ]);
  db.run('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)', [
    1,
    1,
    chromiumMicros(Date.now() - 60_000),
    1,
  ]);
  db.close();

  await writeFile(join(profile, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks Bar',
        children: [{
          id: '11',
          type: 'url',
          name: 'Saved Browser Knowledge',
          url: 'https://example.com/articles/browser-knowledge',
          date_added: String(chromiumMicros(Date.now() - 30_000)),
        }],
      },
    },
  }));
}

function makeIngestContext(store: KnowledgeStore, artifactStore: ArtifactStore): KnowledgeIngestContext {
  const connectorRegistry = createDefaultKnowledgeConnectorRegistry();
  return {
    store,
    artifactStore,
    connectorRegistry,
    emitIfReady: () => {},
    syncReviewedMemory: async () => {},
    lint: async () => [],
    listConnectors: () => connectorRegistry.list(),
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('browser history knowledge ingest', () => {
  test('discovers Chromium profiles and reads history plus bookmarks', async () => {
    const home = await makeTempDir();
    await createChromiumProfile(home);

    const profiles = await discoverBrowserKnowledgeProfiles({ homeOverride: home, browsers: ['chromium'] });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.browser).toBe('chromium');

    const entries = await readBrowserKnowledgeProfile(profiles[0]!, { limit: 10 });
    expect(entries.map((entry) => entry.sourceKind).sort()).toEqual(['bookmark', 'history']);
  });

  test('ingests browser-local knowledge once per canonical URL with provenance', async () => {
    const home = await makeTempDir();
    await createChromiumProfile(home);
    const store = new KnowledgeStore({ dbPath: join(home, 'knowledge.sqlite') });
    const artifactStore = new ArtifactStore({ rootDir: join(home, 'artifacts') });

    const result = await ingestBrowserKnowledge(makeIngestContext(store, artifactStore), {
      homeOverride: home,
      browsers: ['chromium'],
      limit: 10,
    });

    expect(result.failed).toBe(0);
    expect(result.imported).toBe(1);
    expect(result.profiles).toHaveLength(1);

    const source = result.sources[0]!;
    expect(source.sourceType).toBe('bookmark');
    expect(source.canonicalUri).toBe('https://example.com/articles/browser-knowledge');
    expect(source.tags).toContain('browser-history');
    expect(source.tags).toContain('browser-bookmark');
    expect(source.metadata.browserSourceKinds).toEqual(['history', 'bookmark']);
    expect(source.metadata.browserObservationCount).toBe(2);

    const extraction = store.getExtractionBySourceId(source.id);
    expect(extraction?.extractorId).toBe('browser-history');
    expect(extraction?.summary).toContain('bookmarks and history');
    expect(store.listEdges().some((edge) => edge.relation === 'bookmarked_in_browser_profile')).toBe(true);
    expect(store.listEdges().some((edge) => edge.relation === 'belongs_to_domain')).toBe(true);
  });
});

describe('readability HTML extraction', () => {
  test('prefers article text over navigation chrome', async () => {
    const result = await extractKnowledgeArtifact({
      id: 'artifact-html',
      mimeType: 'text/html',
      filename: 'article.html',
    }, Buffer.from(`
      <html>
        <head><title>Ignored Site Shell</title></head>
        <body>
          <nav>Home Pricing Login</nav>
          <article>
            <h1>Useful Browser Knowledge</h1>
            <p>This article explains how local browser history can become structured project knowledge.</p>
            <p>It keeps provenance, timestamps, and source URLs available for later search.</p>
          </article>
        </body>
      </html>
    `));

    expect(result.extractorId).toBe('html-readability');
    expect(result.title).toContain('Useful Browser Knowledge');
    expect(result.summary).toContain('local browser history');
    expect(result.excerpt).not.toContain('Pricing Login');
  });
});
