import { z } from 'zod/v4';

const RouteKindSchema = z.enum(['api-key', 'service-oauth', 'subscription', 'unconfigured']);
const AuthFreshnessSchema = z.enum(['expired', 'expiring', 'healthy', 'pending', 'unconfigured']);

const ProviderRouteRecordSchema = z.object({
  route: RouteKindSchema,
  usable: z.boolean(),
  freshness: AuthFreshnessSchema,
  detail: z.string(),
  issues: z.array(z.string()),
});

const UsageWindowSchema = z.object({
  label: z.string(),
  detail: z.string(),
});

const ProviderSnapshotSchema = z.object({
  providerId: z.string(),
  active: z.boolean(),
  modelCount: z.number(),
  configured: z.boolean(),
  oauthReady: z.boolean(),
  pendingLogin: z.boolean(),
  availableRoutes: z.array(RouteKindSchema),
  preferredRoute: RouteKindSchema,
  activeRoute: RouteKindSchema,
  activeRouteReason: z.string(),
  authFreshness: AuthFreshnessSchema,
  fallbackRoute: RouteKindSchema.optional(),
  fallbackRisk: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenType: z.string().optional(),
  notes: z.array(z.string()),
  usageWindows: z.array(UsageWindowSchema),
  issues: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  routeRecords: z.array(ProviderRouteRecordSchema),
}).catchall(z.unknown());

/**
 * Schema for `accounts.snapshot` response.
 *
 * Matches `OperatorMethodOutputMap["accounts.snapshot"]`.
 */
export const AccountsSnapshotResponseSchema = z.object({
  capturedAt: z.number(),
  providers: z.array(ProviderSnapshotSchema),
  configuredCount: z.number(),
  issueCount: z.number(),
});

export type AccountsSnapshotResponse = z.infer<typeof AccountsSnapshotResponseSchema>;
