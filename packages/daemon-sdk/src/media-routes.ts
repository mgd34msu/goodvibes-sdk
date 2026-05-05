import type { DaemonMediaRouteHandlers } from './context.js';
import { resolvePrivateHostFetchOptions } from './http-policy.js';
import { jsonErrorResponse } from './error-response.js';
import { createArtifactFromUploadRequest, isArtifactUploadRequest } from './artifact-upload.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readOptionalStringField,
  readStringArrayField,
  type JsonRecord,
} from './route-helpers.js';
import type {
  ArtifactKind,
  DaemonMediaRouteContext,
  FetchExtractMode,
  MediaArtifact,
  MultimodalAnalysisResult,
  MultimodalDetail,
  VoiceAudioArtifact,
  VoiceSynthesisStreamLike,
  WebSearchSafeSearch,
  WebSearchTimeRange,
  WebSearchVerbosity,
} from './media-route-types.js';

function readErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'Unknown error';
}

function isProviderNotConfiguredError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { readonly code?: unknown }).code === 'PROVIDER_NOT_CONFIGURED');
}

export function createDaemonMediaRouteHandlers(
  context: DaemonMediaRouteContext,
): DaemonMediaRouteHandlers {
  return {
    getVoiceStatus: async () => Response.json(await context.voiceService.getStatus(Boolean(context.configManager.get('ui.voiceEnabled')))),
    getVoiceProviders: async () => {
      // reuse the same status snapshot instead of issuing a second provider-status probe.
      const status = await context.voiceService.getStatus(Boolean(context.configManager.get('ui.voiceEnabled')));
      return Response.json({ providers: status.providers });
    },
    getVoiceVoices: async (url) => Response.json({ voices: await context.voiceService.listVoices(url.searchParams.get('providerId') ?? undefined) }),
    postVoiceTts: async (request) => handleVoiceTts(context, request),
    postVoiceTtsStream: async (request) => handleVoiceTtsStream(context, request),
    postVoiceStt: async (request) => handleVoiceStt(context, request),
    postVoiceRealtimeSession: async (request) => handleVoiceRealtimeSession(context, request),
    getWebSearchProviders: async () => Response.json({ providers: await context.webSearchService.getStatus().then((status) => status.providers) }),
    postWebSearch: async (request) => handleWebSearch(context, request),
    getArtifacts: () => Response.json({ artifacts: context.artifactStore.list() }),
    postArtifact: async (request) => handleArtifactCreate(context, request),
    getArtifact: (artifactId) => {
      const artifact = context.artifactStore.get(artifactId);
      return artifact
        ? Response.json({ artifact })
        : jsonErrorResponse({ error: 'Unknown artifact' }, { status: 404 });
    },
    getArtifactContent: async (artifactId, request) => handleArtifactContent(context, artifactId, request),
    getMediaProviders: async () => Response.json({ providers: await context.mediaProviders.status() }),
    postMediaAnalyze: async (request) => handleMediaAnalyze(context, request),
    postMediaTransform: async (request) => handleMediaTransform(context, request),
    postMediaGenerate: async (request) => handleMediaGenerate(context, request),
    getMultimodalStatus: async () => Response.json(await context.multimodalService.getStatus()),
    getMultimodalProviders: async () => Response.json({ providers: await context.multimodalService.listProviders() }),
    postMultimodalAnalyze: async (request) => handleMultimodalAnalyze(context, request),
    postMultimodalPacket: async (request) => handleMultimodalPacket(context, request),
    postMultimodalWriteback: async (request) => handleMultimodalWriteback(context, request),
  };
}

function readOptionalConfigString(context: DaemonMediaRouteContext, key: string): string | undefined {
  const value = context.configManager.get(key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

const MAX_MEDIA_WRITEBACK_TAGS = 64;

function readOptionalBoundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function readVoiceSynthesisRequest(
  body: JsonRecord,
  context?: DaemonMediaRouteContext,
): {
  readonly providerId?: string | undefined;
  readonly input: {
    readonly text: string;
    readonly voiceId?: string | undefined;
    readonly modelId?: string | undefined;
    readonly format?: string | undefined;
    readonly speed?: number | undefined;
    readonly metadata: Record<string, unknown>;
  };
} {
  const providerId = typeof body.providerId === 'string'
    ? body.providerId
    : context
      ? readOptionalConfigString(context, 'tts.provider')
      : undefined;
  const voiceId = typeof body.voiceId === 'string'
    ? body.voiceId
    : context
      ? readOptionalConfigString(context, 'tts.voice')
      : undefined;
  const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
  const format = typeof body.format === 'string' ? body.format : undefined;
  const speed = readOptionalBoundedNumber(body.speed, 0.25, 4);
  const input: {
    text: string;
    voiceId?: string | undefined;
    modelId?: string | undefined;
    format?: string | undefined;
    speed?: number | undefined;
    metadata: Record<string, unknown>;
  } = {
    text: typeof body.text === 'string' ? body.text : '',
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  };
  if (voiceId !== undefined) input.voiceId = voiceId;
  if (modelId !== undefined) input.modelId = modelId;
  if (format !== undefined) input.format = format;
  if (speed !== undefined) input.speed = speed;
  return {
    ...(providerId !== undefined ? { providerId } : {}),
    input,
  };
}

type WebSearchBody = {
  readonly query: string;
  readonly providerId?: string | undefined;
  readonly maxResults?: number | undefined;
  readonly verbosity?: WebSearchVerbosity | undefined;
  readonly region?: string | undefined;
  readonly safeSearch?: WebSearchSafeSearch | undefined;
  readonly timeRange?: WebSearchTimeRange | undefined;
  readonly includeInstantAnswer?: boolean | undefined;
  readonly includeEvidence?: boolean | undefined;
  readonly evidenceTopN?: number | undefined;
  readonly evidenceExtract?: FetchExtractMode | undefined;
};

type MultimodalPacketBody = {
  readonly analysis: MultimodalAnalysisResult;
  readonly detail: MultimodalDetail;
  readonly budgetLimit?: number | undefined;
};

const mediaBodySchemas = createRouteBodySchemaRegistry({
  webSearch: createRouteBodySchema<WebSearchBody>('POST /api/web-search', (body) => {
    const query = readOptionalStringField(body, 'query');
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const providerId = readOptionalStringField(body, 'providerId');
    const verbosity = readOptionalStringField(body, 'verbosity');
    const region = readOptionalStringField(body, 'region');
    const safeSearch = readOptionalStringField(body, 'safeSearch');
    const timeRange = readOptionalStringField(body, 'timeRange');
    const evidenceExtract = readOptionalStringField(body, 'evidenceExtract');
    return {
      query,
      ...(providerId ? { providerId } : {}),
      ...(Object.hasOwn(body, 'maxResults') ? { maxResults: readBoundedBodyInteger(body.maxResults, 5, 50) } : {}),
      ...(verbosity ? { verbosity: verbosity as WebSearchVerbosity } : {}),
      ...(region ? { region } : {}),
      ...(safeSearch ? { safeSearch: safeSearch as WebSearchSafeSearch } : {}),
      ...(timeRange ? { timeRange: timeRange as WebSearchTimeRange } : {}),
      ...(typeof body.includeInstantAnswer === 'boolean' ? { includeInstantAnswer: body.includeInstantAnswer } : {}),
      ...(typeof body.includeEvidence === 'boolean' ? { includeEvidence: body.includeEvidence } : {}),
      ...(Object.hasOwn(body, 'evidenceTopN') ? { evidenceTopN: readBoundedBodyInteger(body.evidenceTopN, 3, 20) } : {}),
      ...(evidenceExtract ? { evidenceExtract: evidenceExtract as FetchExtractMode } : {}),
    };
  }),
  multimodalPacket: createRouteBodySchema<MultimodalPacketBody>('POST /api/multimodal/packet', (body) => {
    if (typeof body.analysis !== 'object' || body.analysis === null) {
      return jsonErrorResponse({ error: 'Missing analysis payload' }, { status: 400 });
    }
    const detail = readOptionalStringField(body, 'detail');
    return {
      analysis: body.analysis as MultimodalAnalysisResult,
      detail: (detail as MultimodalDetail | undefined) ?? 'standard',
      ...(Object.hasOwn(body, 'budgetLimit') ? { budgetLimit: readBoundedBodyInteger(body.budgetLimit, 8, 100) } : {}),
    };
  }),
});

async function handleVoiceTts(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  // pass context so defaults from tts.provider/tts.voice config are applied
  // consistently with handleVoiceTtsStream.
  const { providerId, input } = readVoiceSynthesisRequest(body, context);
  if (!input.text.trim()) return jsonErrorResponse({ error: 'Missing text' }, { status: 400 });
  try {
    const result = await context.voiceService.synthesize(
      providerId,
      input,
    );
    return Response.json(result);
  } catch (error) {
    if (isProviderNotConfiguredError(error)) {
      return jsonErrorResponse(
        { code: 'PROVIDER_NOT_CONFIGURED', error: readErrorMessage(error), source: 'provider', recoverable: false, hint: 'Configure the voice provider API key or service credentials.' },
        { status: 409 },
      );
    }
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleVoiceTtsStream(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const { providerId, input } = readVoiceSynthesisRequest(body, context);
  if (!input.text.trim()) return jsonErrorResponse({ error: 'Missing text' }, { status: 400 });
  try {
    const result = await context.voiceService.synthesizeStream(providerId, { ...input, signal: req.signal });
    return voiceStreamResponse(result);
  } catch (error) {
    if (isProviderNotConfiguredError(error)) {
      return jsonErrorResponse(
        { code: 'PROVIDER_NOT_CONFIGURED', error: readErrorMessage(error), source: 'provider', recoverable: false, hint: 'Configure the streaming TTS provider API key or service credentials.' },
        { status: 409 },
      );
    }
    return jsonErrorResponse(error, { status: 400 });
  }
}

function voiceStreamResponse(result: VoiceSynthesisStreamLike): Response {
  const iterator = result.chunks[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (value.data.byteLength > 0) {
            controller.enqueue(value.data);
            return;
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': result.mimeType,
      'Cache-Control': 'no-store',
      'X-GoodVibes-Voice-Provider': result.providerId,
      'X-GoodVibes-Audio-Format': result.format,
    },
  });
}

async function handleVoiceStt(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.audio !== 'object' || body.audio === null) {
    return jsonErrorResponse({ error: 'Missing audio artifact' }, { status: 400 });
  }
  try {
    const result = await context.voiceService.transcribe(
      typeof body.providerId === 'string' ? body.providerId : undefined,
      {
        audio: body.audio as VoiceAudioArtifact,
        language: typeof body.language === 'string' ? body.language : undefined,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      },
    );
    return Response.json(result);
  } catch (error) {
    if (isProviderNotConfiguredError(error)) {
      return jsonErrorResponse(
        { code: 'PROVIDER_NOT_CONFIGURED', error: readErrorMessage(error), source: 'provider', recoverable: false, hint: 'Configure the voice provider API key or service credentials.' },
        { status: 409 },
      );
    }
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleVoiceRealtimeSession(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const result = await context.voiceService.openRealtimeSession(
      typeof body.providerId === 'string' ? body.providerId : undefined,
      {
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
        inputFormat: typeof body.inputFormat === 'string' ? body.inputFormat : undefined,
        outputFormat: typeof body.outputFormat === 'string' ? body.outputFormat : undefined,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      },
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (isProviderNotConfiguredError(error)) {
      return jsonErrorResponse(
        { code: 'PROVIDER_NOT_CONFIGURED', error: readErrorMessage(error), source: 'provider', recoverable: false, hint: 'Configure the voice provider API key or service credentials.' },
        { status: 409 },
      );
    }
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleMediaAnalyze(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('understand', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.analyze) return jsonErrorResponse({ error: 'No media analysis provider is registered' }, { status: 404 });
  const artifact = typeof body.artifact === 'object' && body.artifact !== null
    ? body.artifact as MediaArtifact
    : typeof body.artifactId === 'string' && body.artifactId.trim().length > 0
      ? {
          artifactId: body.artifactId.trim(),
          mimeType: 'application/octet-stream',
          metadata: {},
        } satisfies MediaArtifact
      : null;
  if (!artifact) {
    return jsonErrorResponse({ error: 'Missing media artifact' }, { status: 400 });
  }
  return Response.json(await provider.analyze({
    artifact,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleArtifactCreate(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  if (isArtifactUploadRequest(req)) {
    const uploaded = await createArtifactFromUploadRequest(context.artifactStore, req);
    if (uploaded instanceof Response) return uploaded;
    return Response.json({ artifact: uploaded.artifact }, { status: 201 });
  }

  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const privateHostFetchOptions = resolvePrivateHostFetchOptions(body.allowPrivateHosts, {
    configManager: context.configManager,
    req,
    requireElevatedAccess: (request) => context.requireAdmin(request),
  });
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    const artifact = await context.artifactStore.create({
      ...(typeof body.kind === 'string' ? { kind: body.kind as ArtifactKind } : {}),
      ...(typeof body.mimeType === 'string' ? { mimeType: body.mimeType } : {}),
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
      ...(typeof body.dataBase64 === 'string' ? { dataBase64: body.dataBase64 } : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.uri === 'string' ? { uri: body.uri } : {}),
      ...(privateHostFetchOptions ?? {}),
      ...(typeof body.retentionMs === 'number' ? { retentionMs: body.retentionMs } : {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    });
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleArtifactContent(context: DaemonMediaRouteContext, artifactId: string, req: Request): Promise<Response> {
  try {
    const { record, buffer } = await context.artifactStore.readContent(artifactId);
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const headers = new Headers({
      'Content-Type': record.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=60',
    });
    const download = new URL(req.url).searchParams.get('download');
    if (record.filename && download !== '0') {
      // Strip non-ASCII bytes so the ASCII filename parameter stays valid.
      const asciiFallback = record.filename.replace(/[^\x20-\x7E]/g, '_').replace(/[\r\n"]/g, '_');
      headers.set('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(record.filename)}`);
    }
    return new Response(bytes as BodyInit, { status: 200, headers });
  } catch (error) {
    return jsonErrorResponse(error, { status: 404 });
  }
}

async function handleWebSearch(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = mediaBodySchemas.webSearch.parse(body);
  if (input instanceof Response) return input;
  try {
    return Response.json(await context.webSearchService.search(input));
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleMediaTransform(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('transform', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.transform) return jsonErrorResponse({ error: 'No media transform provider is registered' }, { status: 404 });
  if (typeof body.artifact !== 'object' || body.artifact === null) {
    return jsonErrorResponse({ error: 'Missing media artifact' }, { status: 400 });
  }
  const operation = typeof body.operation === 'string' ? body.operation : '';
  if (!operation) return jsonErrorResponse({ error: 'Missing media transform operation' }, { status: 400 });
  return Response.json(await provider.transform({
    artifact: body.artifact as MediaArtifact,
    operation,
    outputMimeType: typeof body.outputMimeType === 'string' ? body.outputMimeType : undefined,
    options: typeof body.options === 'object' && body.options !== null ? body.options as Record<string, unknown> : {},
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleMediaGenerate(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('generate', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.generate) return jsonErrorResponse({ error: 'No media generation provider is registered' }, { status: 404 });
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return jsonErrorResponse({ error: 'Missing media generation prompt' }, { status: 400 });
  return Response.json(await provider.generate({
    prompt,
    outputMimeType: typeof body.outputMimeType === 'string' ? body.outputMimeType : undefined,
    modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
    options: typeof body.options === 'object' && body.options !== null ? body.options as Record<string, unknown> : {},
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleMultimodalAnalyze(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const requestedArtifact = typeof body.artifact === 'object' && body.artifact !== null
    ? body.artifact as Record<string, unknown>
    : null;
  const privateHostFetchOptions = resolvePrivateHostFetchOptions(
    body.allowPrivateHosts === true || requestedArtifact?.allowPrivateHosts === true,
    {
      configManager: context.configManager,
      req,
      requireElevatedAccess: (request) => context.requireAdmin(request),
    },
  );
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    const analysis = await context.multimodalService.analyze({
      ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
      ...(requestedArtifact ? {
        artifact: {
          ...requestedArtifact,
          ...(privateHostFetchOptions ?? {}),
        },
      } : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.imageProviderId === 'string' ? { imageProviderId: body.imageProviderId } : {}),
      ...(typeof body.audioProviderId === 'string' ? { audioProviderId: body.audioProviderId } : {}),
      ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
      ...(typeof body.detail === 'string' ? { detail: body.detail as MultimodalDetail } : {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    });
    const includePacket = body.includePacket === true;
    const writeback = body.writeback === true || (typeof body.writeback === 'object' && body.writeback !== null);
    const writebackBody = typeof body.writeback === 'object' && body.writeback !== null
      ? body.writeback as Record<string, unknown>
      : null;
    const packet = includePacket
      ? context.multimodalService.buildPacket(
          analysis,
          typeof body.detail === 'string' ? body.detail as MultimodalDetail : 'standard',
        )
      : undefined;
    const writebackResult = writeback
      ? await context.multimodalService.writeBackAnalysis(analysis, {
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof writebackBody?.title === 'string' ? { title: writebackBody.title } : {}),
          ...(Array.isArray(writebackBody?.tags) ? { tags: writebackBody.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
          ...(typeof writebackBody?.folderPath === 'string' ? { folderPath: writebackBody.folderPath } : {}),
          ...(typeof writebackBody?.metadata === 'object' && writebackBody.metadata !== null ? { metadata: writebackBody.metadata as Record<string, unknown> } : {}),
        })
      : undefined;
    return Response.json({
      analysis,
      ...(packet ? { packet } : {}),
      ...(writebackResult ? { writeback: writebackResult } : {}),
    }, { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleMultimodalPacket(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = mediaBodySchemas.multimodalPacket.parse(body);
  if (input instanceof Response) return input;
  return Response.json({
    packet: context.multimodalService.buildPacket(
      input.analysis,
      input.detail,
      input.budgetLimit,
    ),
  });
}

async function handleMultimodalWriteback(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.analysis !== 'object' || body.analysis === null) {
    return jsonErrorResponse({ error: 'Missing analysis payload' }, { status: 400 });
  }
  const tags = readStringArrayField(body, 'tags', MAX_MEDIA_WRITEBACK_TAGS);
  try {
    const writeback = await context.multimodalService.writeBackAnalysis(
      body.analysis as MultimodalAnalysisResult,
      {
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(tags ? { tags } : {}),
        ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      },
    );
    return Response.json({ writeback }, { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}
