export { createProviderBackedKnowledgeSemanticLlm } from './llm.js';
export { createWebKnowledgeGapRepairer } from './gap-repair.js';
export { KnowledgeSemanticService } from './service.js';
export { runKnowledgeSemanticSelfImprovement } from './self-improvement.js';
export {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  isSemanticAnswerLinkedObject,
  isUsefulKnowledgePageFact,
  semanticFactText,
} from './fact-quality.js';
export {
  renderFallbackAnswer,
} from './answer-fallback.js';
export type {
  KnowledgePageFactQualityOptions,
} from './fact-quality.js';
export type {
  AnswerFallbackEvidence,
  AnswerFallbackPolicy,
  FallbackAnswer,
} from './answer-fallback.js';
export type { WebGapRepairOptions } from './gap-repair.js';
export type { KnowledgeSemanticServiceOptions } from './service.js';
export type {
  KnowledgeSemanticAnswer,
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerRefinement,
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
