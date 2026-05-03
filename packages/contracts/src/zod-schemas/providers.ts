import { z } from 'zod/v4';

/**
 * Schemas for the provider/model discovery and selection HTTP API.
 *
 * Endpoints:
 *   GET    /api/providers          → ListProvidersResponseSchema
 *   GET    /api/providers/current  → CurrentModelResponseSchema
 *   PATCH  /api/providers/current  → PatchCurrentModelBodySchema (request) / CurrentModelResponseSchema (response)
 */

/** @experimental Provider HTTP schema coverage is still being aligned with the operator contract. */
export const ProviderModelRefSchema = z.object({
  registryKey: z.string(),
  provider: z.string(),
  id: z.string(),
});
export type ProviderModelRef = z.infer<typeof ProviderModelRefSchema>;

export const ProviderModelEntrySchema = z.object({
  id: z.string(),
  registryKey: z.string(),
  provider: z.string(),
  label: z.string().optional(),
  contextWindow: z.number().optional(),
});
export type ProviderModelEntry = z.infer<typeof ProviderModelEntrySchema>;

export const ConfiguredViaSchema = z.enum(['env', 'secrets', 'subscription', 'anonymous']);
export type ConfiguredVia = z.infer<typeof ConfiguredViaSchema>;

/** @experimental Provider HTTP schema coverage is still being aligned with the operator contract. */
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
});
export type ProviderAuthRouteDescriptor = z.infer<typeof ProviderAuthRouteDescriptorSchema>;

export const ProviderEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  configured: z.boolean(),
  configuredVia: ConfiguredViaSchema.optional(),
  envVars: z.array(z.string()),
  routes: z.array(ProviderAuthRouteDescriptorSchema).optional(),
  models: z.array(ProviderModelEntrySchema),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const ListProvidersResponseSchema = z.object({
  providers: z.array(ProviderEntrySchema),
  currentModel: ProviderModelRefSchema.nullable(),
  secretsResolutionSkipped: z.boolean().optional(),
});
export type ListProvidersResponse = z.infer<typeof ListProvidersResponseSchema>;

export const CurrentModelResponseSchema = z.object({
  model: ProviderModelRefSchema.nullable(),
  configured: z.boolean(),
  configuredVia: ConfiguredViaSchema.optional(),
  routes: z.array(ProviderAuthRouteDescriptorSchema).optional(),
});
export type CurrentModelResponse = z.infer<typeof CurrentModelResponseSchema>;

export const PatchCurrentModelBodySchema = z.object({
  registryKey: z.string().min(1),
});
export type PatchCurrentModelBody = z.infer<typeof PatchCurrentModelBodySchema>;

export const PatchCurrentModelErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['INVALID_REQUEST', 'MODEL_NOT_FOUND', 'PROVIDER_NOT_CONFIGURED', 'SET_MODEL_FAILED']),
  missingEnvVars: z.array(z.string()).optional(),
});
export type PatchCurrentModelError = z.infer<typeof PatchCurrentModelErrorSchema>;

/** @experimental Provider HTTP schema coverage is still being aligned with the operator contract. */
export const PatchCurrentModelResponseSchema = CurrentModelResponseSchema.extend({
  persisted: z.boolean(),
});
export type PatchCurrentModelResponse = z.infer<typeof PatchCurrentModelResponseSchema>;

/**
 * SSE event shape emitted on `model.changed` events.
 *
 * Forwarded to companion SSE streams when the current model changes.
 */
/** @experimental Provider event schema coverage is still being aligned with the operator contract. */
export const ModelChangedEventSchema = z.object({
  type: z.literal('MODEL_CHANGED'),
  registryKey: z.string(),
  provider: z.string(),
  previous: z.object({
    registryKey: z.string(),
    provider: z.string(),
  }).optional(),
});
export type ModelChangedEvent = z.infer<typeof ModelChangedEventSchema>;
