export { createProviderBackedKnowledgeSemanticLlm } from './llm.js';
export { createWebKnowledgeGapRepairer } from './gap-repair.js';
export { KnowledgeSemanticService } from './service.js';
export { runKnowledgeSemanticSelfImprovement } from './self-improvement.js';
export type { WebGapRepairOptions } from './gap-repair.js';
export type { KnowledgeSemanticServiceOptions } from './service.js';
export type {
  KnowledgeSemanticAnswer,
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticEnrichmentResult,
  KnowledgeSemanticExtraction,
  KnowledgeSemanticFactInput,
  KnowledgeSemanticFactKind,
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticGapRepairRequest,
  KnowledgeSemanticGapRepairResult,
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticLlmAnswer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
