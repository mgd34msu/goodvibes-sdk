import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/store.ts';
import { createDaemonMediaRouteHandlers } from '../packages/daemon-sdk/src/media-routes.ts';
import { createDaemonKnowledgeRouteHandlers } from '../packages/daemon-sdk/src/knowledge-routes.ts';
import type { DaemonKnowledgeRouteContext } from '../packages/daemon-sdk/src/knowledge-route-types.ts';
import { HomeGraphRoutes } from '../packages/sdk/src/platform/daemon/http/home-graph-routes.ts';

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = join(tmpdir(), `goodvibes-artifact-upload-${name}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function* repeatedChunks(count: number, size: number): AsyncIterable<Uint8Array> {
  for (let index = 0; index < count; index += 1) {
    yield new Uint8Array(size).fill(index % 255);
  }
}

function failingJsonParser(): Promise<Record<string, unknown> | Response> {
  throw new Error('JSON parser should not be used for upload bodies');
}

function createStore(name: string): ArtifactStore {
  return new ArtifactStore({ rootDir: tempDir(name) });
}

function webStreamWithFailingReleaseLock(data: Uint8Array): ReadableStream<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const getReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      const reader = getReader();
      const releaseLock = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        releaseLock();
        throw new Error('Bun request stream releaseLock failure');
      };
      return reader;
    },
  });
  return stream;
}

describe('artifact uploads and ingest', () => {
  test('ArtifactStore accepts streamed artifacts larger than the previous 10 MiB cap', async () => {
    const store = createStore('large-stream');
    const artifact = await store.createFromStream({
      stream: repeatedChunks(11, 1024 * 1024),
      filename: 'large-manual.pdf',
      mimeType: 'application/pdf',
    });

    expect(artifact.sizeBytes).toBe(11 * 1024 * 1024);
    expect(artifact.filename).toBe('large-manual.pdf');
    expect(artifact.mimeType).toBe('application/pdf');
  });

  test('ArtifactStore ignores web stream reader release failures after upload consumption', async () => {
    const store = createStore('release-lock');
    const data = new TextEncoder().encode('raw upload from Bun request stream');
    const artifact = await store.createFromStream({
      stream: webStreamWithFailingReleaseLock(data),
      filename: 'bun-upload.txt',
      mimeType: 'text/plain',
    });

    expect(artifact.sizeBytes).toBe(data.byteLength);
    expect(artifact.filename).toBe('bun-upload.txt');
    expect(artifact.mimeType).toBe('text/plain');
  });

  test('ArtifactStore removes spooled content when metadata persistence fails', async () => {
    const root = tempDir('metadata-failure');
    const store = new ArtifactStore({ rootDir: root });

    await expect(store.createFromStream({
      stream: ['artifact body'],
      filename: 'bad-metadata.txt',
      mimeType: 'text/plain',
      metadata: { invalidJson: 1n } as never,
    })).rejects.toThrow();

    expect(store.list()).toHaveLength(0);
    expect(readdirSync(root).filter((entry) => entry.endsWith('.data'))).toHaveLength(0);
    expect(readdirSync(root).filter((entry) => entry.endsWith('.json'))).toHaveLength(0);
  });

  test('POST /api/artifacts accepts multipart file uploads without JSON parsing', async () => {
    const store = createStore('multipart-artifact');
    const handlers = createDaemonMediaRouteHandlers({
      artifactStore: store,
      configManager: { get: () => false },
      mediaProviders: {} as never,
      multimodalService: {} as never,
      parseJsonBody: failingJsonParser,
      requireAdmin: () => null,
      voiceService: {} as never,
      webSearchService: {} as never,
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(1_250_000)], { type: 'application/pdf' }), 'manual.pdf');
    form.append('metadata', JSON.stringify({ source: 'homeassistant-panel' }));

    const response = await handlers.postArtifact(new Request('http://localhost/api/artifacts', {
      method: 'POST',
      body: form,
    }));
    const body = await response.json() as { artifact: { id: string; filename: string; sizeBytes: number; metadata: Record<string, unknown> } };

    expect(response.status).toBe(201);
    expect(body.artifact.filename).toBe('manual.pdf');
    expect(body.artifact.sizeBytes).toBe(1_250_000);
    expect(body.artifact.metadata.source).toBe('homeassistant-panel');
  });

  test('POST /api/artifacts accepts raw binary uploads with metadata in the URL', async () => {
    const store = createStore('raw-artifact');
    const handlers = createDaemonMediaRouteHandlers({
      artifactStore: store,
      configManager: { get: () => false },
      mediaProviders: {} as never,
      multimodalService: {} as never,
      parseJsonBody: failingJsonParser,
      requireAdmin: () => null,
      voiceService: {} as never,
      webSearchService: {} as never,
    });

    const response = await handlers.postArtifact(new Request('http://localhost/api/artifacts?filename=diagram.pdf&metadata=%7B%22source%22%3A%22raw%22%7D', {
      method: 'POST',
      body: new Uint8Array(1_125_000),
      headers: { 'Content-Type': 'application/pdf' },
    }));
    const body = await response.json() as { artifact: { filename: string; mimeType: string; sizeBytes: number; metadata: Record<string, unknown> } };

    expect(response.status).toBe(201);
    expect(body.artifact.filename).toBe('diagram.pdf');
    expect(body.artifact.mimeType).toBe('application/pdf');
    expect(body.artifact.sizeBytes).toBe(1_125_000);
    expect(body.artifact.metadata.source).toBe('raw');
  });

  test('POST /api/artifacts rejects multipart uploads that exceed the artifact cap while spooling', async () => {
    const store = new ArtifactStore({ rootDir: tempDir('multipart-limit'), maxBytes: 1024 });
    const handlers = createDaemonMediaRouteHandlers({
      artifactStore: store,
      configManager: { get: () => false },
      mediaProviders: {} as never,
      multimodalService: {} as never,
      parseJsonBody: failingJsonParser,
      requireAdmin: () => null,
      voiceService: {} as never,
      webSearchService: {} as never,
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2048)], { type: 'application/pdf' }), 'too-large.pdf');

    const response = await handlers.postArtifact(new Request('http://localhost/api/artifacts', {
      method: 'POST',
      body: form,
    }));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(413);
    expect(body.error).toContain('1024-byte limit');
    expect(store.list()).toHaveLength(0);
  });

  test('knowledge artifact ingest accepts multipart upload and forwards the stored artifact id', async () => {
    const store = createStore('multipart-knowledge');
    let captured: Record<string, unknown> | null = null;
    const context = {
      artifactStore: store,
      configManager: { get: () => false },
      inspectGraphqlAccess: () => ({ requiredScopes: [] }),
      normalizeAtSchedule: (value: number) => ({ kind: 'at', at: value }),
      normalizeCronSchedule: (expression: string) => ({ kind: 'cron', expression }),
      normalizeEverySchedule: (interval: number | string) => ({ kind: 'every', interval }),
      parseJsonBody: failingJsonParser,
      parseOptionalJsonBody: async () => null,
      parseJsonText: () => ({}),
      requireAdmin: () => null,
      resolveAuthenticatedPrincipal: () => ({ principalId: 'test', principalKind: 'user', admin: true, scopes: [] }),
      knowledgeGraphqlService: { schemaText: '', execute: async () => ({ data: {} }) },
      knowledgeService: {
        ingestArtifact: async (input: Record<string, unknown>) => {
          captured = input;
          return { source: { id: 'source-1' }, artifactId: input.artifactId };
        },
      },
    } as unknown as DaemonKnowledgeRouteContext;
    const handlers = createDaemonKnowledgeRouteHandlers(context);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(1_500_000)], { type: 'application/pdf' }), 'warranty.pdf');
    form.append('title', 'Washer warranty');
    form.append('tags', JSON.stringify(['homeassistant', 'warranty']));

    const response = await handlers.postKnowledgeIngestArtifact(new Request('http://localhost/api/knowledge/ingest/artifact', {
      method: 'POST',
      body: form,
    }));
    const body = await response.json() as { artifactId: string };

    expect(response.status).toBe(201);
    expect(body.artifactId).toStartWith('artifact-');
    expect(captured?.artifactId).toBe(body.artifactId);
    expect(captured?.title).toBe('Washer warranty');
    expect(captured?.tags).toEqual(['homeassistant', 'warranty']);
  });

  test('knowledge artifact ingest accepts raw binary upload metadata from the URL', async () => {
    const store = createStore('raw-knowledge');
    let captured: Record<string, unknown> | null = null;
    const context = {
      artifactStore: store,
      configManager: { get: () => false },
      inspectGraphqlAccess: () => ({ requiredScopes: [] }),
      normalizeAtSchedule: (value: number) => ({ kind: 'at', at: value }),
      normalizeCronSchedule: (expression: string) => ({ kind: 'cron', expression }),
      normalizeEverySchedule: (interval: number | string) => ({ kind: 'every', interval }),
      parseJsonBody: failingJsonParser,
      parseOptionalJsonBody: async () => null,
      parseJsonText: () => ({}),
      requireAdmin: () => null,
      resolveAuthenticatedPrincipal: () => ({ principalId: 'test', principalKind: 'user', admin: true, scopes: [] }),
      knowledgeGraphqlService: { schemaText: '', execute: async () => ({ data: {} }) },
      knowledgeService: {
        ingestArtifact: async (input: Record<string, unknown>) => {
          captured = input;
          return { source: { id: 'source-1' }, artifactId: input.artifactId };
        },
      },
    } as unknown as DaemonKnowledgeRouteContext;
    const handlers = createDaemonKnowledgeRouteHandlers(context);

    const response = await handlers.postKnowledgeIngestArtifact(new Request('http://localhost/api/knowledge/ingest/artifact?filename=manual.pdf&title=Manual&tags=manual,upload', {
      method: 'POST',
      body: new Uint8Array(1_100_000),
      headers: { 'Content-Type': 'application/pdf' },
    }));
    const body = await response.json() as { artifactId: string };

    expect(response.status).toBe(201);
    expect(body.artifactId).toStartWith('artifact-');
    expect(captured?.artifactId).toBe(body.artifactId);
    expect(captured?.title).toBe('Manual');
    expect(captured?.tags).toEqual(['manual', 'upload']);
  });

  test('Home Graph artifact ingest accepts multipart upload and forwards the stored artifact id', async () => {
    const store = createStore('multipart-homegraph');
    let captured: Record<string, unknown> | null = null;
    const routes = new HomeGraphRoutes({
      artifactStore: store,
      homeGraphService: {
        ingestArtifact: async (input: Record<string, unknown>) => {
          captured = input;
          return { ok: true, spaceId: 'homeassistant:test', source: { id: 'source-1' }, artifactId: input.artifactId };
        },
      } as never,
      parseJsonBody: failingJsonParser,
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(1_333_000)], { type: 'application/pdf' }), 'thermostat-manual.pdf');
    form.append('installationId', 'home-1');
    form.append('target', JSON.stringify({ kind: 'ha_device', id: 'device-1' }));

    const response = await routes.handle(new Request('http://localhost/api/homeassistant/home-graph/ingest/artifact', {
      method: 'POST',
      body: form,
    }));
    const body = await response?.json() as { artifactId: string };

    expect(response?.status).toBe(200);
    expect(body.artifactId).toStartWith('artifact-');
    expect(captured?.artifactId).toBe(body.artifactId);
    expect(captured?.installationId).toBe('home-1');
    expect(captured?.target).toEqual({ kind: 'ha_device', id: 'device-1' });
  });
});
