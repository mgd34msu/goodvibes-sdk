import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export type KnowledgeSpaceId = string;

export const DEFAULT_KNOWLEDGE_SPACE_ID = 'default';
export const HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX = 'homeassistant:';
export const PROJECT_KNOWLEDGE_SPACE_PREFIX = 'project:';

export type KnowledgeSpaceBackedRecord =
  | KnowledgeSourceRecord
  | KnowledgeNodeRecord
  | KnowledgeEdgeRecord
  | KnowledgeIssueRecord
  | KnowledgeExtractionRecord
  | { readonly metadata?: Record<string, unknown> };

export interface KnowledgeSpaceScopeInput {
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
}

export function normalizeKnowledgeSpaceId(value?: string | null): KnowledgeSpaceId {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_KNOWLEDGE_SPACE_ID;
}

export function homeAssistantKnowledgeSpaceId(installationId?: string | null): KnowledgeSpaceId {
  const normalized = normalizeSpaceComponent(installationId ?? 'default');
  return `${HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX}${normalized}`;
}

export function normalizeHomeAssistantInstallationId(value?: string | null): string {
  return normalizeSpaceComponent(value ?? 'default');
}

export function isHomeAssistantKnowledgeSpace(spaceId: string): boolean {
  return normalizeKnowledgeSpaceId(spaceId).startsWith(HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX);
}

export function projectKnowledgeSpaceId(projectId?: string | null): KnowledgeSpaceId {
  return `${PROJECT_KNOWLEDGE_SPACE_PREFIX}${normalizeProjectId(projectId ?? 'default')}`;
}

export function normalizeProjectId(value?: string | null): string {
  return normalizeSpaceComponent(value ?? 'default');
}

export function isProjectKnowledgeSpace(spaceId: string): boolean {
  return normalizeKnowledgeSpaceId(spaceId).startsWith(PROJECT_KNOWLEDGE_SPACE_PREFIX);
}

export function knowledgeSpaceMetadata(
  spaceId: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  return {
    ...metadata,
    knowledgeSpaceId: normalized,
    namespace: normalized,
  };
}

export function withKnowledgeSpace<T extends { readonly metadata?: Record<string, unknown> }>(
  input: T,
  spaceId: string,
): T {
  return {
    ...input,
    metadata: knowledgeSpaceMetadata(spaceId, input.metadata ?? {}),
  };
}

export function getKnowledgeSpaceId(input: KnowledgeSpaceBackedRecord | Record<string, unknown> | undefined | null): KnowledgeSpaceId {
  return getExplicitKnowledgeSpaceId(input) ?? DEFAULT_KNOWLEDGE_SPACE_ID;
}

export function getExplicitKnowledgeSpaceId(input: KnowledgeSpaceBackedRecord | Record<string, unknown> | undefined | null): KnowledgeSpaceId | null {
  const metadata = readMetadata(input);
  const value =
    readString(metadata.knowledgeSpaceId)
      ?? readString(metadata.spaceId)
      ?? readString(metadata.namespace);
  return value ? normalizeKnowledgeSpaceId(value) : null;
}

export function isInKnowledgeSpace(input: KnowledgeSpaceBackedRecord | undefined | null, spaceId: string): boolean {
  return getKnowledgeSpaceId(input) === normalizeKnowledgeSpaceId(spaceId);
}

export function resolveKnowledgeSpaceScope(input: KnowledgeSpaceScopeInput = {}): KnowledgeSpaceId | null {
  if (input.includeAllSpaces === true) return null;
  return normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
}

export function isInKnowledgeSpaceScope(
  input: KnowledgeSpaceBackedRecord | undefined | null,
  scope: KnowledgeSpaceScopeInput = {},
): boolean {
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (scopedSpaceId === null) return true;
  return getKnowledgeSpaceId(input) === scopedSpaceId;
}

export function ensureKnowledgeSpaceMetadata(
  metadata: Record<string, unknown> = {},
  fallbackSpaceId: string = DEFAULT_KNOWLEDGE_SPACE_ID,
): Record<string, unknown> {
  return getExplicitKnowledgeSpaceId({ metadata })
    ? metadata
    : knowledgeSpaceMetadata(fallbackSpaceId, metadata);
}

export function normalizeSpaceComponent(value?: string | null): string {
  const normalized = (typeof value === 'string' ? value : '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'default';
}

function readMetadata(input: KnowledgeSpaceBackedRecord | Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const candidate = (input as { readonly metadata?: unknown }).metadata;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
