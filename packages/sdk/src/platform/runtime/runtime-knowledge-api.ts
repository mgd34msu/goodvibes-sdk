import { createKnowledgeApi, type CreateKnowledgeApiOptions, type KnowledgeApi } from '../knowledge/knowledge-api.js';
import type { RuntimeServices } from './services.js';

export interface RuntimeKnowledgeApiServices
  extends Pick<RuntimeServices, 'knowledgeService' | 'memoryRegistry' | 'codeIndexStore'> {}

export function createRuntimeKnowledgeApi(
  runtimeServices: RuntimeKnowledgeApiServices,
): KnowledgeApi {
  const options: CreateKnowledgeApiOptions = {
    memoryRegistry: runtimeServices.memoryRegistry,
    codeIndexStore: runtimeServices.codeIndexStore,
  };
  return createKnowledgeApi(runtimeServices.knowledgeService, options);
}
