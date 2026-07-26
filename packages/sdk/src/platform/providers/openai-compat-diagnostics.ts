/**
 * providers/openai-compat-diagnostics.ts
 *
 * The diagnostic surface of the generic OpenAI-compatible provider: what a
 * chat request LOOKED like, and what a failed one actually SAID.
 *
 * Split out of openai-compat.ts, which had grown past the 800-line cap. These
 * helpers are pure and provider-agnostic — they read a request or an error and
 * return a description — so they carry no client, no retry state and no
 * streaming state, and the provider file is left holding only the client
 * lifecycle and the chat/stream loop.
 *
 * Two jobs live here:
 *
 *  - `buildChatRequestFingerprint` summarizes a request by SHAPE (message and
 *    token counts, image parts, tool count, reasoning settings) and never by
 *    content, so a turn can be logged without putting the conversation in the
 *    log.
 *  - `extractOpenAICompatErrorDiagnostic` / `buildOpenAICompatErrorMessage`
 *    turn a vendor error into one honest line. OpenAI-compatible backends
 *    disagree about where the reason lives — a top-level `code`/`type`, a
 *    nested `error` object, a bare string body, a request id on a header under
 *    either spelling — so the reason is pulled from wherever that backend put
 *    it rather than reported as a bare status code.
 */
import type { ChatRequest } from './interface.js';
import { summarizeError } from '../utils/error-display.js';

export interface ChatRequestFingerprint {
  readonly model: string;
  readonly messageCount: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly contentChars: number;
  readonly imageParts: number;
  readonly toolCount: number;
  readonly systemPromptChars: number;
  readonly reasoningEffort: ChatRequest['reasoningEffort'] | null;
  readonly reasoningSummary: boolean;
  readonly maxTokens: number | null;
}

export interface OpenAICompatErrorDiagnostic {
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly type?: string | undefined;
  readonly requestId?: string | undefined;
  readonly detail?: string | undefined;
  readonly rawMessage: string;
}

function summarizeContent(
  content: ChatRequest['messages'][number]['content'],
): { readonly textChars: number; readonly imageParts: number } {
  if (typeof content === 'string') {
    return { textChars: content.length, imageParts: 0 };
  }

  let textChars = 0;
  let imageParts = 0;
  for (const part of content) {
    if (part.type === 'text') textChars += part.text.length;
    if (part.type === 'image') imageParts += 1;
  }
  return { textChars, imageParts };
}

export function buildChatRequestFingerprint(
  request: ChatRequest,
  model: string,
): ChatRequestFingerprint {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let contentChars = 0;
  let imageParts = 0;

  for (const message of request.messages) {
    if (message.role === 'user') {
      userMessages += 1;
      const content = summarizeContent(message.content);
      contentChars += content.textChars;
      imageParts += content.imageParts;
    } else if (message.role === 'assistant') {
      assistantMessages += 1;
      contentChars += message.content.length;
    } else if (message.role === 'tool') {
      toolMessages += 1;
      contentChars += message.content.length;
    }
  }

  return {
    model,
    messageCount: request.messages.length,
    userMessages,
    assistantMessages,
    toolMessages,
    contentChars,
    imageParts,
    toolCount: request.tools?.length ?? 0,
    systemPromptChars: request.systemPrompt?.length ?? 0,
    reasoningEffort: request.reasoningEffort ?? null,
    reasoningSummary: Boolean(request.reasoningSummary),
    maxTokens: request.maxTokens ?? null,
  };
}

function truncateDetail(detail: string, max = 280): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max - 3)}...`;
}

function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const loweredName = name.toLowerCase();
    const match = headers.find((entry) =>
      Array.isArray(entry) &&
      entry.length >= 2 &&
      typeof entry[0] === 'string' &&
      entry[0].toLowerCase() === loweredName &&
      typeof entry[1] === 'string');
    return Array.isArray(match) ? match[1] : undefined;
  }
  if (typeof headers === 'object') {
    const loweredName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() !== loweredName) continue;
      if (typeof value === 'string' && value.trim().length > 0) return value;
      if (Array.isArray(value)) {
        const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        if (parts.length > 0) return parts.join(', ');
      }
    }
  }
  return undefined;
}

function formatErrorBodyDetail(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return truncateDetail(value.trim());
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const detailParts: string[] = [];
  const message = extractStringField(record, 'message');
  const code = extractStringField(record, 'code');
  const type = extractStringField(record, 'type');
  const param = extractStringField(record, 'param');

  if (message) detailParts.push(message);
  if (code && !detailParts.some((part) => part.includes(code))) detailParts.push(`code=${code}`);
  if (type && !detailParts.some((part) => part.includes(type))) detailParts.push(`type=${type}`);
  if (param && !detailParts.some((part) => part.includes(param))) detailParts.push(`param=${param}`);

  if (detailParts.length > 0) return truncateDetail(detailParts.join(', '));

  try {
    return truncateDetail(JSON.stringify(record));
  } catch {
    return undefined;
  }
}

export function extractOpenAICompatErrorDiagnostic(err: unknown): OpenAICompatErrorDiagnostic {
  const rawMessage = summarizeError(err);
  const status = err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;

  if (!err || typeof err !== 'object') {
    return { status, rawMessage };
  }

  const record = err as Record<string, unknown>;
  const detail = formatErrorBodyDetail(record.error) ?? (rawMessage.trim().length > 0 ? truncateDetail(rawMessage.trim()) : undefined);
  return {
    status,
    code: extractStringField(record, 'code'),
    type: extractStringField(record, 'type'),
    requestId: extractStringField(record, 'requestID')
      ?? extractHeaderValue(record.headers, 'x-request-id')
      ?? extractHeaderValue(record.headers, 'request-id'),
    detail,
    rawMessage,
  };
}

export function buildOpenAICompatErrorMessage(
  providerName: string,
  phase: 'request' | 'stream',
  diagnostic: OpenAICompatErrorDiagnostic,
): string {
  const prefix = `${providerName} chat ${phase} failed${diagnostic.status !== undefined ? ` ${diagnostic.status}` : ''}`;
  const messageParts = [prefix];

  if (diagnostic.detail && diagnostic.detail !== diagnostic.rawMessage) {
    messageParts.push(diagnostic.detail);
  } else if (diagnostic.rawMessage.trim().length > 0) {
    messageParts.push(truncateDetail(diagnostic.rawMessage.trim()));
  }

  const metadata: string[] = [];
  if (diagnostic.code && !messageParts.some((part) => part.includes(diagnostic.code!))) metadata.push(`code=${diagnostic.code}`);
  if (diagnostic.type && !messageParts.some((part) => part.includes(diagnostic.type!))) metadata.push(`type=${diagnostic.type}`);
  if (diagnostic.requestId) metadata.push(`request_id=${diagnostic.requestId}`);

  return metadata.length > 0
    ? `${messageParts.join(': ')} (${metadata.join(', ')})`
    : messageParts.join(': ');
}
