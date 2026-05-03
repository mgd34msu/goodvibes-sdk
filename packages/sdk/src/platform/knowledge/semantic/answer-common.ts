import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeSemanticLlm } from './types.js';

export interface KnowledgeAnswerContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[];
}

export interface EvidenceItem {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly title: string;
  readonly score: number;
  readonly source?: KnowledgeSourceRecord;
  readonly node?: KnowledgeNodeRecord;
  readonly excerpt?: string;
  readonly facts: readonly KnowledgeNodeRecord[];
}

export type AnswerFactRecord = KnowledgeNodeRecord & {
  readonly subject?: string;
  readonly subjectIds?: readonly string[];
  readonly targetHints?: readonly Record<string, unknown>[];
  readonly linkedObjectIds?: readonly string[];
};

export const GENERIC_ANSWER_INTENT_TOKENS = new Set([
  'capabilities',
  'capability',
  'configuration',
  'configure',
  'device',
  'feature',
  'features',
  'function',
  'functions',
  'install',
  'mode',
  'modes',
  'procedure',
  'setting',
  'settings',
  'setup',
  'spec',
  'specification',
  'specifications',
  'specs',
  'object',
  'support',
  'supported',
  'supports',
  'thing',
]);

export function isBroadKnowledgeSpaceAlias(spaceId: string): boolean {
  return normalizeKnowledgeSpaceId(spaceId) === 'homeassistant';
}
