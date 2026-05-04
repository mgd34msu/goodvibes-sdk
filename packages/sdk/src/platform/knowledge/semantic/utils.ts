import { createHash } from 'node:crypto';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { getKnowledgeSpaceId, knowledgeSpaceMetadata, normalizeKnowledgeSpaceId } from '../spaces.js';

export const MAX_SEMANTIC_SOURCE_CHARS = 28_000;
export const MAX_ANSWER_EVIDENCE_CHARS = 24_000;

const STOPWORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

export function semanticHash(...parts: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part ?? ''));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function semanticSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'knowledge';
}

export function clampText(value: string | undefined, limit: number): string {
  const text = normalizeWhitespace(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => readString(entry)));
}

export function uniqueStrings(values: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value ?? '');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function tokenizeSemanticQuery(value: string): string[] {
  return uniqueStrings(value
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token)));
}

export function scoreSemanticText(value: string | undefined, tokens: readonly string[]): number {
  const lower = (value ?? '').toLowerCase();
  if (!lower || tokens.length === 0) return 0;
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += token.length >= 5 ? 12 : 6;
  }
  return score;
}

export function sourceSemanticText(source: KnowledgeSourceRecord, extraction?: KnowledgeExtractionRecord | null): string {
  const structure = readRecord(extraction?.structure);
  const nestedStructure = readRecord(structure.structure);
  const metadata = readRecord(extraction?.metadata);
  const nestedMetadata = readRecord(structure.metadata);
  return uniqueStrings([
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
    source.tags.join(' '),
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
    ...(extraction?.sections ?? []),
    readString(structure.searchText),
    readString(structure.text),
    readString(structure.content),
    readString(nestedStructure.searchText),
    readString(nestedStructure.text),
    readString(nestedStructure.content),
    readString(metadata.searchText),
    readString(metadata.text),
    readString(nestedMetadata.searchText),
    readString(nestedMetadata.text),
  ]).join('\n\n');
}

export function sourceSemanticHash(source: KnowledgeSourceRecord, extraction?: KnowledgeExtractionRecord | null): string {
  return semanticHash(
    source.contentHash,
    source.updatedAt,
    extraction?.id,
    extraction?.updatedAt,
    sourceSemanticText(source, extraction),
  );
}

export function sourceKnowledgeSpace(source: KnowledgeSourceRecord): string {
  return normalizeKnowledgeSpaceId(getKnowledgeSpaceId(source));
}

export function nodeKnowledgeSpace(node: KnowledgeNodeRecord): string {
  return normalizeKnowledgeSpaceId(getKnowledgeSpaceId(node));
}

export function semanticMetadata(
  spaceId: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return knowledgeSpaceMetadata(spaceId, {
    ...metadata,
    semantic: true,
  });
}

export function extractJsonObject(text: string): unknown | null {
  const withoutFence = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const candidates = [withoutFence];
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(withoutFence.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      void error;
      // try the next candidate
    }
  }
  return null;
}

export function splitSentences(text: string, limit = 220): string[] {
  const normalized = normalizeWhitespace(text);
  const chunks = normalized.match(/[^.!?\n]+[.!?]?/g) ?? [];
  return uniqueStrings(chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 28 && chunk.length <= limit))
    .slice(0, 500);
}

export function applySourceMetadata(
  source: KnowledgeSourceRecord,
  metadata: Record<string, unknown>,
): {
  readonly id: string;
  readonly connectorId: string;
  readonly sourceType: KnowledgeSourceRecord['sourceType'];
  readonly title?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly canonicalUri?: string | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly tags: readonly string[];
  readonly folderPath?: string | undefined;
  readonly status: KnowledgeSourceRecord['status'];
  readonly artifactId?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly lastCrawledAt?: number | undefined;
  readonly crawlError?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly metadata: Record<string, unknown>;
} {
  return {
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    ...(source.title ? { title: source.title } : {}),
    ...(source.sourceUri ? { sourceUri: source.sourceUri } : {}),
    ...(source.canonicalUri ? { canonicalUri: source.canonicalUri } : {}),
    ...(source.summary ? { summary: source.summary } : {}),
    ...(source.description ? { description: source.description } : {}),
    tags: source.tags,
    ...(source.folderPath ? { folderPath: source.folderPath } : {}),
    status: source.status,
    ...(source.artifactId ? { artifactId: source.artifactId } : {}),
    ...(source.contentHash ? { contentHash: source.contentHash } : {}),
    ...(source.lastCrawledAt ? { lastCrawledAt: source.lastCrawledAt } : {}),
    ...(source.crawlError ? { crawlError: source.crawlError } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    metadata: {
      ...source.metadata,
      ...metadata,
    },
  };
}
