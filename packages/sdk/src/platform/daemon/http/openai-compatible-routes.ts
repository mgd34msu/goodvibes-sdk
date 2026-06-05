import type { ProviderRegistry } from '../../providers/registry.js';
import type { ChatResponse, ContentPart, LLMProvider, ProviderMessage, StreamDelta } from '../../providers/interface.js';
import type { ToolCall, ToolDefinition } from '../../types/tools.js';
import { summarizeError } from '../../utils/error-display.js';

type JsonRecord = Record<string, unknown>;

export interface OpenAICompatibleRouteContext {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'>;
  readonly parseJsonBody: (request: Request) => Promise<JsonRecord | Response>;
  readonly recordApiResponse: (request: Request, path: string, response: Response) => Response;
}

interface ResolvedModel {
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly modelId: string;
  readonly responseModel: string;
}

interface ChatCompletionRequest {
  readonly model?: unknown | undefined;
  readonly messages?: unknown | undefined;
  readonly stream?: unknown | undefined;
  readonly max_tokens?: unknown | undefined;
  readonly max_completion_tokens?: unknown | undefined;
  readonly tools?: unknown | undefined;
}

const OPENAI_COMPAT_PATH_PREFIX = '/v1';

export async function dispatchOpenAICompatibleRoutes(
  request: Request,
  context: OpenAICompatibleRouteContext,
  pathPrefix = OPENAI_COMPAT_PATH_PREFIX,
): Promise<Response | null> {
  const url = new URL(request.url);
  const prefix = normalizePathPrefix(pathPrefix);
  if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return null;
  const routePath = url.pathname.slice(prefix.length) || '/';

  if (request.method === 'GET' && routePath === '/models') {
    return context.recordApiResponse(request, `${prefix}/models`, handleListModels(context));
  }

  if (request.method === 'POST' && routePath === '/chat/completions') {
    const response = await handleChatCompletions(request, context);
    return context.recordApiResponse(request, `${prefix}/chat/completions`, response);
  }

  return null;
}

function handleListModels(context: OpenAICompatibleRouteContext): Response {
  const created = Math.floor(Date.now() / 1000);
  const models = context.providerRegistry.listModels();
  const current = context.providerRegistry.getCurrentModel();
  const ids = new Set<string>(['goodvibes/current']);

  for (const model of models) {
    ids.add(model.registryKey);
  }

  return Response.json({
    object: 'list',
    data: [...ids].sort().map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: id.startsWith('goodvibes/') ? 'goodvibes' : modelOwnerFor(id, models, current.provider),
    })),
  });
}

async function handleChatCompletions(
  request: Request,
  context: OpenAICompatibleRouteContext,
): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return openAIErrorFromResponse(body);

  const parsed = body as ChatCompletionRequest;
  if (!Array.isArray(parsed.messages)) {
    return openAIError('Missing required field: messages', 400, 'invalid_request_error', 'missing_messages');
  }

  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(context.providerRegistry, typeof parsed.model === 'string' ? parsed.model : undefined);
  } catch (error) {
    return openAIError(summarizeError(error), 400, 'invalid_request_error', 'model_not_found');
  }

  let prepared: { readonly messages: ProviderMessage[]; readonly systemPrompt?: string | undefined; readonly tools?: ToolDefinition[] | undefined };
  try {
    prepared = prepareChatRequest(parsed);
  } catch (error) {
    return openAIError(summarizeError(error), 400, 'invalid_request_error', 'invalid_messages');
  }

  const maxTokens = readMaxTokens(parsed);
  if (parsed.stream === true) {
    return streamChatCompletion({
      request,
      resolved,
      prepared,
      maxTokens,
    });
  }

  try {
    const response = await resolved.provider.chat({
      model: resolved.modelId,
      messages: prepared.messages,
      ...(prepared.tools && prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
      ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: request.signal,
    });
    return Response.json(buildChatCompletionResponse(resolved.responseModel, response));
  } catch (error) {
    return openAIError(summarizeError(error), 500, 'server_error', 'provider_error');
  }
}

function resolveModel(
  registry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'>,
  requested: string | undefined,
): ResolvedModel {
  const current = registry.getCurrentModel();
  const raw = requested?.trim();
  if (!raw) {
    throw new Error('Missing required field: model.');
  }
  if (raw === 'goodvibes/current') {
    return {
      provider: registry.getForModel(current.registryKey, current.provider),
      providerId: current.provider,
      modelId: current.id,
      responseModel: raw,
    };
  }

  const models = registry.listModels();
  const exact = models.find((model) => model.registryKey === raw);
  if (exact) {
    return {
      provider: registry.getForModel(exact.registryKey, exact.provider),
      providerId: exact.provider,
      modelId: exact.id,
      responseModel: exact.registryKey,
    };
  }

  throw new Error(
    raw.includes(':')
      ? `Model '${raw}' not found.`
      : `Model '${raw}' must be requested as a provider-qualified registryKey.`,
  );
}

function prepareChatRequest(input: ChatCompletionRequest): {
  readonly messages: ProviderMessage[];
  readonly systemPrompt?: string | undefined;
  readonly tools?: ToolDefinition[] | undefined;
} {
  const systemParts: string[] = [];
  const messages: ProviderMessage[] = [];

  for (const message of input.messages as unknown[]) {
    if (!isRecord(message)) throw new Error('Each message must be an object.');
    const role = readString(message.role);
    if (!role) throw new Error('Each message must include a role.');

    if (role === 'system' || role === 'developer') {
      const content = contentAsText(normalizeMessageContent(message.content));
      if (content.trim()) systemParts.push(content);
      continue;
    }

    if (role === 'user') {
      messages.push({ role: 'user', content: normalizeMessageContent(message.content) });
      continue;
    }

    if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: contentAsText(normalizeMessageContent(message.content)),
        ...(Array.isArray(message.tool_calls) ? { toolCalls: normalizeToolCalls(message.tool_calls) } : {}),
      });
      continue;
    }

    if (role === 'tool') {
      const callId = readString(message.tool_call_id) ?? readString(message.callId);
      if (!callId) throw new Error('Tool messages must include tool_call_id.');
      messages.push({
        role: 'tool',
        callId,
        content: contentAsText(normalizeMessageContent(message.content)),
        ...(readString(message.name) ? { name: readString(message.name) } : {}),
      });
      continue;
    }

    throw new Error(`Unsupported message role: ${role}`);
  }

  return {
    messages,
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join('\n\n') } : {}),
    ...(Array.isArray(input.tools) ? { tools: normalizeTools(input.tools) } : {}),
  };
}

function normalizeMessageContent(content: unknown): string | ContentPart[] {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return String(content);

  const parts: ContentPart[] = [];
  const textParts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      textParts.push(String(item));
      continue;
    }
    const type = readString(item.type);
    if (type === 'text' || type === 'input_text') {
      const text = readString(item.text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'image_url' && isRecord(item.image_url)) {
      const url = readString(item.image_url.url);
      if (url?.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (parsed) parts.push({ type: 'image', data: parsed.data, mediaType: parsed.mediaType });
      } else if (url) {
        textParts.push(`[image_url: ${url}]`);
      }
    }
  }
  if (parts.length === 0) return textParts.join('\n');
  if (textParts.length > 0) parts.unshift({ type: 'text', text: textParts.join('\n') });
  return parts;
}

function contentAsText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? part.text : `[image:${part.mediaType}]`).join('\n');
}

function normalizeTools(tools: readonly unknown[]): ToolDefinition[] {
  const normalized: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) continue;
    const name = readString(tool.function.name);
    if (!name) continue;
    normalized.push({
      name,
      description: readString(tool.function.description) ?? '',
      parameters: isRecord(tool.function.parameters) ? tool.function.parameters : { type: 'object', properties: {} },
    });
  }
  return normalized;
}

function normalizeToolCalls(toolCalls: readonly unknown[]): ToolCall[] {
  const normalized: ToolCall[] = [];
  for (const call of toolCalls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    const id = readString(call.id);
    const name = readString(call.function.name);
    if (!id || !name) continue;
    normalized.push({
      id,
      name,
      arguments: parseToolArguments(readString(call.function.arguments) ?? '{}'),
    });
  }
  return normalized;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function readMaxTokens(input: ChatCompletionRequest): number | undefined {
  const candidate = typeof input.max_completion_tokens === 'number'
    ? input.max_completion_tokens
    : typeof input.max_tokens === 'number'
      ? input.max_tokens
      : undefined;
  return candidate !== undefined && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : undefined;
}

function buildChatCompletionResponse(model: string, response: ChatResponse): JsonRecord {
  return {
    id: `chatcmpl-goodvibes-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response.content || null,
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls.map(toOpenAIToolCall) } : {}),
      },
      logprobs: null,
      finish_reason: mapFinishReason(response.stopReason),
    }],
    usage: buildUsage(response),
  };
}

function streamChatCompletion(input: {
  readonly request: Request;
  readonly resolved: ResolvedModel;
  readonly prepared: { readonly messages: ProviderMessage[]; readonly systemPrompt?: string | undefined; readonly tools?: ToolDefinition[] | undefined };
  readonly maxTokens?: number | undefined;
}): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-goodvibes-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  let streamedContent = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: JsonRecord | '[DONE]') => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`));
      };

      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: input.resolved.responseModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, logprobs: null, finish_reason: null }],
      });

      const onDelta = (delta: StreamDelta) => {
        if (delta.content) {
          streamedContent = true;
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{ index: 0, delta: { content: delta.content }, logprobs: null, finish_reason: null }],
          });
        }
      };

      input.resolved.provider.chat({
        model: input.resolved.modelId,
        messages: input.prepared.messages,
        ...(input.prepared.tools && input.prepared.tools.length > 0 ? { tools: input.prepared.tools } : {}),
        ...(input.prepared.systemPrompt ? { systemPrompt: input.prepared.systemPrompt } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        signal: input.request.signal,
        onDelta,
      }).then((response) => {
        if (!streamedContent && response.content) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{ index: 0, delta: { content: response.content }, logprobs: null, finish_reason: null }],
          });
        }
        if (response.toolCalls.length > 0) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model: input.resolved.responseModel,
            choices: [{
              index: 0,
              delta: { tool_calls: response.toolCalls.map(toOpenAIToolCall) },
              logprobs: null,
              finish_reason: null,
            }],
          });
        }
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.resolved.responseModel,
          choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: mapFinishReason(response.stopReason) }],
          usage: buildUsage(response),
        });
        send('[DONE]');
        closed = true;
        controller.close();
      }).catch((error) => {
        send({ error: openAIErrorBody(summarizeError(error), 'server_error', 'provider_error') });
        send('[DONE]');
        closed = true;
        controller.close();
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function buildUsage(response: ChatResponse): JsonRecord {
  const promptTokens = response.usage.inputTokens + (response.usage.cacheReadTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0);
  const completionTokens = response.usage.outputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function toOpenAIToolCall(call: ToolCall): JsonRecord {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  };
}

function mapFinishReason(reason: ChatResponse['stopReason']): string {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_call') return 'tool_calls';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function openAIError(message: string, status: number, type: string, code: string): Response {
  return Response.json({ error: openAIErrorBody(message, type, code) }, { status });
}

function openAIErrorBody(message: string, type: string, code: string): JsonRecord {
  return { message, type, param: null, code };
}

function openAIErrorFromResponse(response: Response): Response {
  return openAIError(response.statusText || 'Invalid request body', response.status || 400, 'invalid_request_error', 'invalid_json');
}

function modelOwnerFor(id: string, models: ReturnType<ProviderRegistry['listModels']>, defaultOwner: string): string {
  const registryMatch = models.find((model) => model.registryKey === id);
  if (registryMatch) return registryMatch.provider;
  return defaultOwner;
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') return OPENAI_COMPAT_PATH_PREFIX;
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/u, '') : `/${trimmed.replace(/\/+$/u, '')}`;
}

function parseDataUrl(value: string): { mediaType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) return null;
  return { mediaType: match[1]!, data: match[2]! };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
