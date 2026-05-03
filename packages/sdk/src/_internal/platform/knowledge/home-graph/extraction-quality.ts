import {
  hasUsefulKnowledgeExtractionText,
} from '../extraction-policy.js';

export function isUnusableHomeGraphExtractionText(value: string | undefined): boolean {
  return !hasUsefulKnowledgeExtractionText(value);
}
