import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';

interface AnswerEvidenceRecord {
  readonly node?: KnowledgeNodeRecord;
  readonly source?: KnowledgeSourceRecord;
}

export function concreteAnswerGapSpaceId(
  requestedSpaceId: string,
  evidence: readonly AnswerEvidenceRecord[],
  sources: readonly KnowledgeSourceRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): string {
  if (normalizeKnowledgeSpaceId(requestedSpaceId) !== 'homeassistant') return requestedSpaceId;
  for (const record of [
    ...linkedObjects,
    ...sources,
    ...evidence.flatMap((item) => [item.node, item.source]),
  ]) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(record));
    if (isHomeAssistantKnowledgeSpace(spaceId)) return spaceId;
  }
  return requestedSpaceId;
}
