import {
  DEFAULT_KNOWLEDGE_SPACE_ID,
  getExplicitKnowledgeSpaceId,
  normalizeKnowledgeSpaceId,
} from '../spaces.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';

interface AnswerEvidenceRecord {
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
}

export function concreteAnswerGapSpaceId(
  requestedSpaceId: string,
  evidence: readonly AnswerEvidenceRecord[],
  sources: readonly KnowledgeSourceRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): string {
  const explicitRecordSpace = concreteRecordSpaceId(evidence, sources, linkedObjects);
  if (explicitRecordSpace && explicitRecordSpace !== DEFAULT_KNOWLEDGE_SPACE_ID) return explicitRecordSpace;
  if (normalizeKnowledgeSpaceId(requestedSpaceId) !== 'homeassistant') return requestedSpaceId;
  if (explicitRecordSpace) return explicitRecordSpace;
  return requestedSpaceId;
}

function concreteRecordSpaceId(
  evidence: readonly AnswerEvidenceRecord[],
  sources: readonly KnowledgeSourceRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): string | null {
  for (const record of [
    ...linkedObjects,
    ...sources,
    ...evidence.flatMap((item) => [item.node, item.source]),
  ]) {
    const explicitSpaceId = record ? getExplicitKnowledgeSpaceId(record) : null;
    if (!explicitSpaceId) continue;
    const spaceId = normalizeKnowledgeSpaceId(explicitSpaceId);
    if (spaceId !== DEFAULT_KNOWLEDGE_SPACE_ID) return spaceId;
  }
  return null;
}
