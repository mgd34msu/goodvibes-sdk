import { z } from 'zod/v4';

/**
 * Schemas for the model catalog and global model-selection HTTP API.
 *
 * Endpoints:
 *   GET    /api/models          → ListProviderModelsResponseSchema
 *   GET    /api/models/current  → CurrentModelResponseSchema
 *   PATCH  /api/models/current  → PatchCurrentModelBodySchema (request) / CurrentModelResponseSchema (response)
 */

export const ProviderModelRefSchema = z.object({
  registryKey: z.string(),
  provider: z.string(),
  id: z.string(),
}).strict();
export type ProviderModelRef = z.infer<typeof ProviderModelRefSchema>;

export const ProviderModelEntrySchema = z.object({
  id: z.string(),
  registryKey: z.string(),
  provider: z.string(),
  label: z.string().optional(),
  contextWindow: z.number().optional(),
}).strict();
export type ProviderModelEntry = z.infer<typeof ProviderModelEntrySchema>;

export const ConfiguredViaSchema = z.enum(['env', 'secrets', 'subscription', 'anonymous']);
export type ConfiguredVia = z.infer<typeof ConfiguredViaSchema>;

export const ProviderAuthRouteDescriptorSchema = z.object({
  route: z.enum(['api-key', 'secret-ref', 'service-oauth', 'subscription-oauth', 'anonymous', 'none']),
  label: z.string(),
  configured: z.boolean(),
  usable: z.boolean().optional(),
  freshness: z.enum(['healthy', 'expiring', 'expired', 'pending', 'unconfigured']).optional(),
  detail: z.string().optional(),
  envVars: z.array(z.string()).optional(),
  secretKeys: z.array(z.string()).optional(),
  serviceNames: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  repairHints: z.array(z.string()).optional(),
}).strict();
export type ProviderAuthRouteDescriptor = z.infer<typeof ProviderAuthRouteDescriptorSchema>;

export const ProviderModelProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  configured: z.boolean(),
  configuredVia: ConfiguredViaSchema.optional(),
  envVars: z.array(z.string()),
  routes: z.array(ProviderAuthRouteDescriptorSchema).optional(),
  models: z.array(ProviderModelEntrySchema),
}).strict();
export type ProviderModelProvider = z.infer<typeof ProviderModelProviderSchema>;

export const ListProviderModelsResponseSchema = z.object({
  providers: z.array(ProviderModelProviderSchema),
  currentModel: ProviderModelRefSchema.nullable(),
  secretsResolutionSkipped: z.boolean(),
}).strict();
export type ListProviderModelsResponse = z.infer<typeof ListProviderModelsResponseSchema>;

export const CurrentModelResponseSchema = z.object({
  model: ProviderModelRefSchema.nullable(),
  configured: z.boolean(),
  configuredVia: ConfiguredViaSchema.optional(),
  routes: z.array(ProviderAuthRouteDescriptorSchema).optional(),
}).strict();
export type CurrentModelResponse = z.infer<typeof CurrentModelResponseSchema>;

export const PatchCurrentModelBodySchema = z.object({
  registryKey: z.string().min(1),
}).strict();
export type PatchCurrentModelBody = z.infer<typeof PatchCurrentModelBodySchema>;

export const PatchCurrentModelErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['INVALID_REQUEST', 'MODEL_NOT_FOUND', 'PROVIDER_NOT_CONFIGURED', 'SET_MODEL_FAILED']),
  missingEnvVars: z.array(z.string()).optional(),
}).strict();
export type PatchCurrentModelError = z.infer<typeof PatchCurrentModelErrorSchema>;

export const PatchCurrentModelResponseSchema = CurrentModelResponseSchema.extend({
  persisted: z.boolean(),
}).strict();
export type PatchCurrentModelResponse = z.infer<typeof PatchCurrentModelResponseSchema>;

/**
 * SSE event shape emitted on `model.changed` events.
 *
 * Forwarded to companion SSE streams when the current model changes.
 */
export const ModelChangedEventSchema = z.object({
  type: z.literal('MODEL_CHANGED'),
  registryKey: z.string(),
  provider: z.string(),
  previous: z.object({
    registryKey: z.string(),
    provider: z.string(),
  }).strict().optional(),
}).strict();
export type ModelChangedEvent = z.infer<typeof ModelChangedEventSchema>;
