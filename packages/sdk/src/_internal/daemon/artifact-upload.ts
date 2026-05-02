// Synced from packages/daemon-sdk/src/artifact-upload.ts
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ArtifactUploadFieldMap = Record<string, unknown>;

export interface ArtifactStoreUploadLike {
  create(input: Record<string, unknown>): Promise<unknown>;
  getMaxBytes?(): number;
  createFromStream?(input: {
    readonly stream:
      | ReadableStream<Uint8Array>
      | AsyncIterable<Uint8Array | Buffer | string>
      | Iterable<Uint8Array | Buffer | string>;
    readonly kind?: string;
    readonly mimeType?: string;
    readonly filename?: string;
    readonly sourceUri?: string;
    readonly sizeBytes?: number;
    readonly retentionMs?: number;
    readonly acquisitionMode?: string;
    readonly fetchMode?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface ArtifactUploadResult {
  readonly artifact: unknown;
  readonly artifactId: string;
  readonly fields: ArtifactUploadFieldMap;
}

interface UploadFileLike {
  readonly name?: string;
  readonly type?: string;
  readonly size?: number;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const JSON_FIELD_NAMES = new Set(['metadata', 'target', 'options']);
const MAX_MULTIPART_FIELD_BYTES = 1024 * 1024;
const MAX_MULTIPART_BODY_OVERHEAD_BYTES = MAX_MULTIPART_FIELD_BYTES;

export function isJsonContentType(contentType: string | null): boolean {
  const lower = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return lower === '' || lower === 'application/json' || lower.endsWith('+json');
}

export function isArtifactUploadRequest(req: Request): boolean {
  return !isJsonContentType(req.headers.get('content-type'));
}

export async function createArtifactFromUploadRequest(
  artifactStore: ArtifactStoreUploadLike,
  req: Request,
): Promise<ArtifactUploadResult | Response> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    return createArtifactFromMultipart(artifactStore, req);
  }
  return createArtifactFromRawBody(artifactStore, req);
}

function parseUploadField(name: string, value: string): unknown {
  const trimmed = value.trim();
  if (JSON_FIELD_NAMES.has(name)) {
    return parseJsonField(trimmed, name);
  }
  if (name === 'tags') {
    if (trimmed.startsWith('[')) {
      const parsed = parseJsonField(trimmed, name);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    }
    return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  if (name === 'allowPrivateHosts') return trimmed === 'true' || trimmed === '1' || trimmed === 'yes';
  if (name === 'retentionMs') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value;
}

function parseJsonField(value: string, fieldName: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    void error;
    throw new Error(`Invalid JSON in multipart field ${fieldName}.`);
  }
}

function readStringField(fields: ArtifactUploadFieldMap, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumberField(fields: ArtifactUploadFieldMap, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readMetadata(fields: ArtifactUploadFieldMap): Record<string, unknown> {
  const metadata = fields.metadata;
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function readArtifactId(artifact: unknown): string | Response {
  if (typeof artifact === 'object' && artifact !== null) {
    const id = (artifact as { readonly id?: unknown }).id;
    if (typeof id === 'string' && id.trim().length > 0) return id;
  }
  return Response.json({ error: 'Artifact store returned an artifact without an id.' }, { status: 500 });
}

function isFileLike(value: unknown): value is UploadFileLike {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { readonly stream?: unknown }).stream === 'function'
    && typeof (value as { readonly arrayBuffer?: unknown }).arrayBuffer === 'function';
}

async function createArtifactFromMultipart(
  artifactStore: ArtifactStoreUploadLike,
  req: Request,
): Promise<ArtifactUploadResult | Response> {
  if (req.body) return createArtifactFromStreamingMultipart(artifactStore, req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch (error) {
    void error;
    return Response.json({ error: 'Invalid multipart upload.' }, { status: 400 });
  }

  const fields: ArtifactUploadFieldMap = {};
  let file: UploadFileLike | null = null;
  for (const [name, value] of form.entries() as Iterable<[string, unknown]>) {
    if (typeof value === 'string') {
      try {
        const parsed = parseUploadField(name, value);
        if (parsed !== undefined) fields[name] = parsed;
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
      continue;
    }
    if (!file && isFileLike(value)) {
      file = value;
    }
  }

  if (!file) return Response.json({ error: 'Multipart upload requires a file field.' }, { status: 400 });
  const maxBytes = artifactStore.getMaxBytes?.();
  if (typeof maxBytes === 'number' && typeof file.size === 'number' && file.size > maxBytes) {
    return Response.json({ error: `Artifact exceeds the ${maxBytes}-byte limit.` }, { status: 413 });
  }
  const artifact = await createArtifactFromStream(artifactStore, {
    stream: file.stream(),
    fields,
    filename: readStringField(fields, 'filename') ?? file.name,
    mimeType: readStringField(fields, 'mimeType') ?? file.type,
    sizeBytes: typeof file.size === 'number' ? file.size : undefined,
    maxBytes,
  });
  const artifactId = readArtifactId(artifact);
  return artifactId instanceof Response ? artifactId : { artifact, artifactId, fields };
}

async function createArtifactFromStreamingMultipart(
  artifactStore: ArtifactStoreUploadLike,
  req: Request,
): Promise<ArtifactUploadResult | Response> {
  let spooled: MultipartUploadSpool | null = null;
  try {
    spooled = await spoolMultipartUpload(req, artifactStore.getMaxBytes?.());
    const artifact = await createArtifactFromStream(artifactStore, {
      stream: readFileChunks(spooled.filePath),
      fields: spooled.fields,
      filename: readStringField(spooled.fields, 'filename') ?? spooled.filename,
      mimeType: readStringField(spooled.fields, 'mimeType') ?? spooled.mimeType,
      sizeBytes: spooled.sizeBytes,
      maxBytes: artifactStore.getMaxBytes?.(),
    });
    const artifactId = readArtifactId(artifact);
    return artifactId instanceof Response ? artifactId : { artifact, artifactId, fields: spooled.fields };
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await spooled?.cleanup();
  }
}

async function createArtifactFromRawBody(
  artifactStore: ArtifactStoreUploadLike,
  req: Request,
): Promise<ArtifactUploadResult | Response> {
  if (!req.body) return Response.json({ error: 'Raw artifact upload requires a request body.' }, { status: 400 });
  const url = new URL(req.url);
  const fields = readFieldsFromSearchParams(url.searchParams);
  const contentType = req.headers.get('content-type')?.split(';')[0]?.trim();
  const maxBytes = artifactStore.getMaxBytes?.();
  const sizeBytes = readContentLength(req);
  if (typeof maxBytes === 'number' && typeof sizeBytes === 'number' && sizeBytes > maxBytes) {
    return Response.json({ error: `Artifact exceeds the ${maxBytes}-byte limit.` }, { status: 413 });
  }
  const artifact = await createArtifactFromStream(artifactStore, {
    stream: req.body,
    fields,
    filename: readStringField(fields, 'filename')
      ?? req.headers.get('x-goodvibes-filename')?.trim()
      ?? filenameFromContentDisposition(req.headers.get('content-disposition')),
    mimeType: readStringField(fields, 'mimeType') ?? contentType ?? undefined,
    sizeBytes,
    maxBytes,
  });
  const artifactId = readArtifactId(artifact);
  return artifactId instanceof Response ? artifactId : { artifact, artifactId, fields };
}

async function* readFileChunks(path: string): AsyncIterable<Uint8Array> {
  const handle = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

function readFieldsFromSearchParams(params: URLSearchParams): ArtifactUploadFieldMap {
  const fields: ArtifactUploadFieldMap = {};
  for (const [name, value] of params.entries()) {
    try {
      const parsed = parseUploadField(name, value);
      if (parsed !== undefined) fields[name] = parsed;
    } catch (error) {
      void error;
      fields[name] = value;
    }
  }
  return fields;
}

function readContentLength(req: Request): number | undefined {
  const parsed = Number(req.headers.get('content-length') ?? NaN);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1].replace(/^"|"$/g, ''));
  } catch (error) {
    void error;
    return match[1].replace(/^"|"$/g, '');
  }
}

interface MultipartUploadSpool {
  readonly filePath: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly fields: ArtifactUploadFieldMap;
  cleanup(): Promise<void>;
}

interface MultipartPartHeaders {
  readonly name?: string;
  readonly filename?: string;
  readonly contentType?: string;
}

type BoundaryState = 'next' | 'done';

function multipartBoundary(contentType: string): string | null {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  return boundary && boundary.trim().length > 0 ? boundary.trim() : null;
}

function decodeHeaderValue(value: string): string {
  const unquoted = value.trim().replace(/^"|"$/g, '');
  try {
    return decodeURIComponent(unquoted.replace(/^UTF-8''/i, ''));
  } catch (error) {
    void error;
    return unquoted;
  }
}

function parseMultipartPartHeaders(headerText: string): MultipartPartHeaders {
  const headers = new Map<string, string>();
  for (const line of headerText.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const disposition = headers.get('content-disposition') ?? '';
  const output: { name?: string; filename?: string; contentType?: string } = {};
  for (const segment of disposition.split(';').slice(1)) {
    const [rawKey, ...rawValue] = segment.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue.join('=');
    if (!key || !value) continue;
    if (key === 'name') output.name = decodeHeaderValue(value);
    if (key === 'filename' || key === 'filename*') output.filename = decodeHeaderValue(value);
  }
  const contentType = headers.get('content-type');
  if (contentType) output.contentType = contentType.split(';')[0]?.trim();
  return output;
}

async function spoolMultipartUpload(req: Request, maxFileBytes?: number): Promise<MultipartUploadSpool> {
  const boundary = multipartBoundary(req.headers.get('content-type') ?? '');
  if (!boundary) throw new Error('Multipart upload is missing a boundary.');
  if (!req.body) throw new Error('Multipart upload requires a request body.');
  const contentLength = readContentLength(req);
  if (
    typeof maxFileBytes === 'number'
    && typeof contentLength === 'number'
    && contentLength > maxFileBytes + MAX_MULTIPART_BODY_OVERHEAD_BYTES
  ) {
    throw new Error(`Artifact exceeds the ${maxFileBytes}-byte limit.`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'goodvibes-upload-'));
  const filePath = join(tempDir, `${randomUUID()}.upload`);
  const fields: ArtifactUploadFieldMap = {};
  const firstBoundary = Buffer.from(`--${boundary}`);
  const bodyBoundary = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const reader = req.body.getReader();
  let buffer = Buffer.alloc(0);
  let fileSeen = false;
  let filename: string | undefined;
  let mimeType: string | undefined;
  let sizeBytes = 0;

  const readMore = async (): Promise<boolean> => {
    const { done, value } = await reader.read();
    if (done) return false;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    return true;
  };

  const consumeBoundarySuffix = async (): Promise<BoundaryState> => {
    while (buffer.length < 2) {
      if (!await readMore()) throw new Error('Unexpected end of multipart body.');
    }
    if (buffer.subarray(0, 2).toString() === '--') {
      buffer = buffer.subarray(2);
      return 'done';
    }
    if (buffer.subarray(0, 2).toString() === '\r\n') {
      buffer = buffer.subarray(2);
      return 'next';
    }
    throw new Error('Invalid multipart boundary terminator.');
  };

  const consumeInitialBoundary = async (): Promise<BoundaryState> => {
    for (;;) {
      const index = buffer.indexOf(firstBoundary);
      if (index >= 0) {
        buffer = buffer.subarray(index + firstBoundary.length);
        return consumeBoundarySuffix();
      }
      if (!await readMore()) throw new Error('Invalid multipart upload.');
      const readIndex = buffer.indexOf(firstBoundary);
      if (readIndex >= 0) {
        buffer = buffer.subarray(readIndex + firstBoundary.length);
        return consumeBoundarySuffix();
      }
      if (buffer.length > firstBoundary.length * 2) {
        buffer = buffer.subarray(buffer.length - firstBoundary.length * 2);
      }
    }
  };

  const readHeaders = async (): Promise<MultipartPartHeaders> => {
    for (;;) {
      const index = buffer.indexOf(headerSeparator);
      if (index >= 0) {
        const headerText = buffer.subarray(0, index).toString('utf8');
        buffer = buffer.subarray(index + headerSeparator.length);
        return parseMultipartPartHeaders(headerText);
      }
      if (!await readMore()) throw new Error('Unexpected end of multipart headers.');
      if (buffer.length > MAX_MULTIPART_FIELD_BYTES) throw new Error('Multipart part headers are too large.');
    }
  };

  const readPart = async (onChunk: (chunk: Buffer) => Promise<void>): Promise<BoundaryState> => {
    const keepBytes = bodyBoundary.length - 1;
    for (;;) {
      const index = buffer.indexOf(bodyBoundary);
      if (index >= 0) {
        if (index > 0) await onChunk(buffer.subarray(0, index));
        buffer = buffer.subarray(index + bodyBoundary.length);
        return consumeBoundarySuffix();
      }
      if (buffer.length > keepBytes) {
        await onChunk(buffer.subarray(0, buffer.length - keepBytes));
        buffer = buffer.subarray(buffer.length - keepBytes);
      }
      if (!await readMore()) throw new Error('Unexpected end of multipart part.');
    }
  };

  const readFieldPart = async (name: string): Promise<BoundaryState> => {
    const chunks: Buffer[] = [];
    let fieldBytes = 0;
    const state = await readPart(async (chunk) => {
      fieldBytes += chunk.byteLength;
      if (fieldBytes > MAX_MULTIPART_FIELD_BYTES) throw new Error(`Multipart field ${name} is too large.`);
      chunks.push(chunk);
    });
    const parsed = parseUploadField(name, Buffer.concat(chunks).toString('utf8'));
    if (parsed !== undefined) fields[name] = parsed;
    return state;
  };

  const readFilePart = async (headers: MultipartPartHeaders): Promise<BoundaryState> => {
    const handle = await open(filePath, 'wx');
    try {
      const state = await readPart(async (chunk) => {
        sizeBytes += chunk.byteLength;
        if (typeof maxFileBytes === 'number' && sizeBytes > maxFileBytes) {
          throw new Error(`Artifact exceeds the ${maxFileBytes}-byte limit.`);
        }
        await handle.write(chunk);
      });
      fileSeen = true;
      filename = headers.filename;
      mimeType = headers.contentType;
      return state;
    } finally {
      await handle.close();
    }
  };

  try {
    for (let state = await consumeInitialBoundary(); state !== 'done';) {
      const headers = await readHeaders();
      if (headers.filename !== undefined && !fileSeen) {
        state = await readFilePart(headers);
      } else if (headers.filename !== undefined) {
        state = await readPart(async () => {});
      } else if (headers.name) {
        state = await readFieldPart(headers.name);
      } else {
        state = await readPart(async () => {});
      }
    }
    if (!fileSeen) throw new Error('Multipart upload requires a file field.');
    return {
      filePath,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      sizeBytes,
      fields,
      cleanup: async () => {
        await cleanupTempDir(tempDir);
      },
    };
  } catch (error) {
    await cleanupTempDir(tempDir, error);
    throw error;
  } finally {
    releaseReaderLock(reader);
  }
}

async function cleanupTempDir(tempDir: string, originalError?: unknown): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (originalError !== undefined) {
      throw new AggregateError(
        [originalError, cleanupError],
        'Multipart upload failed and temporary upload cleanup also failed.',
      );
    }
    throw cleanupError;
  }
}

function releaseReaderLock(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch (error) {
    if (error instanceof TypeError) return;
    throw error;
  }
}

async function createArtifactFromStream(
  artifactStore: ArtifactStoreUploadLike,
  input: {
    readonly stream: Parameters<NonNullable<ArtifactStoreUploadLike['createFromStream']>>[0]['stream'];
    readonly fields: ArtifactUploadFieldMap;
    readonly filename?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
    readonly maxBytes?: number;
  },
): Promise<unknown> {
  if (typeof input.maxBytes === 'number' && typeof input.sizeBytes === 'number' && input.sizeBytes > input.maxBytes) {
    throw new Error(`Artifact exceeds the ${input.maxBytes}-byte limit.`);
  }
  const base = {
    ...(readStringField(input.fields, 'kind') ? { kind: readStringField(input.fields, 'kind') } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(readStringField(input.fields, 'sourceUri') ? { sourceUri: readStringField(input.fields, 'sourceUri') } : {}),
    ...(typeof input.sizeBytes === 'number' ? { sizeBytes: input.sizeBytes } : {}),
    ...(typeof readNumberField(input.fields, 'retentionMs') === 'number' ? { retentionMs: readNumberField(input.fields, 'retentionMs') } : {}),
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: readMetadata(input.fields),
  };
  if (artifactStore.createFromStream) {
    return artifactStore.createFromStream({
      stream: input.stream,
      ...base,
    });
  }
  const buffer = await bufferUploadStream(input.stream, input.maxBytes);
  return artifactStore.create({
    ...base,
    dataBase64: buffer.toString('base64'),
  });
}

function isWebReadableStream(
  stream: Parameters<NonNullable<ArtifactStoreUploadLike['createFromStream']>>[0]['stream'],
): stream is ReadableStream<Uint8Array> {
  return typeof (stream as ReadableStream<Uint8Array>).getReader === 'function';
}

function isAsyncUploadIterable(
  stream: Parameters<NonNullable<ArtifactStoreUploadLike['createFromStream']>>[0]['stream'],
): stream is AsyncIterable<Uint8Array | Buffer | string> {
  return typeof (stream as AsyncIterable<Uint8Array | Buffer | string>)[Symbol.asyncIterator] === 'function';
}

async function* iterateUploadStream(
  stream: Parameters<NonNullable<ArtifactStoreUploadLike['createFromStream']>>[0]['stream'],
): AsyncIterable<Uint8Array | Buffer | string> {
  if (isWebReadableStream(stream)) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      releaseReaderLock(reader);
    }
    return;
  }
  if (isAsyncUploadIterable(stream)) {
    yield* stream;
    return;
  }
  for (const chunk of stream) yield chunk;
}

async function bufferUploadStream(
  stream: Parameters<NonNullable<ArtifactStoreUploadLike['createFromStream']>>[0]['stream'],
  maxBytes?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of iterateUploadStream(stream)) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (typeof maxBytes === 'number' && totalBytes > maxBytes) {
      throw new Error(`Artifact exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
