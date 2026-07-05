/**
 * companion-chat-attachments.ts
 *
 * Pure attachment-resolution + provider-content helpers for CompanionChatManager.
 * Extracted so the manager file stays within its line budget; behaviour is
 * unchanged — every function takes the artifact store explicitly instead of
 * reaching through `this`.
 */

import { Buffer } from 'node:buffer';
import type { ContentPart } from '../providers/interface.js';
import type { ArtifactDescriptor } from '../artifacts/index.js';
import type {
  CompanionChatMessageAttachment,
  CompanionChatMessageAttachmentInput,
  CompanionChatMessage,
} from './companion-chat-types.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_INLINE_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 200 * 1024;

export interface CompanionChatArtifactStore {
  get(artifactId: string): ArtifactDescriptor | null;
  readContent(artifactId: string): Promise<{
    readonly record: { readonly mimeType: string; readonly filename?: string | undefined };
    readonly buffer: ArrayBuffer | Uint8Array | Buffer;
  }>;
}

export function toNodeBuffer(buffer: ArrayBuffer | Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(buffer)) return buffer;
  if (buffer instanceof ArrayBuffer) return Buffer.from(new Uint8Array(buffer));
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function resolveAttachments(
  inputs: readonly CompanionChatMessageAttachmentInput[],
  artifactStore: CompanionChatArtifactStore | null,
): CompanionChatMessageAttachment[] {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw Object.assign(
      new Error(`A companion chat message can include at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`),
      { code: 'TOO_MANY_ATTACHMENTS', status: 400 },
    );
  }
  if (!artifactStore) {
    throw Object.assign(
      new Error('Companion chat attachments require an artifact store.'),
      { code: 'ATTACHMENTS_UNAVAILABLE', status: 501 },
    );
  }

  return inputs.map((input) => {
    const artifactId = input.artifactId.trim();
    if (!artifactId) {
      throw Object.assign(new Error('Attachment artifactId is required.'), {
        code: 'INVALID_ATTACHMENT',
        status: 400,
      });
    }
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      throw Object.assign(new Error(`Unknown attachment artifact: ${artifactId}`), {
        code: 'UNKNOWN_ARTIFACT',
        status: 404,
      });
    }
    return {
      ...artifact,
      artifactId: artifact.id,
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      metadata: {
        ...artifact.metadata,
        ...(input.metadata ?? {}),
      },
    };
  });
}

export function formatAttachmentSummary(attachments: readonly CompanionChatMessageAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map((attachment, index) => {
    const name = attachment.label ?? attachment.filename ?? attachment.artifactId;
    return `${index + 1}. ${name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes, artifact ${attachment.artifactId})`;
  });
  return `\n\nAttached file${attachments.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

export function buildReplayUserContent(message: CompanionChatMessage): string {
  return `${message.content}${formatAttachmentSummary(message.attachments ?? [])}`;
}

function isInlineTextAttachment(attachment: CompanionChatMessageAttachment): boolean {
  const lower = attachment.mimeType.toLowerCase();
  return attachment.sizeBytes <= MAX_INLINE_TEXT_ATTACHMENT_BYTES
    && (lower.startsWith('text/')
      || lower === 'application/json'
      || lower === 'application/xml'
      || lower === 'application/yaml'
      || lower === 'text/csv');
}

function isInlineImageAttachment(attachment: CompanionChatMessageAttachment): boolean {
  const lower = attachment.mimeType.toLowerCase();
  return attachment.sizeBytes <= MAX_INLINE_IMAGE_ATTACHMENT_BYTES
    && (lower === 'image/png'
      || lower === 'image/jpeg'
      || lower === 'image/gif'
      || lower === 'image/webp');
}

export async function buildProviderUserContent(
  content: string,
  attachments: readonly CompanionChatMessageAttachment[],
  artifactStore: CompanionChatArtifactStore | null,
): Promise<string | ContentPart[]> {
  if (attachments.length === 0) return content;
  const textSections: string[] = [content.trim() ? content : 'Please review the attached file(s).'];
  const imageParts: ContentPart[] = [];

  for (const attachment of attachments) {
    if (!artifactStore) continue;
    try {
      if (isInlineTextAttachment(attachment)) {
        const { buffer } = await artifactStore.readContent(attachment.artifactId);
        const text = toNodeBuffer(buffer).toString('utf-8');
        textSections.push(
          `\n\n--- Attachment: ${attachment.label ?? attachment.filename ?? attachment.artifactId} ---\n${text}`,
        );
        continue;
      }
      if (isInlineImageAttachment(attachment)) {
        const { buffer } = await artifactStore.readContent(attachment.artifactId);
        imageParts.push({
          type: 'image',
          mediaType: attachment.mimeType,
          data: toNodeBuffer(buffer).toString('base64'),
        });
      }
    } catch (error) {
      logger.warn('[companion-chat] failed to inline attachment for provider prompt', {
        artifactId: attachment.artifactId,
        error: summarizeError(error),
      });
    }
  }

  textSections.push(formatAttachmentSummary(attachments));
  if (imageParts.length === 0) return textSections.join('');
  return [{ type: 'text', text: textSections.join('') }, ...imageParts];
}
