import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { afterEach } from 'bun:test';
import { ArtifactStore } from '../../packages/sdk/src/platform/artifacts/index.js';
import { HomeGraphService } from '../../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../../packages/sdk/src/platform/knowledge/store.js';
import { waitFor as _canonicalWaitFor } from './test-timeout.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

export function createHomeGraphService(): {
  readonly root: string;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly service: HomeGraphService;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifactStore);
  return { root, store, artifactStore, service };
}

export function readHomeAssistantEntityId(metadata: Record<string, unknown>): string | undefined {
  const homeAssistant = metadata.homeAssistant;
  return homeAssistant && typeof homeAssistant === 'object' && !Array.isArray(homeAssistant)
    ? (homeAssistant as { readonly entityId?: string }).entityId
    : undefined;
}

/**
 * Delegates to the canonical waitFor from test/_helpers/test-timeout.ts.
 * The canonical version uses timer.unref() to avoid hanging the process.
 */
export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return _canonicalWaitFor(predicate, { timeoutMs, intervalMs: 10 });
}

export function createCompressedPdfBuffer(text: string): Buffer {
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

